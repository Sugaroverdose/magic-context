import { existsSync } from "node:fs";

import { DREAMER_AGENT, DREAMER_RETROSPECTIVE_AGENT } from "../../../agents/dreamer";
import type { DreamingTask } from "../../../config/schema/magic-context";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { getCompartmentEvents } from "../compartment-events";
import { runKeyFilesTask } from "../key-files/identify-key-files";
import {
    getMemoriesByProject,
    getMemoryCountsByStatus,
    getMemoryVerifications,
    type Memory,
} from "../memory";
import { recordChildInvocation } from "../subagent-token-capture";
import { reviewUserMemories } from "../user-memory/review-user-memories";
import { getActiveUserMemories } from "../user-memory/storage-user-memory";
import { evaluateSmartNotes } from "./evaluate-smart-notes";
import { detectFrictionSignals, type FrictionSignal } from "./friction-signals";
import { renewLease } from "./lease";
import {
    enforceMaintainDocsProtectedRegions,
    snapshotMaintainDocsFiles,
} from "./maintain-docs-protected-enforcement";
import {
    checkMaintainMemoryCoverage,
    type MaintainMemoryGateResult,
    partitionMaintainMemoryScope,
} from "./maintain-memory-gate";
import {
    applyRetrospectiveLearnings,
    parseRetrospectiveLearnings,
} from "./retrospective-learnings";
import {
    type RetrospectiveRawMessage,
    type RetrospectiveRawProvider,
    readProjectRetrospectiveMessages,
} from "./retrospective-raw-provider";
import { type DreamRunMemoryChanges, insertDreamRun } from "./storage-dream-runs";
import { getTaskScheduleState } from "./storage-task-schedule";
import {
    buildDreamTaskPrompt,
    buildFrictionGatePrompt,
    buildRetrospectivePrompt,
    type ClassifyTrajectoryCompartment,
    DREAMER_SYSTEM_PROMPT,
    RETROSPECTIVE_SYSTEM_PROMPT,
    type RetrospectivePromptEvent,
} from "./task-prompts";
import { isAgenticTask } from "./task-registry";
import type { DreamTaskRuntimeConfig, TaskExecOutcome, TaskExecutor } from "./task-scheduler";

export interface DreamTaskExecutorDeps {
    client: PluginContext["client"];
    /** Filesystem directory of the project this drain owns (NOT the identity). */
    sessionDirectory: string;
    /** Opens the OpenCode DB read-only (for the key-files candidate scan). The
     *  dream-timer owns the path resolution; null when unavailable. */
    openOpenCodeDb: () => Database | null;
    retrospectiveRawProvider?:
        | RetrospectiveRawProvider
        | ((db: Database, projectIdentity: string) => RetrospectiveRawProvider | null);
    /** Host-side privacy gate for route="observation" learnings. */
    userMemoryCollectionEnabled?: boolean;
    /** Optional tiny friction classifier. Defaults to conservative no-hit. */
    frictionGateClassifier?: (args: {
        prompt: string;
        userLines: string[];
        config: DreamTaskRuntimeConfig;
    }) => Promise<{ hit: boolean; ordinals?: number[] }>;
}

/** A failed task either hot-retries (transient: provider/network/rate-limit/
 *  timeout/abort/lease/busy) or advances to the next cron slot (permanent:
 *  model-not-found, validation, parse). Classify off the error shape. */
function classifyFailure(error: unknown): { transient: boolean; brief: string } {
    const described = describeError(error);
    const brief = described.brief;
    const name = error instanceof Error ? error.name : "";
    const combined = `${name} ${brief}`.toLowerCase();
    const transient =
        name === "AbortError" ||
        /lease|timeout|timed out|econn|socket|network|rate.?limit|429|503|overloaded|sqlite_busy|database is locked/.test(
            combined,
        );
    return { transient, brief };
}

/** Ids present in `afterIds` but not in `beforeIds` (set difference). */
function newIds(beforeIds: number[], afterIds: number[]): number[] {
    const before = new Set(beforeIds);
    const out: number[] = [];
    for (const id of afterIds) if (!before.has(id)) out.push(id);
    return out;
}

