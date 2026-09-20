import { loadPluginConfigDetailed } from "../../config";
import { isCompactionEnabled } from "../../config/agent-disable";
import { getProtectedTokensTierOverrides } from "../../config/project-security";
import { summarizeManualDream } from "../../features/magic-context/dreamer/manual-summary";
import { isFailClosedBlockingError } from "../../features/magic-context/fail-closed-block";
import { resolveProjectIdentity } from "../../features/magic-context/memory/project-identity";
import { detectOverflow } from "../../features/magic-context/overflow-detection";
import { createScheduler } from "../../features/magic-context/scheduler";
import {
    clearSession,
    getOrCreateSessionMeta,
    isDatabasePersisted,
    markSessionCleanupPending,
    openDatabase,
    recordDetectedContextLimit,
    recordOverflowDetected,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { assertExecutableToolInput } from "../../hooks/magic-context/dropped-input-guard";
import { EmergencyFailClosedError } from "../../hooks/magic-context/emergency-fail-closed";
import { resolveContextLimit } from "../../hooks/magic-context/event-resolvers";
import {
    createChatMessageHook,
    createToolExecuteAfterHook,
} from "../../hooks/magic-context/hook-handlers";
import { materializeM0 } from "../../hooks/magic-context/inject-compartments";
import { resolveOpenCodeProtectedTailBoundary } from "../../hooks/magic-context/protected-tail-boundary";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { preloadTokenizer } from "../../hooks/magic-context/read-session-formatting";
import { createSystemPromptHashHandler } from "../../hooks/magic-context/system-prompt-hash";
import { createTransform, type TransformDeps } from "../../hooks/magic-context/transform";
import { registerRpcHandlers } from "../../plugin/rpc-handlers";
import { detectConflicts } from "../../shared/conflict-detector";
import { getDataDir, getMagicContextStorageDir } from "../../shared/data-path";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import { resolveHistorianModel } from "../../shared/model-resolution";
import {
    isSaneLimit,
    refreshModelLimitsFromApi,
    resolveLimit,
    setOutputReserveConfig,
} from "../../shared/models-dev-cache";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import {
    ACTIVE_TOOL_IDS,
    createPromptSurfaceRuntime,
    type PromptSurfaceRuntime,
} from "../../shared/prompt-surface-runtime";
import { pushNotification } from "../../shared/rpc-notifications";
import { MagicContextRpcServer } from "../../shared/rpc-server";
import { v2CompactionMarkerStrategy } from "../fold/markers";
import { FoldOwner, foldDigest } from "../fold/owner";
import { restoreRow } from "../fold/restore";
import { createV2HiddenCompletionExecutor } from "../hidden-completion";
import { removeHostSession } from "../host-service";
import { gaDatabasePath, V2StoreReader } from "../store-reader";
import { deliverPendingChannel2, isAdmittedSynthetic } from "./channel2";
import { DeletedSessionTombstones } from "./deleted-session-tombstones";
import { resolveManualDreamTask, runManualDreamNow } from "./dream-manual";
import { startDreamTrigger } from "./dream-trigger";
import { HiddenChildHook, registerHiddenChildAgents } from "./hidden-child";
import { modelLimitCacheWarm, warmModelLimitCacheFromCatalog } from "./model-limit-cache";
import { adaptPayload, HEAD_IDS } from "./payload";
import { interruptBeforeProvider, V2ContextRefusal } from "./refusal";
import { createV2RpcLiveSessionState } from "./rpc-live-state";
import { rawMessages } from "./store";
import { registerTools } from "./tools";
import type { SessionContext, V2Context } from "./types";
import { resolveUsageReading } from "./usage-reading";

export function isBlockingV2TransformError(error: unknown): boolean {
    return error instanceof EmergencyFailClosedError || isFailClosedBlockingError(error);
}

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
        // Draft-backed: v2 never reconstructs the live model from message.updated.
        hostModelFallback: (sessionID) => liveModels.get(sessionID) ?? null,
        hostRefuse: (_client, sessionID) =>
            interruptBeforeProvider(context.session, sessionID as SessionContext["sessionID"]),
    };
}

