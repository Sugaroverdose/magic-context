import { loadPluginConfigDetailed } from "../../config";
import { isCompactionEnabled } from "../../config/agent-disable";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    getOrCreateSessionMeta,
    isDatabasePersisted,
    openDatabase,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { assertExecutableToolInput } from "../../hooks/magic-context/dropped-input-guard";
import {
    createChatMessageHook,
    createToolExecuteAfterHook,
} from "../../hooks/magic-context/hook-handlers";
import { resolveOpenCodeProtectedTailBoundary } from "../../hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { preloadTokenizer } from "../../hooks/magic-context/read-session-formatting";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import { maybeSendUpgradeReminder } from "../../hooks/magic-context/upgrade-reminder";
import { getDataDir } from "../../shared/data-path";
import { resolveHistorianModel } from "../../shared/model-resolution";
import { createV2HiddenCompletionExecutor } from "../hidden-completion";
import { pushNotification } from "../../shared/rpc-notifications";
import { v2CompactionMarkerStrategy } from "../fold/markers";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { deliverPendingChannel2, isAdmittedSynthetic } from "./channel2";
import { adaptPayload } from "./payload";
import { interruptBeforeProvider, V2ContextRefusal } from "./refusal";
import { rawMessages } from "./store";
import type { SessionContext, V2Context } from "./types";

export function createHostSeams(
    context: V2Context,
    read: TransformDeps["hostRawMessages"] & {},
    liveModels: NonNullable<TransformDeps["liveModelBySession"]>,
): Required<
    Pick<
        TransformDeps,
        "hostRawMessages" | "hostProtectedTailBoundary" | "hostModelFallback" | "hostRefuse"
    >
> {
    return {
        hostRawMessages: read,
        hostProtectedTailBoundary: (args) =>
            resolveOpenCodeProtectedTailBoundary({
                ...args,
                cacheNamespace: `opencode2:${args.sessionId}`,
            }),
        hostModelFallback: (sessionID) => liveModels.get(sessionID) ?? null,
        hostRefuse: (_client, sessionID) =>
            interruptBeforeProvider(context.session, sessionID as SessionContext["sessionID"]),
    };
}