function toPromptMemory(
    memory: Memory,
    verificationById: ReturnType<typeof getMemoryVerifications>,
): MaintainMemoryGateResult["inScope"][number] {
    const verification = verificationById.get(memory.id);
    return {
        id: memory.id,
        category: memory.category,
        content: memory.content,
        mappedFiles: verification?.files ?? [],
        verifiedAt: verification?.verifiedAt ?? null,
        hasNoFileSentinel: verification?.hasSentinel ?? false,
    };
}

function loadActiveMemoryPromptMemories(
    db: Database,
    projectIdentity: string,
): MaintainMemoryGateResult["inScope"] {
    const memories = getMemoriesByProject(db, projectIdentity);
    const verificationById = getMemoryVerifications(
        db,
        memories.map((memory) => memory.id),
    );
    return memories.map((memory) => toPromptMemory(memory, verificationById));
}

export const CLASSIFY_TRAJECTORY_COMPARTMENT_LIMIT = 30;

export function loadRecentTrajectoryCompartments(
    db: Database,
    projectIdentity: string,
    limit = CLASSIFY_TRAJECTORY_COMPARTMENT_LIMIT,
): ClassifyTrajectoryCompartment[] {
    const rows = db
        .prepare<[string, number], ClassifyTrajectoryCompartment>(
            `SELECT c.id AS id,
                    c.title AS title,
                    COALESCE(NULLIF(c.p1, ''), c.content) AS content,
                    c.created_at AS createdAt
               FROM compartments c
               JOIN session_projects sp ON sp.session_id = c.session_id
              WHERE sp.project_path = ?
              ORDER BY c.created_at DESC, c.id DESC
              LIMIT ?`,
        )
        .all(projectIdentity, Math.max(0, Math.floor(limit)));
    return rows.reverse();
}

/**
 * Build the TaskExecutor the v2 scheduler drives. The scheduler owns the keyed
 * domain lease + holderId and hands them in; this executor runs one task's actual
 * work (LLM loop / specialized runner), renews the lease during the run, aborts
 * if the lease is lost, and writes one per-task dream_runs telemetry row.
 */