function toolResultText(result: { content?: unknown } | undefined): string {
    const content = result?.content ?? (result as { output?: unknown } | undefined)?.output;
    if (typeof content === "string") return content;
    if (content && typeof content === "object" && !Array.isArray(content)) {
        const record = content as { text?: unknown; value?: unknown };
        if (typeof record.text === "string") return record.text;
        if (typeof record.value === "string") return record.value;
        return "";
    }
    if (!Array.isArray(content)) return "";
    return content
        .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const record = part as { type?: unknown; text?: unknown; value?: unknown };
            if (typeof record.text === "string") return record.text;
            if (typeof record.value === "string") return record.value;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

/** Accept both a raw model array and the 2.0.5 `{ data }` list payload. */
export function catalogModels(listed: unknown): Array<{
    id: string;
    providerID: string;
    limit: { context: number; input?: number; output?: number };
}> {
    const rows = Array.isArray(listed)
        ? listed
        : listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)
          ? (listed as { data: unknown[] }).data
          : [];
    return rows.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const model = row as {
            id?: unknown;
            providerID?: unknown;
            limit?: { context?: unknown; input?: number; output?: number };
        };
        if (typeof model.id !== "string" || typeof model.providerID !== "string") return [];
        const contextLimit = model.limit?.context;
        if (typeof contextLimit !== "number" || !Number.isFinite(contextLimit)) return [];
        return [
            {
                id: model.id,
                providerID: model.providerID,
                limit: { ...model.limit, context: contextLimit },
            },
        ];
    });
}

/** Rewrite Magic Context ctx_* tool descriptions for this draft's model. */
export function applyV2PromptSurfaceTools(
    draft: SessionContext,
    runtime: PromptSurfaceRuntime,
    config: PromptSurfaceConfig | undefined,
): void {
    if (!draft.tools) return;
    const modelKey = `${draft.model.providerID}/${draft.model.id}`;
    const registration = runtime.resolveRegistration(config, modelKey);
    for (const id of ACTIVE_TOOL_IDS) {
        const tool = draft.tools[id];
        if (!tool) continue;
        tool.description = registration.descriptionFor(id, tool.description);
    }
}

