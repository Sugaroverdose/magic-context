/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import {
    addStaleReduceStrippedIds,
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getTagsBySession,
    insertTag,
    queueM0Mutation,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import type { MessageLike, TagTarget } from "./tag-messages";
import {
    checkM0MutationDriftAndSignal,
    runPostTransformPhase,
} from "./transform-postprocess-phase";

const SESSION_ID = "ses-postprocess-drift";
let db: Database;

afterEach(() => {
    if (db) db.close();
});

describe("m[0] mutation drift watcher", () => {
    it("schedules next-pass materialization when m0_mutation_log gets a newer id", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const pendingMaterializationSessions = new Set<string>();
        const historyRefreshSessions = new Set<string>();

        queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
            queuedAt: 1,
        });

        const scheduled = checkM0MutationDriftAndSignal({
            db,
            sessionId: SESSION_ID,
            cachedM0MaxMutationId: 0,
            pendingMaterializationSessions,
            historyRefreshSessions,
        });

        expect(scheduled).toBe(true);
        expect(pendingMaterializationSessions.has(SESSION_ID)).toBe(true);
        expect(historyRefreshSessions.has(SESSION_ID)).toBe(true);
    });

    it("does not schedule when the cached monotonic mutation id is current", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const mutation = queueM0Mutation(db, {
            sessionId: SESSION_ID,
            mutationType: "compartment_merge",
        });
        const pendingMaterializationSessions = new Set<string>();

        const scheduled = checkM0MutationDriftAndSignal({
            db,
            sessionId: SESSION_ID,
            cachedM0MaxMutationId: mutation.id,
            pendingMaterializationSessions,
        });

        expect(scheduled).toBe(false);
        expect(pendingMaterializationSessions.has(SESSION_ID)).toBe(false);
    });
});

function makeToolMessage(id: string): MessageLike {
    return {
        info: { id, role: "assistant" },
        parts: [
            {
                type: "tool",
                tool: "bash",
                state: { output: "x".repeat(4000), status: "completed" },
            },
        ],
    } as unknown as MessageLike;
}

function makeDropTarget(message: MessageLike): TagTarget {
    return {
        message,
        setContent: () => false,
        drop: () => {
            const index = message.parts.findIndex(
                (part) => (part as { type?: string }).type === "tool",
            );
            if (index < 0) return "absent";
            message.parts.splice(index, 1);
            return "removed";
        },
        canDrop: () => message.parts.some((part) => (part as { type?: string }).type === "tool"),
    };
}

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

function basePostTransformArgs(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    overrides: Partial<PostTransformArgs> = {},
): PostTransformArgs {
    return {
        sessionId,
        db,
        messages,
        tags: [],
        targets: new Map(),
        reasoningByMessage: new Map(),
        messageTagNumbers: new Map(),
        batch: null,
        contextUsage: { percentage: 20, inputTokens: 1000 },
        schedulerDecision: "defer",
        fullFeatureMode: true,
        canRunCompartments: false,
        awaitedCompartmentRun: false,
        phaseJustAwaitedPublication: false,
        compartmentInProgress: false,
        historyRefreshExplicitBeforePrepare: false,
        deferredHistoryWasPendingAtPassStart: false,
        compartmentInjectionRebuiltFromDb: false,
        rebuiltHistoryFromInitialPrepare: false,
        historyRebuiltThisPass: false,
        canConsumeDeferredLate: false,
        sessionMeta: getOrCreateSessionMeta(db, sessionId),
        currentTurnId: null,
        pendingMaterializationSessions: new Set(),
        deferredHistoryRefreshSessions: new Set(),
        deferredMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        clearReasoningAge: 999,
        protectedTags: 0,
        pendingCompartmentInjection: null,
        didMutateFromFlushedStatuses: false,
        watermark: 0,
        forceMaterializationPercentage: 85,
        hasRecentReduceCall: false,
        ...overrides,
    };
}