export function createDreamTaskExecutor(deps: DreamTaskExecutorDeps): TaskExecutor {
    let parentSessionIdResolved = false;
    let parentSessionId: string | undefined;

    const resolveParentSessionId = async (): Promise<string | undefined> => {
        if (parentSessionIdResolved) return parentSessionId;
        parentSessionIdResolved = true;
        try {
            const listResponse = await deps.client.session.list({
                query: { directory: deps.sessionDirectory },
            });
            const sessions = shared.normalizeSDKResponse(listResponse, [] as { id?: string }[], {
                preferResponseOnMissingData: true,
            });
            parentSessionId = sessions?.find((s) => typeof s?.id === "string")?.id;
        } catch {
            parentSessionId = undefined;
        }
        return parentSessionId;
    };

    return async (
        config: DreamTaskRuntimeConfig,
        ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    ): Promise<TaskExecOutcome> => {
        const { db, projectIdentity, holderId, leaseKey } = ctx;
        const startedAt = Date.now();
        const deadline = startedAt + config.timeoutMinutes * 60 * 1000;
        const parent = await resolveParentSessionId();

        const recordRun = (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: ReturnType<typeof computeMemoryDelta>;
                smartNotesSurfaced?: number;
                smartNotesPending?: number;
            },
        ): void => {
            try {
                insertDreamRun(db, {
                    projectPath: projectIdentity,
                    startedAt,
                    finishedAt: Date.now(),
                    holderId,
                    tasks: [
                        {
                            name: config.task,
                            durationMs: Date.now() - startedAt,
                            resultChars: 0,
                            ...(error ? { error } : {}),
                        },
                    ],
                    tasksSucceeded: status === "completed" ? 1 : 0,
                    tasksFailed: status === "failed" ? 1 : 0,
                    smartNotesSurfaced: extra?.smartNotesSurfaced ?? 0,
                    smartNotesPending: extra?.smartNotesPending ?? 0,
                    memoryChanges: extra?.memoryChanges ?? null,
                    parentSessionId: parent ?? null,
                });
            } catch (e) {
                log(`[dreamer] failed to record dream_run for ${config.task}: ${e}`);
            }
        };

        function computeMemoryDelta(
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ): DreamRunMemoryChanges | null {
            const after = getMemoryCountsByStatus(db, projectIdentity);
            // Capture the exact changed ids (#221) — count === array length.
            const writtenIds = newIds(before.ids, after.ids);
            const deletedIds = newIds(after.ids, before.ids);
            const archivedIds = newIds(before.archivedIds, after.archivedIds);
            const mergedIds = newIds(before.mergedIds, after.mergedIds);
            const changes: DreamRunMemoryChanges = {
                written: writtenIds.length,
                deleted: deletedIds.length,
                archived: archivedIds.length,
                merged: mergedIds.length,
                writtenIds,
                deletedIds,
                archivedIds,
                mergedIds,
            };
            return writtenIds.length || deletedIds.length || archivedIds.length || mergedIds.length
                ? changes
                : null;
        }

        try {
            if (config.task === "review-user-memories") {
                const result = await reviewUserMemories({
                    db,
                    client: deps.client,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    promotionThreshold: config.promotionThreshold ?? 3,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                });
                recordRun("completed", null);
                log(
                    `[dreamer] review-user-memories: promoted=${result.promoted} merged=${result.merged} dismissed=${result.dismissed}`,
                );
                return { status: "completed" };
            }

            if (config.task === "evaluate-smart-notes") {
                const result = await evaluateSmartNotes({
                    db,
                    client: deps.client,
                    projectIdentity,
                    parentSessionId: parent,
                    sessionDirectory: deps.sessionDirectory,
                    holderId,
                    leaseKey,
                    deadline,
                    model: config.model,
                    fallbackModels: config.fallbackModels,
                });
                recordRun("completed", null, {
                    smartNotesSurfaced: result.surfaced,
                    smartNotesPending: result.pending,
                });
                return { status: "completed" };
            }

            if (config.task === "retrospective") {
                const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);
                await runRetrospectiveTask(config, ctx, {
                    deps,
                    deadline,
                    parent,
                    invocationStartedAt: startedAt,
                });
                recordRun("completed", null, {
                    memoryChanges: computeMemoryDelta(memoryBefore),
                });
                return { status: "completed" };
            }

            if (config.task === "key-files") {
                const openCodeDb = deps.openOpenCodeDb();
                if (!openCodeDb) {
                    recordRun("completed", null);
                    return { status: "completed" }; // nothing to do without the OpenCode DB
                }
                try {
                    await runKeyFilesTask({
                        db,
                        openCodeDb,
                        client: deps.client,
                        projectPath: deps.sessionDirectory,
                        config: {
                            enabled: true,
                            token_budget: config.tokenBudget ?? 10000,
                            min_reads: config.minReads ?? 4,
                        },
                        holderId,
                        leaseKey,
                        deadline,
                        parentSessionId: parent,
                        model: config.model,
                        fallbackModels: config.fallbackModels,
                    });
                } finally {
                    closeQuietly(openCodeDb);
                }
                recordRun("completed", null);
                return { status: "completed" };
            }

            // Agentic tasks: verify / curate / maintain-docs.
            return await runAgenticTask(config, ctx, {
                deps,
                deadline,
                parent,
                recordRun,
                computeMemoryDelta,
            });
        } catch (error) {
            const { transient, brief } = classifyFailure(error);
            recordRun("failed", brief);
            log(`[dreamer] task ${config.task} failed (transient=${transient}): ${brief}`);
            return { status: "failed", transient, error: brief };
        }
    };
}

function resolveRetrospectiveProvider(
    deps: DreamTaskExecutorDeps,
    db: Database,
    projectIdentity: string,
): RetrospectiveRawProvider | null {
    if (!deps.retrospectiveRawProvider) return null;
    return typeof deps.retrospectiveRawProvider === "function"
        ? deps.retrospectiveRawProvider(db, projectIdentity)
        : deps.retrospectiveRawProvider;
}