export async function registerContext(context: V2Context) {
    const directory = context.location.directory;
    const config = loadPluginConfigDetailed(directory).config;
    if (!config.enabled) return;
    const compactionOff = !isCompactionEnabled(config);
    const conflicts = detectConflicts(directory, {
        compactionEnabled: !compactionOff,
        hostGeneration: "v2",
    });
    if (conflicts.hasConflict) {
        console.warn(
            `[magic-context] v2 setup disabled by conflicting context hooks: ${conflicts.reasons.join("; ")}`,
        );
        return;
    }
    const folds = new FoldOwner(context.storage);
    setOutputReserveConfig(config.output_reserve);
    const queriedModels = new Set<string>();
    const rawLimits = new Map<string, { context: number; input?: number; output?: number }>();
    // Draft-authoritative model/variant/agent. Not the v1 event-driven map.
    const liveModels: NonNullable<TransformDeps["liveModelBySession"]> = new Map();
    const promptSurfaceRuntime = createPromptSurfaceRuntime({
        harness: "opencode2",
        directory,
        warn: (message) => console.warn(`[magic-context] config warning: ${message}`),
    });
    let db: ReturnType<typeof openDatabase> | undefined;
    try {
        db = openDatabase() ?? undefined;
    } catch {
        // The primary context hook retains the existing fail-closed storage path.
        // Hidden work remains unavailable for this plugin instance when durable storage cannot open.
    }
    const tools =
        db && isDatabasePersisted(db) ? await registerTools(context, db, config) : undefined;
    await context.session.hook("http.response", async (draft) => {
        if (!db || draft.kind !== "primary" || draft.response.ok) return;
        const detection = detectOverflow(await draft.response.clone().text());
        if (!detection.isOverflow) return;
        const modelKey = `${draft.model.providerID}/${draft.model.id}`;
        if (compactionOff) {
            if (detection.reportedLimit)
                recordDetectedContextLimit(
                    db,
                    draft.sessionID,
                    detection.reportedLimit,
                    modelKey,
                    detection.reportedLimitProvenance,
                );
        } else {
            recordOverflowDetected(
                db,
                draft.sessionID,
                detection.reportedLimit,
                modelKey,
                "provider_overflow",
                detection.reportedLimitProvenance,
            );
        }
    });
    const hiddenChildHook = new HiddenChildHook();
    await registerHiddenChildAgents(context.agent);
    let hiddenAgentsReady: Promise<void> | undefined;
    const hiddenCompletionExecutor =
        db && isDatabasePersisted(db)
            ? await createV2HiddenCompletionExecutor(
                  {
                      ...context.session,
                      // The injected session surface stops short of deletion, so retiring a hidden
                      // child reaches the host's delete route directly.
                      remove: (input: { sessionID: string }) => removeHostSession(input.sessionID),
                  },
                  {
                      db,
                      projectIdentity: resolveProjectIdentity(directory) ?? directory,
                      hook: hiddenChildHook,
                      ensureAgent: () => (hiddenAgentsReady ??= context.agent.reload()),
                      openReader: () =>
                          new V2StoreReader(
                              gaDatabasePath(
                                  getDataDir(),
                                  process.env.OPENCODE_CHANNEL ?? "latest",
                              ),
                          ),
                  },
              )
            : undefined;
    const dreamTrigger =
        hiddenCompletionExecutor && config.dreamer && !config.dreamer.disable
            ? startDreamTrigger(context, {
                  config: config.dreamer,
                  executor: hiddenCompletionExecutor,
                  projectIdentity: () => resolveProjectIdentity(directory) ?? directory,
                  language: config.language,
                  mural: config.mural,
              })
            : undefined;
    const historianModels = resolveHistorianModel(config, "opencode");
    const usage: TransformDeps["contextUsageMap"] = new Map();
    const channel1: NonNullable<TransformDeps["channel1StateBySession"]> = new Map();
    const variants = new Map<string, string | undefined>();
    const agents = new Map<string, string>();
    const historyRefreshSessions = new Set<string>();
    const pendingMaterializationSessions = new Set<string>();
    const lastHeuristicsTurnId = new Map<string, string>();
    const rawProviders = new Map<string, () => void>();
    let passDuties: ReturnType<typeof createChatMessageHook> | undefined;
    let toolDuties: ReturnType<typeof createToolExecuteAfterHook> | undefined;
    await context.tool.hook("execute.before", (draft) => assertExecutableToolInput(draft.input));
    await context.tool.hook("execute.after", async (draft) => {
        if (!db) return;
        if (draft.status && draft.status !== "completed") return;
        try {
            toolDuties ??= createToolExecuteAfterHook({ db, channel1StateBySession: channel1 });
            const text = toolResultText(draft.result);
            const output = { output: text };
            await toolDuties({ ...draft, args: draft.input }, output);
            if (draft.result && output.output !== text) {
                const content = draft.result.content;
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
            return rawMessages(reader.history(sessionID));
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
    let systemPrompt: ReturnType<typeof createSystemPromptHashHandler> | undefined;
    const systemPromptRefreshSessions = new Set<string>();
    const tagger = createTagger();
    const deletedSessions = new DeletedSessionTombstones();
    const recordUsage = async (
        draft: Pick<SessionContext, "sessionID" | "model">,
    ): Promise<boolean> => {
        let unsafe = false;
        try {
            db ??= openDatabase();
            if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
            getOrCreateSessionMeta(db, draft.sessionID);
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const latest = reader.latestAssistant(draft.sessionID);
                const latestCompaction = reader.latestCompaction(draft.sessionID);
                const draftModelKey = `${draft.model.providerID}/${draft.model.id}`;
                if (!queriedModels.has(draftModelKey)) {
                    const catalog = await Promise.resolve(context.model.list());
                    const providers = new Map<
                        string,
                        {
                            id: string;
                            models: Record<
                                string,
                                { limit: { context: number; input?: number; output?: number } }
                            >;
                        }
                    >();
                    for (const model of catalogModels(catalog)) {
                        rawLimits.set(`${model.providerID}/${model.id}`, model.limit);
                        const provider = providers.get(model.providerID) ?? {
                            id: model.providerID,
                            models: {},
                        };
                        provider.models[model.id] = { limit: model.limit };
                        providers.set(model.providerID, provider);
                    }
                    await refreshModelLimitsFromApi({
                        config: {
                            providers: async () => ({
                                data: { providers: [...providers.values()] },
                            }),
                        },
                    });
                    queriedModels.add(draftModelKey);
                }
                const usageDb = db;
                const limitFor = (providerID: string, modelID: string) => {
                    const modelKey = `${providerID}/${modelID}`;
                    const rawLimit = rawLimits.get(modelKey);
                    // The shared catalog rejects unusually small limits, but a
                    // provider may explicitly configure a valid small context window.
                    return rawLimit && !isSaneLimit(rawLimit.context)
                        ? (resolveLimit(rawLimit, providerID, modelID) ?? 0)
                        : resolveContextLimit(providerID, modelID, {
                              db: usageDb,
                              sessionID: draft.sessionID,
                          });
                };
                const reading = resolveUsageReading({
                    rowModel: latest?.data.model,
                    draftModel: { providerID: draft.model.providerID, id: draft.model.id },
                    tokens: latest?.data.tokens,
                    completed: latest?.data.time?.completed,
                    limitFor,
                });
                if (reading) {
                    // The provider's raw 95% wall always refuses. Below that wall,
                    // use the outgoing model's output-reserved admission limit; a newer
                    // host compaction may cross that tighter limit and still be sent once
                    // so its reduced input-token usage can be measured.
                    const rawContextLimit = rawLimits.get(draftModelKey)?.context;
                    const providerHardPressure =
                        typeof rawContextLimit === "number" &&
                        Number.isFinite(rawContextLimit) &&
                        rawContextLimit > 0 &&
                        reading.inputTokens / rawContextLimit >= 0.95;
                    const hostCompactionReducedUsage =
                        latestCompaction !== undefined &&
                        latest !== undefined &&
                        latestCompaction.seq >= latest.seq;
                    unsafe =
                        providerHardPressure ||
                        (!hostCompactionReducedUsage &&
                            rawContextLimit !== undefined &&
                            reading.inputTokens / reading.admissionLimit >= 0.95);
                    if (reading.completed !== undefined)
                        updateSessionMeta(usageDb, draft.sessionID, {
                            lastResponseTime: reading.completed,
                        });
                    const percentage = (reading.inputTokens / reading.limit) * 100;
                    updateSessionMeta(usageDb, draft.sessionID, {
                        lastContextPercentage: percentage,
                        lastInputTokens: reading.inputTokens,
                        lastUsageContextLimit: reading.limit,
                        lastObservedModelKey: reading.modelKey ?? draftModelKey,
                    });
                    sessionLog(
                        draft.sessionID,
                        `v2 usage: inputTokens=${reading.inputTokens} contextLimit=${reading.limit} percentage=${percentage}`,
                    );
                    usage.set(draft.sessionID, {
                        usage: { inputTokens: reading.inputTokens, percentage },
                        hasUsageTokens: true,
                        updatedAt: Date.now(),
                    });
                }
            } finally {
                reader.close();
            }
        } catch (error) {
            console.warn("[magic-context] v2 refuseIfUnsafe", error);
            unsafe = true;
        }
        return unsafe;
    };
    // Context runs before generation. Persist terminal usage at execution completion
    // so pressure is visible even when the user has not started another turn.
    const usageController = new AbortController();
    const usageDone = (async () => {
        try {
            for await (const value of context.event.subscribe({ signal: usageController.signal })) {
                if (usageController.signal.aborted) break;
                const event = value as { type?: string; data?: { sessionID?: string } };
                if (!event.data?.sessionID) continue;
                const sessionID = event.data.sessionID;
                if (event.type === "session.deleted") {
                    deletedSessions.add(sessionID);
                    if (db) {
                        markSessionCleanupPending(db, sessionID);
                        clearSession(db, sessionID);
                    }
                    rawProviders.get(sessionID)?.();
                    rawProviders.delete(sessionID);
                    usage.delete(sessionID);
                    liveModels.delete(sessionID);
                    variants.delete(sessionID);
                    agents.delete(sessionID);
                    channel1.delete(sessionID);
                    historyRefreshSessions.delete(sessionID);
                    pendingMaterializationSessions.delete(sessionID);
                    lastHeuristicsTurnId.delete(sessionID);
                    systemPromptRefreshSessions.delete(sessionID);
                    systemPrompt?.clearSession(sessionID);
                    tagger.cleanup(sessionID);
                    continue;
                }
                if (event.type !== "session.execution.succeeded") continue;
                const model = liveModels.get(sessionID);
                if (model)
                    await recordUsage({
                        sessionID,
                        model: { providerID: model.providerID, id: model.modelID },
                    });
            }
        } catch (error) {
            if (!usageController.signal.aborted)
                console.warn("[magic-context] v2 usage subscription failed", error);
        }
    })();
    const materialize = (draft: SessionContext) => {
        db ??= openDatabase();
        if (!db || !isDatabasePersisted(db)) throw new Error("context storage is not durable");
        const state = getOrCreateSessionMeta(db, draft.sessionID);
        return materializeM0({
            db,
            sessionId: draft.sessionID,
            state,
            projectPath: resolveProjectIdentity(directory) ?? directory,
            projectDirectory: directory,
            memoryEnabled: config.memory.enabled,
            memoryInjectionBudgetTokens: config.memory.injection_budget_tokens,
            hardSignals: {
                systemHash: foldDigest(JSON.stringify(draft.system)),
                toolSetHash: "",
                modelKey: `${draft.model.providerID}/${draft.model.id}`,
                // materializeM0 does not read cacheExpired. mustMaterialize owns
                // expiry decisions on the transform path; this fold always renders
                // fresh bytes and keys its markers from the system and model hashes.
                cacheExpired: false,
                lastResponseTime: state.lastResponseTime,
            },
        }).m0Text;
    };
    if (!compactionOff)
        await context.session.hook("compaction", async (draft) => {
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            try {
                const rows = reader.history(draft.sessionID);
                const ids = new Set(draft.messages.map((message) => message.id));
                const watermark = Math.max(
                    -1,
                    ...rows.filter((row) => ids.has(row.id)).map((row) => row.seq),
                );
                const running = rows
                    .filter((row) => row.type === "compaction" && row.data.status === "running")
                    .at(-1);
                const fold = await folds.supply({
                    sessionID: draft.sessionID,
                    watermark,
                    runningCut: running?.seq,
                    materialize: () => materialize(draft),
                });
                draft.result = { summary: fold.submitted };
            } catch (cause) {
                await interruptBeforeProvider(context.session, draft.sessionID);
                throw new V2ContextRefusal(
                    "Magic Context could not preserve the host checkpoint.",
                    {
                        cause,
                    },
                );
            } finally {
                reader.close();
            }
        });
    await context.session.hook("context", async (draft) => {
        if (hiddenChildHook.apply(draft)) return;
        // A deletion that races an in-flight pass must not let that pass rebuild
        // the state just cleared by the one deletion event.
        if (deletedSessions.has(draft.sessionID)) return;
        liveModels.set(draft.sessionID, {
            providerID: draft.model.providerID,
            modelID: draft.model.id,
        });
        variants.set(draft.sessionID, draft.model.variant);
        if (!modelLimitCacheWarm()) void warmModelLimitCacheFromCatalog(context);
        agents.set(draft.sessionID, draft.agent);
        applyV2PromptSurfaceTools(draft, promptSurfaceRuntime, config.prompt_surface);
        if (context.tool.transform) {
            const modelKey = `${draft.model.providerID}/${draft.model.id}`;
            const registration = promptSurfaceRuntime.resolveRegistration(
                config.prompt_surface,
                modelKey,
            );
            await context.tool.transform((editor) => {
                for (const id of ACTIVE_TOOL_IDS) {
                    editor.update(id, (tool) => {
                        tool.description = registration.descriptionFor(id, tool.description);
                    });
                }
            });
        }
        let postFold = false;
        try {
            if ((await recordUsage(draft)) && !compactionOff) {
                await interruptBeforeProvider(context.session, draft.sessionID);
                return;
            }
            if (!db) return;
            systemPrompt ??= createSystemPromptHashHandler({
                db,
                dreamerEnabled: config.dreamer !== undefined && !config.dreamer.disable,
                memoryEnabled: config.memory.enabled,
                language: config.language,
                promptSurface: config.prompt_surface,
                promptSurfaceRuntime,
                systemPromptRefreshSessions,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                injectionEnabled: config.system_prompt_injection.enabled,
                injectionSkipSignatures: config.system_prompt_injection.skip_signatures,
            });
            const system = { system: draft.system.map((part) => String(part.text ?? "")) };
            await systemPrompt.handler(
                {
                    sessionID: draft.sessionID,
                    model: { providerID: draft.model.providerID, modelID: draft.model.id },
                },
                system,
            );
            const originals = [...draft.system];
            draft.system.splice(
                0,
                draft.system.length,
                ...system.system.map((text, index) => ({
                    ...originals[index],
                    type: "text",
                    text,
                })),
            );
            await preloadTokenizer();
            passDuties ??= createChatMessageHook({
                db,
                liveModelBySession: liveModels,
                variantBySession: variants,
                agentBySession: agents,
                historyRefreshSessions,
                pendingMaterializationSessions,
                lastHeuristicsTurnId,
                systemPromptRefreshSessions,
                cacheTtlConfig: config.cache_ttl,
            });
            await passDuties({
                sessionID: draft.sessionID,
                agent: draft.agent,
                variant: draft.model.variant,
                model: { providerID: draft.model.providerID, modelID: draft.model.id },
            });
            // Background historian reads outlive the context callback. Keep its source
            // registered until plugin disposal, rather than falling back to the v1 store.
            if (!rawProviders.has(draft.sessionID))
                rawProviders.set(
                    draft.sessionID,
                    setRawMessageProvider(draft.sessionID, {
                        readMessages: () => read(draft.sessionID),
                    }),
                );
            transform ??= createTransform({
                db,
                tagger,
                scheduler: createScheduler({
                    executeThresholdPercentage: config.execute_threshold_percentage,
                }),
                contextUsageMap: usage,
                compactionOff,
                // GA owns its native checkpoints; this adapter never writes the v1
                // synthetic marker rows that the shared off-transition deletes.
                hostCleanupCompactionMarkers: () => ({
                    verified: true,
                    removedLineages: 0,
                    removedRows: 0,
                    retainedLineages: 0,
                }),
                protectedTokens: config.protected_tokens,
                protectedTokenTierOverrides: getProtectedTokensTierOverrides(config),
                executeThresholdPercentage: config.execute_threshold_percentage,
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
                    !compactionOff &&
                    hiddenCompletionExecutor !== undefined &&
                    config.historian?.disable !== true,
                historianModel: historianModels.primary,
                fallbackModels: historianModels.fallbacks,
                historianTimeoutMs: config.historian_timeout_ms,
                // Raw config on purpose: absent means the user configured no
                // output cap, and the hidden carrier only puts a cap on the wire
                // when one was configured. The producer-window arithmetic applies
                // its own default, so no fallback belongs here.
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
            const reader = new V2StoreReader(
                gaDatabasePath(getDataDir(), process.env.OPENCODE_CHANNEL ?? "latest"),
            );
            let checkpoint: SessionContext["messages"][number] | undefined;
            let submitted: string | undefined;
            try {
                const cut = reader.latestCompaction(draft.sessionID);
                const incoming = cut && draft.messages.find((message) => message.id === cut.id);
                postFold = cut !== undefined;
                if (cut && !incoming)
                    throw new Error("The host checkpoint disappeared from the context draft");
                if (cut && incoming) {
                    const identity = await folds.observe({
                        sessionID: draft.sessionID,
                        cutSeq: cut.seq,
                        summary: cut.data.summary ?? "",
                        rendered: incoming,
                        onHard: (reason) => {
                            console.warn(
                                `[magic-context] HARD reason=${reason} session=${draft.sessionID}`,
                            );
                            materialize(draft);
                            pendingMaterializationSessions.add(draft.sessionID);
                        },
                    });
                    checkpoint = structuredClone(identity.rendered ?? incoming);
                    submitted = identity.rendered
                        ? (identity.renderedSummary ?? identity.submitted)
                        : (cut.data.summary ?? "");
                    const all = reader.history(draft.sessionID);
                    const boundaryID = (
                        db
                            .prepare(
                                "SELECT cached_m0_last_baseline_end_message_id AS id FROM session_meta WHERE session_id = ?",
                            )
                            .get(draft.sessionID) as { id: string | null } | null
                    )?.id;
                    const boundary = all.find((row) => row.id === boundaryID)?.seq ?? -1;
                    const present = new Set(draft.messages.map((message) => message.id));
                    const restored = all
                        .filter(
                            (row) =>
                                row.seq > boundary && row.seq <= cut.seq && !present.has(row.id),
                        )
                        .flatMap((row) => restoreRow(row, draft.model));
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        ...restored,
                        ...draft.messages.filter((message) => message !== incoming),
                    );
                }
            } finally {
                reader.close();
            }
            const mapped = adaptPayload(draft, admitted);
            await transform({}, mapped);
            mapped.commit();
            if (db) {
                await deliverPendingChannel2(
                    context,
                    db,
                    draft.sessionID,
                    channel1.get(draft.sessionID),
                );
            }
            if (checkpoint && submitted !== undefined) {
                const head = draft.messages.find((message) => message.id === HEAD_IDS[0]);
                const baseline = head?.content.find((part) => part.type === "text")?.text;
                if (typeof baseline === "string") {
                    for (const part of checkpoint.content)
                        if (part.type === "text" && typeof part.text === "string") {
                            part.text = part.text.replace(
                                `<summary>\n${submitted}\n</summary>`,
                                `<summary>\n${baseline}\n</summary>`,
                            );
                        }
                    const volatile = draft.messages.find((message) => message.id === HEAD_IDS[1]);
                    if (volatile && head)
                        volatile.content.push(
                            ...head.content.filter((part) => part.type !== "text"),
                        );
                    draft.messages.splice(
                        0,
                        draft.messages.length,
                        checkpoint,
                        ...draft.messages.filter((message) => message !== head),
                    );
                }
            }
        } catch (error) {
            if (error instanceof V2ContextRefusal) throw error;
            if (isBlockingV2TransformError(error)) {
                // These errors mean the shared transform cannot prove a safe prompt.
                // Native compaction owns recovery when Magic Context compaction is off.
                if (!compactionOff) {
                    await interruptBeforeProvider(context.session, draft.sessionID);
                    throw new V2ContextRefusal("Magic Context refused to send an unsafe prompt.", {
                        cause: error,
                    });
                }
                console.warn(
                    "[magic-context] compaction-off: fail-closed inert, passing through",
                    error,
                );
            } else if (postFold) {
                await interruptBeforeProvider(context.session, draft.sessionID);
                throw new V2ContextRefusal(
                    "Magic Context could not restore the unarchived host history.",
                    { cause: error },
                );
            } else {
                // Another plugin can poison the shared draft. Do not fail an otherwise viable turn.
                console.warn("[magic-context] v2 context unavailable", error);
            }
        }
    });
    // Warm eagerly for cold sidebar/status reads; a failed startup warm releases
    // its latch and the context hook above retries after the host catalog settles.
    void warmModelLimitCacheFromCatalog(context);
    // OpenCode 2 never runs the v1 server() lane. Start the RPC surface here so
    // the terminal TUI can read the v2 lane's draft-authoritative session state.
    const rpcLiveSessionState = createV2RpcLiveSessionState({
        liveModelBySession: liveModels,
        variantBySession: variants,
        agentBySession: agents,
        channel1StateBySession: channel1,
        historyRefreshSessions,
        pendingMaterializationSessions,
        systemPromptRefreshSessions,
    });
    const storageDir = getMagicContextStorageDir();
    const rpcServer = new MagicContextRpcServer(storageDir, directory);
    let rpcStopped = false;
    registerRpcHandlers(rpcServer, {
        directory,
        config,
        client: undefined,
        liveSessionState: rpcLiveSessionState,
        rustModeModuleClient: undefined,
        hiddenCompletionExecutor,
        storageDir,
    });
    // The v2 TUI reaches manual dreaming through RPC because this host has no
    // command-template path. The run continues in the background and reports its
    // result through the notification socket.
    const manualDreamer =
        config.dreamer && config.dreamer.disable !== true ? config.dreamer : undefined;
    rpcServer.handle("dream", async (params) => {
        const sessionId = String(params.sessionId ?? "");
        if (!sessionId) return { ok: false, error: "no session" };
        if (!manualDreamer || !hiddenCompletionExecutor) {
            pushNotification(
                "toast",
                { message: "Dreaming is not configured for this project.", variant: "warning" },
                sessionId,
            );
            return { ok: false, error: "dreamer unavailable" };
        }
        const requested = resolveManualDreamTask(params.task);
        if (requested.error) {
            pushNotification("toast", { message: requested.error, variant: "warning" }, sessionId);
            return { ok: false, error: requested.error };
        }
        db ??= openDatabase();
        if (!db || !isDatabasePersisted(db)) {
            pushNotification(
                "toast",
                {
                    message: "Dreaming is unavailable: context storage is not durable.",
                    variant: "error",
                },
                sessionId,
            );
            return { ok: false, error: "storage unavailable" };
        }
        const runDb = db;
        const runExecutor = hiddenCompletionExecutor;
        void runManualDreamNow({
            db: runDb,
            dreamer: manualDreamer,
            projectIdentity: resolveProjectIdentity(directory) ?? directory,
            directory,
            language: config.language,
            mural: config.mural,
            executor: runExecutor,
            sessionId,
            ...(requested.task !== undefined ? { task: requested.task } : {}),
        })
            .then(({ summary, unsupportedTasks }) => {
                // When an explicitly requested task is unsupported, omit the
                // otherwise misleading "No enabled dream tasks" empty summary.
                const hasSummaryContent =
                    summary.ran.length > 0 ||
                    summary.failed.length > 0 ||
                    summary.skippedNoWork.length > 0 ||
                    summary.deferredBusy.length > 0 ||
                    Object.keys(summary.backlogBefore ?? {}).length > 0 ||
                    Object.keys(summary.backlogAfter ?? {}).length > 0;
                const message = [
                    hasSummaryContent || unsupportedTasks.length === 0
                        ? summarizeManualDream(summary)
                        : undefined,
                    unsupportedTasks.length > 0
                        ? `Unsupported on this host (no tool loop): ${unsupportedTasks.join(", ")}`
                        : undefined,
                ]
                    .filter((line) => line !== undefined)
                    .join("\n\n");
                pushNotification(
                    "action",
                    {
                        action: "show-result-dialog",
                        title: "Magic Context dream run",
                        message,
                    },
                    sessionId,
                );
            })
            .catch((error) => {
                pushNotification(
                    "toast",
                    { message: `Dream run failed: ${getErrorMessage(error)}`, variant: "error" },
                    sessionId,
                );
            });
        return { ok: true };
    });
    // Start the RPC server asynchronously after plugin construction returns so
    // Bun.serve and its discovery-file write do not consume the host's deadline.
    setTimeout(() => {
        if (rpcStopped) return;
        void rpcServer
            .start()
            .catch((error) => console.warn("[magic-context] v2 RPC server failed to start", error));
    }, 0);
    return {
        async dispose() {
            rpcStopped = true;
            rpcServer.stop();
            tools?.dispose();
            usageController.abort();
            await usageDone;
            deletedSessions.clear();
            await dreamTrigger?.dispose();
            for (const release of rawProviders.values()) release();
            rawProviders.clear();
        },
    };
}