export async function registerContext(context: V2Context): Promise<void> {
    const directory = context.location.directory;
    const config = loadPluginConfigDetailed(directory).config;
    if (!config.enabled || !isCompactionEnabled(config)) return;
    const limits = new Map<string, number>();
    const queriedModels = new Set<string>();
    const liveModels: NonNullable<TransformDeps["liveModelBySession"]> = new Map();
    const hiddenCompletionExecutor = context.session.generate
        ? await createV2HiddenCompletionExecutor(
              {
                  hook: (name, callback) => context.session.hook(name, callback),
                  generate: (input, options) => context.session.generate!(input, options),
              },
              (sessionID) => liveModels.get(sessionID) ?? null,
          )
        : undefined;
    const historianModels = resolveHistorianModel(config, "opencode");
    const usage: TransformDeps["contextUsageMap"] = new Map();
    const channel1: NonNullable<TransformDeps["channel1StateBySession"]> = new Map();
    const variants = new Map<string, string | undefined>();
    const agents = new Map<string, string>();
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    let passDuties: ReturnType<typeof createChatMessageHook> | undefined;
    let toolDuties: ReturnType<typeof createToolExecuteAfterHook> | undefined;
    await context.tool.hook("execute.before", (draft) => assertExecutableToolInput(draft.input));
    await context.tool.hook("execute.after", async (draft) => {
        if (!db || draft.status !== "completed") return;
        try {
            toolDuties ??= createToolExecuteAfterHook({ db, channel1StateBySession: channel1 });
            const content = draft.result?.content;
            const text =
                typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content
                            .filter((part) => part.type === "text")
                            .map((part) => part.text)
                            .join("\n")
                      : "";
            const output = { output: text };
            await toolDuties({ ...draft, args: draft.input }, output);
            if (draft.result && output.output !== text) {
                if (typeof content === "string") draft.result.content = output.output;
                else if (Array.isArray(content) && output.output.startsWith(text))
                    content.push({ type: "text", text: output.output.slice(text.length) });
            }
            const baseline = channel1.get(draft.sessionID);
            await deliverPendingChannel2(context, db, draft.sessionID, baseline);
        } catch (error) {
            console.warn("[magic-context] v2 Channel 2 delivery deferred", error);
        }
    });
    const read = (sessionID: string) => {
        const reader = new V2StoreReader(
            gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
        );
        try {
            return rawMessages(reader.window(sessionID));
        } finally {
            reader.close();
        }
    };
    const pagedRead = Object.assign(read, {
        readPage: (sessionID: string, after: number, limit: number, watermark: number) =>
            read(sessionID)
                .filter((m) => m.ordinal > after && m.ordinal <= watermark)
                .slice(0, limit),
        getCount: (sessionID: string) => read(sessionID).length,
    });
    let transform: ReturnType<typeof createTransform> | undefined;
    let db: ReturnType<typeof openDatabase> | undefined;
    const refuseIfUnsafe = async (draft: SessionContext): Promise<boolean> => {
        let unsafe = false;
        try {
            db ??= openDatabase();
            if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
            getOrCreateSessionMeta(db, draft.sessionID);
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const latest = reader
                    .window(draft.sessionID)
                    .filter((row) => row.type === "assistant")
                    .at(-1);
                const tokens = latest?.data.tokens;
                const modelKey = `${draft.model.providerID}/${draft.model.id}`;
                if (!queriedModels.has(modelKey)) {
                    const catalog = await context.catalog.model.list({
                        location: context.location,
                    });
                    for (const model of catalog.data)
                        limits.set(`${model.providerID}/${model.id}`, model.limit.context);
                    queriedModels.add(modelKey);
                }
                const limit = limits.get(modelKey);
                if (tokens && limit && Number.isFinite(limit) && limit > 0) {
                    const inputTokens = tokens.input + tokens.cache.read + tokens.cache.write;
                    unsafe = inputTokens / limit >= 0.95;
                    usage.set(draft.sessionID, {
                        usage: { inputTokens, percentage: (inputTokens / limit) * 100 },
                        hasUsageTokens: true,
                        updatedAt: Date.now(),
                    });
                }
            } finally {
                reader.close();
            }
        } catch {
            unsafe = true;
        }
        if (unsafe) await interruptBeforeProvider(context.session, draft.sessionID);
        return unsafe;
    };
    // Auto-compaction is dispatched before the primary context hook. Guard its
    // provider request too until a fold owner can supply a materialized summary.
    await context.session.hook("compaction", async (draft) => {
        try {
            await refuseIfUnsafe(draft);
        } catch (error) {
            if (error instanceof V2ContextRefusal) throw error;
            console.warn("[magic-context] v2 compaction guard unavailable", error);
        }
    });
    await context.session.hook("context", async (draft) => {
        let release: (() => void) | undefined;
        try {
            if (await refuseIfUnsafe(draft)) return;
            if (!db) return;
            const storage = db;
            await preloadTokenizer();
            passDuties ??= createChatMessageHook({
                db,
                liveModelBySession: liveModels,
                variantBySession: variants,
                agentBySession: agents,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                systemPromptRefreshSessions: new Set(),
                cacheTtlConfig: config.cache_ttl,
                upgradeReminder: (sessionID) =>
                    maybeSendUpgradeReminder(
                        {
                            db: storage,
                            client: undefined,
                            getNotificationParams: () => ({}),
                            sendStatusNotification: async (_client, id, text) => {
                                pushNotification("toast", { message: text, variant: "info" }, id);
                                return "queued";
                            },
                        },
                        sessionID,
                    ),
            });
            await passDuties({
                sessionID: draft.sessionID,
                agent: draft.agent,
                variant: draft.model.variant,
                model: { providerID: draft.model.providerID, modelID: draft.model.id },
            });
            release = setRawMessageProvider(draft.sessionID, {
                readMessages: () => read(draft.sessionID),
            });
            transform ??= createTransform({
                db,
                tagger: createTagger(),
                scheduler: createScheduler({
                    executeThresholdPercentage: config.execute_threshold_percentage,
                }),
                contextUsageMap: usage,
                liveModelBySession: liveModels,
                channel1StateBySession: channel1,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                variantBySession: variants,
                clearReasoningAge: config.clear_reasoning_age,
                directory,
                projectPath: directory,
                hiddenCompletionExecutor,
                historianRunnable:
                    hiddenCompletionExecutor !== undefined && config.historian?.disable !== true,
                historianModel: historianModels.primary,
                fallbackModels: historianModels.fallbacks,
                historianTimeoutMs: config.historian_timeout_ms,
                historianMaxOutputTokens: config.historian?.maxTokens,
                historianTwoPass: config.historian?.two_pass,
                compactionMarkerStrategy: v2CompactionMarkerStrategy,
                memoryConfig: {
                    enabled: config.memory.enabled,
                    injectionBudgetTokens: config.memory.injection_budget_tokens,
                    autoPromote: config.memory.auto_promote,
                },
                ...createHostSeams(context, pagedRead, liveModels),
            });
            const admitted = new Set<string>();
            for (const message of draft.messages) {
                if (message.id && (await isAdmittedSynthetic(context, draft.sessionID, message.id)))
                    admitted.add(message.id);
            }
            const mapped = adaptPayload(draft, admitted);
            await transform({}, mapped);
            mapped.commit();
        } catch (error) {
            if (error instanceof V2ContextRefusal) throw error;
            // Another plugin can poison the shared draft. Do not fail an otherwise viable turn.
            console.warn("[magic-context] v2 context unavailable", error);
        } finally {
            release?.();
        }
    });
}