function withGlobalOrdinals(messages: RetrospectiveRawMessage[]): RetrospectiveRawMessage[] {
    return messages.map((message, index) => ({ ...message, ordinal: index + 1 }));
}

function renderGateUserLines(messages: RetrospectiveRawMessage[]): string[] {
    return messages
        .filter((message) => message.role === "user")
        .map((message) => `${message.ordinal}: ${message.text}`);
}

function signalFromGateOrdinals(
    ordinals: number[],
    messages: RetrospectiveRawMessage[],
): FrictionSignal[] {
    const valid = new Set(messages.map((message) => message.ordinal));
    const anchored = ordinals.filter((ordinal) => valid.has(ordinal));
    if (anchored.length === 0) return [];
    return [
        {
            kind: "frustration_marker",
            ordinals: anchored,
            message: "tiny gate classifier flagged user friction",
            score: 1,
        },
    ];
}

function renderFrictionWindow(
    messages: RetrospectiveRawMessage[],
    signals: FrictionSignal[],
    radius = 2,
): string {
    const anchors = new Set(signals.flatMap((signal) => signal.ordinals));
    const included = new Set<number>();
    for (const anchor of anchors) {
        for (let ordinal = anchor - radius; ordinal <= anchor + radius; ordinal += 1) {
            included.add(ordinal);
        }
    }
    const signalByOrdinal = new Map<number, string[]>();
    for (const signal of signals) {
        for (const ordinal of signal.ordinals) {
            const list = signalByOrdinal.get(ordinal) ?? [];
            list.push(signal.kind);
            signalByOrdinal.set(ordinal, list);
        }
    }

    return messages
        .filter((message) => included.has(message.ordinal))
        .map((message) => {
            const role =
                message.role === "assistant" ? "A" : message.role === "tool" ? "tool" : "U";
            const markers = signalByOrdinal.get(message.ordinal);
            const suffix = markers ? `  [signal: ${markers.join(", ")}]` : "";
            const tool = message.toolName ? ` ${message.toolName}` : "";
            return `${message.ordinal}. (${message.sessionId}) ${role}${tool}: ${message.text}${suffix}`;
        })
        .join("\n");
}

function retrospectiveEventsForSessions(
    db: Database,
    sessionIds: Iterable<string>,
): RetrospectivePromptEvent[] {
    const events: RetrospectivePromptEvent[] = [];
    for (const sessionId of sessionIds) {
        try {
            for (const event of getCompartmentEvents(db, sessionId)) {
                if (event.kind !== "causal_incident" && event.kind !== "trajectory_correction") {
                    continue;
                }
                events.push({
                    sessionId,
                    kind: event.kind,
                    fields: event.fields,
                    createdAt: event.createdAt,
                });
            }
        } catch {
            // Older/partial test DBs may not have event rows; corroboration is optional.
        }
    }
    return events.sort((a, b) => a.createdAt - b.createdAt).slice(-20);
}