describe("postprocess emergency drop accounting", () => {
    it("plans emergency floor from tags that remain active after pending ops", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-postprocess-floor";
        const messages = [1, 2, 3, 4].map((tag) => makeToolMessage(`tool-${tag}`));
        const targets = new Map<number, TagTarget>();

        for (let tag = 1; tag <= 4; tag++) {
            insertTag(db, sessionId, `tool-${tag}`, "tool", 4000, tag, 0, "bash");
            targets.set(tag, makeDropTarget(messages[tag - 1]!));
        }
        queuePendingOp(db, sessionId, 1, "drop", 1);
        queuePendingOp(db, sessionId, 2, "drop", 2);

        // This is the stale pre-pending snapshot the transform caller has at pass
        // start. The postprocess phase must refresh it after applyPendingOperations.
        const staleActiveTags = getActiveTagsBySession(db, sessionId);

        await runPostTransformPhase({
            sessionId,
            db,
            messages,
            tags: staleActiveTags,
            targets,
            reasoningByMessage: new Map(),
            messageTagNumbers: new Map(),
            batch: { finalize: () => {} },
            contextUsage: { percentage: 90, inputTokens: 7000 },
            schedulerDecision: "execute",
            fullFeatureMode: true,
            canRunCompartments: false,
            awaitedCompartmentRun: false,
            phaseJustAwaitedPublication: false,
            compartmentInProgress: false,
            historyRefreshExplicitBeforePrepare: false,
            deferredHistoryWasPendingAtPassStart: false,
            compartmentInjectionRebuiltFromDb: false,
            rebuiltHistoryFromInitialPrepare: false,
            historyRebuiltThisPass: false,
            canConsumeDeferredLate: false,
            sessionMeta: getOrCreateSessionMeta(db, sessionId),
            currentTurnId: "turn-floor",
            pendingMaterializationSessions: new Set(),
            deferredHistoryRefreshSessions: new Set(),
            deferredMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 999,
            protectedTags: 0,
            emergencyCeilingTokens: 6000,
            pendingCompartmentInjection: null,
            didMutateFromFlushedStatuses: false,
            watermark: 0,
            forceMaterializationPercentage: 85,
            hasRecentReduceCall: false,
        });

        const statuses = getTagsBySession(db, sessionId).map((tag) => [tag.tagNumber, tag.status]);
        expect(statuses).toEqual([
            [1, "dropped"],
            [2, "dropped"],
            [3, "active"],
            [4, "active"],
        ]);
    });
});

describe("postprocess empty-sentinel provider gate", () => {
    it("does not sentinelize cleared reasoning on github-copilot execute passes", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-cleared-reasoning";
        const messages: MessageLike[] = [
            {
                info: { id: "m-cleared", role: "assistant" },
                parts: [{ type: "thinking", thinking: "[cleared]" }],
            } as unknown as MessageLike,
        ];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "execute",
                contextUsage: { percentage: 60, inputTokens: 6000 },
                currentTurnId: "turn-cleared",
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(messages[0].parts).toEqual([{ type: "thinking", thinking: "[cleared]" }]);
    });

    it("leaves processed image file parts native for github-copilot", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-processed-image";
        const userMessage = {
            info: { id: "m-image", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 1,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(userMessage.parts[0]).toMatchObject({ type: "file", mime: "image/png" });
        expect(userMessage.parts).not.toContainEqual({ type: "text", text: "" });
    });

    it("still sentinelizes processed image file parts for anthropic", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-anthropic-processed-image";
        const userMessage = {
            info: { id: "m-image", role: "user" },
            parts: [
                {
                    type: "file",
                    mime: "image/png",
                    url: `data:image/png;base64,${"a".repeat(220)}`,
                },
            ],
        } as unknown as MessageLike;
        const messages: MessageLike[] = [
            userMessage,
            {
                info: { id: "m-assistant", role: "assistant" },
                parts: [{ type: "text", text: "seen" }],
            },
        ] as unknown as MessageLike[];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                watermark: 1,
                messageTagNumbers: new Map([[userMessage, 1]]),
                resolvedProviderID: "anthropic",
            }),
        );

        expect(userMessage.parts).toEqual([{ type: "text", text: "" }]);
    });

    it("does not replay stale ctx_reduce frozen ids as empty sentinels for github-copilot", async () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const sessionId = "ses-copilot-stale-reduce";
        addStaleReduceStrippedIds(db, sessionId, ["reduce-1"]);
        const messages: MessageLike[] = [
            {
                info: { id: "reduce-1", role: "tool" },
                parts: [
                    {
                        type: "tool",
                        tool: "ctx_reduce",
                        callID: "call-reduce",
                        state: { output: "Queued: drop §1§", status: "completed" },
                    },
                ],
            } as unknown as MessageLike,
        ];

        await runPostTransformPhase(
            basePostTransformArgs(db, sessionId, messages, {
                schedulerDecision: "defer",
                resolvedProviderID: "github-copilot",
            }),
        );

        expect(messages[0].parts[0]).toMatchObject({ type: "tool", tool: "ctx_reduce" });
    });
});