async function runRetrospectiveTask(
    config: DreamTaskRuntimeConfig,
    ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        invocationStartedAt: number;
    },
): Promise<void> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const provider = resolveRetrospectiveProvider(deps, db, projectIdentity);
    if (!provider) {
        log("[dreamer] retrospective: no raw provider available — clean no-op");
        return;
    }

    const lastRunAt = getTaskScheduleState(db, projectIdentity, config.task)?.lastRunAt ?? null;
    const messages = withGlobalOrdinals(
        await readProjectRetrospectiveMessages(provider, projectIdentity, lastRunAt ?? 0),
    );
    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length === 0) {
        log("[dreamer] retrospective: no new user messages");
        return;
    }

    let signals = detectFrictionSignals(messages);
    if (signals.length === 0) {
        const userLines = renderGateUserLines(messages);
        const prompt = buildFrictionGatePrompt({ userLines });
        const gate = deps.frictionGateClassifier
            ? await deps.frictionGateClassifier({ prompt, userLines, config })
            : { hit: false, ordinals: [] };
        if (!gate.hit) {
            log("[dreamer] retrospective: no friction signal");
            return;
        }
        signals = signalFromGateOrdinals(gate.ordinals ?? [], messages);
        if (signals.length === 0) {
            log("[dreamer] retrospective: gate hit had no valid anchors");
            return;
        }
    }

    const frictionWindow = renderFrictionWindow(messages, signals);
    const anchoredOrdinals = new Set(signals.flatMap((signal) => signal.ordinals));
    const sourceSessionId =
        messages.find((message) => anchoredOrdinals.has(message.ordinal))?.sessionId ??
        userMessages[0]?.sessionId ??
        "retrospective";
    const eventSessionIds = new Set(messages.map((message) => message.sessionId));
    const events = retrospectiveEventsForSessions(db, eventSessionIds);
    const taskPrompt = buildRetrospectivePrompt({
        projectPath: projectIdentity,
        frictionWindow,
        events,
    });

    const abortController = new AbortController();
    let leaseLost = false;
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(db, holderId, leaseKey)) {
                leaseLost = true;
                abortController.abort();
            }
        } catch {
            leaseLost = true;
            abortController.abort();
        }
    }, 60_000);

    let childSessionId: string | null = null;
    let taskFailed = false;
    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(parent ? { parentID: parent } : {}),
                title: "magic-context-dream-retrospective",
            },
            query: { directory: deps.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Retrospective could not create its child session.");
        const sessionId = childSessionId;

        const remainingMs = Math.max(0, deadline - Date.now());
        const run = await shared.promptSyncWithValidatedOutputRetry(
            deps.client,
            {
                path: { id: sessionId },
                query: { directory: deps.sessionDirectory },
                body: {
                    agent: DREAMER_RETROSPECTIVE_AGENT,
                    system: RETROSPECTIVE_SYSTEM_PROMPT,
                    ...modelBodyField(config.model),
                    parts: [{ type: "text", text: taskPrompt, synthetic: true }],
                },
            },
            {
                timeoutMs: Math.min(remainingMs, config.timeoutMinutes * 60 * 1000),
                signal: abortController.signal,
                fallbackModels: config.fallbackModels,
                callContext: "dreamer:retrospective",
                fetchOutput: async () => {
                    const messagesResponse = await deps.client.session.messages({
                        path: { id: sessionId },
                        query: { directory: deps.sessionDirectory, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (outputMessages) => {
                    const text = extractLatestAssistantText(outputMessages);
                    if (!text) throw new Error("Retrospective returned no assistant output.");
                    return text;
                },
            },
        );

        if (leaseLost) throw new Error("Dream lease lost during retrospective");

        if (parent) {
            recordChildInvocation({
                db,
                parentSessionId: parent,
                harness: "opencode",
                subagent: "dreamer",
                task: config.task,
                startedAt: helpers.invocationStartedAt,
                status: "completed",
                messages: run.output,
            });
        }

        const learnings = parseRetrospectiveLearnings(run.validated);
        const applied = applyRetrospectiveLearnings({
            db,
            projectIdentity,
            sourceSessionId,
            learnings,
            userMemoryCollectionEnabled: deps.userMemoryCollectionEnabled === true,
        });
        log(
            `[dreamer] retrospective: signals=${signals.length} learnings=${learnings.length} memory=${applied.memoryWritten} observations=${applied.observationsInserted} dropped=${applied.observationsDropped} rejected=${applied.rejected.length}`,
        );
    } catch (error) {
        taskFailed = true;
        throw error;
    } finally {
        clearInterval(leaseInterval);
        if (childSessionId && !taskFailed && !shouldKeepSubagents()) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}

/** The generic agentic-task path (prompt + child session + per-task model),
 *  with lease renewal → abort-on-loss and maintain-docs protected-region enforce. */
async function runAgenticTask(
    config: DreamTaskRuntimeConfig,
    ctx: { db: Database; projectIdentity: string; holderId: string; leaseKey: string },
    helpers: {
        deps: DreamTaskExecutorDeps;
        deadline: number;
        parent: string | undefined;
        recordRun: (
            status: "completed" | "failed",
            error: string | null,
            extra?: {
                memoryChanges?: {
                    written: number;
                    deleted: number;
                    archived: number;
                    merged: number;
                } | null;
            },
        ) => void;
        computeMemoryDelta: (
            before: ReturnType<typeof getMemoryCountsByStatus>,
        ) => { written: number; deleted: number; archived: number; merged: number } | null;
    },
): Promise<TaskExecOutcome> {
    const { db, projectIdentity, holderId, leaseKey } = ctx;
    const { deps, deadline, parent } = helpers;
    const task = config.task as DreamingTask;
    const docsDir = deps.sessionDirectory;
    const invocationStartedAt = Date.now();
    const memoryBefore = getMemoryCountsByStatus(db, projectIdentity);

    const lastRunAt = getTaskScheduleState(db, projectIdentity, config.task)?.lastRunAt ?? null;

    const maintainDocsSnapshot =
        task === "maintain-docs" ? snapshotMaintainDocsFiles(docsDir) : undefined;
    const existingDocs =
        task === "maintain-docs"
            ? {
                  architecture: existsSync(`${docsDir}/ARCHITECTURE.md`),
                  structure: existsSync(`${docsDir}/STRUCTURE.md`),
              }
            : undefined;
    const userMemories =
        task === "curate"
            ? getActiveUserMemories(db).map((um) => ({ id: um.id, content: um.content }))
            : undefined;
    const classifyMemories =
        task === "classify-memories"
            ? getMemoriesByProject(db, projectIdentity).map((memory) => ({
                  id: memory.id,
                  category: memory.category,
                  content: memory.content,
                  importance: memory.importance,
                  scope: memory.scope,
                  shareable: memory.shareable,
              }))
            : undefined;
    const classifyTrajectory =
        task === "classify-memories"
            ? loadRecentTrajectoryCompartments(db, projectIdentity)
            : undefined;

    let verifyGate: MaintainMemoryGateResult | null = null;
    let curateMemories: MaintainMemoryGateResult["inScope"] | undefined;
    if (task === "verify") {
        verifyGate = await partitionMaintainMemoryScope({
            db,
            projectIdentity,
            projectDirectory: deps.sessionDirectory,
            scheduleState: getTaskScheduleState(db, projectIdentity, config.task),
            broadIntervalDays: config.broadIntervalDays,
        });
        log(
            `[dreamer] verify gate: mode=${verifyGate.mode} in_scope=${verifyGate.inScopeIds.length} skipped=${verifyGate.skippedIds.length} reason=${verifyGate.reason}`,
        );
        if (verifyGate.inScopeIds.length === 0) {
            const schedulePatch = verifyGate.startHead
                ? {
                      lastCheckedCommit: verifyGate.startHead,
                      ...(verifyGate.broadMode ? { lastBroadRunAt: Date.now() } : {}),
                  }
                : undefined;
            helpers.recordRun("completed", null, {
                memoryChanges: helpers.computeMemoryDelta(memoryBefore),
            });
            return { status: "completed", schedulePatch };
        }
    } else if (task === "curate") {
        curateMemories = loadActiveMemoryPromptMemories(db, projectIdentity);
        log(`[dreamer] curate pool: in_scope=${curateMemories.length}`);
    } else if (task === "classify-memories") {
        log(
            `[dreamer] classify pool: in_scope=${classifyMemories?.length ?? 0} trajectory=${classifyTrajectory?.length ?? 0}`,
        );
    }

    const taskPrompt = buildDreamTaskPrompt(task, {
        projectPath: projectIdentity,
        lastDreamAt: lastRunAt ? String(lastRunAt) : null,
        existingDocs,
        userMemories,
        verify: verifyGate
            ? {
                  memories: verifyGate.inScope,
                  mode: verifyGate.mode,
              }
            : undefined,
        curate: curateMemories ? { memories: curateMemories } : undefined,
        classify:
            classifyMemories && classifyTrajectory
                ? { memories: classifyMemories, trajectory: classifyTrajectory }
                : undefined,
    });

    const abortController = new AbortController();
    let leaseLost = false;
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(db, holderId, leaseKey)) {
                leaseLost = true;
                abortController.abort();
            }
        } catch {
            leaseLost = true;
            abortController.abort();
        }
    }, 60_000);

    let childSessionId: string | null = null;
    let taskFailed = false;
    try {
        const createResponse = await deps.client.session.create({
            body: {
                ...(parent ? { parentID: parent } : {}),
                title: `magic-context-dream-${task}`,
            },
            query: { directory: docsDir },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        childSessionId = typeof created?.id === "string" ? created.id : null;
        if (!childSessionId) throw new Error("Dreamer could not create its child session.");
        const sessionId = childSessionId;

        const remainingMs = Math.max(0, deadline - Date.now());
        const run = await shared.promptSyncWithValidatedOutputRetry(
            deps.client,
            {
                path: { id: sessionId },
                query: { directory: docsDir },
                body: {
                    agent: DREAMER_AGENT,
                    system: DREAMER_SYSTEM_PROMPT,
                    ...modelBodyField(config.model),
                    parts: [{ type: "text", text: taskPrompt, synthetic: true }],
                },
            },
            {
                timeoutMs: Math.min(remainingMs, config.timeoutMinutes * 60 * 1000),
                signal: abortController.signal,
                fallbackModels: config.fallbackModels,
                callContext: `dreamer:${task}`,
                fetchOutput: async () => {
                    const messagesResponse = await deps.client.session.messages({
                        path: { id: sessionId },
                        query: { directory: docsDir, limit: 50 },
                    });
                    return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                        preferResponseOnMissingData: true,
                    });
                },
                validateOutput: (messages) => {
                    const text = extractLatestAssistantText(messages);
                    if (!text) throw new Error("Dreamer returned no assistant output.");
                    return text;
                },
            },
        );

        if (leaseLost) throw new Error("Dream lease lost during task");

        if (parent) {
            recordChildInvocation({
                db,
                parentSessionId: parent,
                harness: "opencode",
                subagent: "dreamer",
                task,
                startedAt: invocationStartedAt,
                status: "completed",
                messages: run.output,
            });
        }

        if (task === "maintain-docs" && maintainDocsSnapshot && maintainDocsSnapshot.size > 0) {
            try {
                enforceMaintainDocsProtectedRegions({ docsDir, snapshot: maintainDocsSnapshot });
            } catch (e) {
                log(`[dreamer] maintain-docs protected-region enforcement failed: ${e}`);
            }
        }

        let schedulePatch: TaskExecOutcome["schedulePatch"];
        if (verifyGate) {
            const coverage = checkMaintainMemoryCoverage({
                db,
                inScopeIds: verifyGate.inScopeIds,
                runStartedAt: verifyGate.runStartedAt,
            });
            if (coverage.covered && verifyGate.startHead) {
                schedulePatch = {
                    lastCheckedCommit: verifyGate.startHead,
                    ...(verifyGate.broadMode ? { lastBroadRunAt: Date.now() } : {}),
                };
            } else if (!coverage.covered) {
                log(
                    `[dreamer] verify coverage incomplete: uncovered=${coverage.uncoveredIds.length} ids=${coverage.uncoveredIds.slice(0, 20).join(",")}`,
                );
            }
        }

        helpers.recordRun("completed", null, {
            memoryChanges: helpers.computeMemoryDelta(memoryBefore),
        });
        return { status: "completed", schedulePatch };
    } catch (error) {
        taskFailed = true;
        throw error;
    } finally {
        clearInterval(leaseInterval);
        if (childSessionId && !taskFailed && !shouldKeepSubagents()) {
            await deps.client.session.delete({ path: { id: childSessionId } }).catch(() => {});
        }
    }
}

/** Re-export for the dream-timer's executor wiring. */
export { isAgenticTask };
