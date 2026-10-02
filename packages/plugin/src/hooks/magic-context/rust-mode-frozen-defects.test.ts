/// <reference types="bun-types" />

// How the Rust-mode adapter moves its frozen last-known-good (LKG) state around
// failures, refusals, replays served from outside the adapter, restarts and
// admission checks. While frozen, every pass must keep serving the bytes the
// provider last saw (plus the new raw tail) until a pass installs something
// else; a pass that serves nothing must leave that state exactly as it was.

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

import { runMigrations } from "../../features/magic-context/migrations";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    getOrCreateSessionMeta,
    updateSessionMeta,
} from "../../features/magic-context/storage-meta";
import {
    clearEmergencyRecovery,
    getOverflowState,
    recordDetectedContextLimit,
    recordOverflowDetected,
    resetEmergencyRecoveryRegistryForTest,
} from "../../features/magic-context/storage-meta-persisted";
import {
    __resetToolDefinitionMeasurements,
    recordToolDefinition,
} from "../../features/magic-context/tool-definition-tokens";
import { __test as transformDecisionTest } from "../../features/magic-context/transform-decision-log";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { EmergencyFailClosedError } from "./emergency-fail-closed";
import { setRawMessageProvider } from "./read-session-chunk";
import { closeReadOnlySessionDb } from "./read-session-db";
import { createRustModeTransform, type RustModeModuleClient } from "./rust-mode-transform";
import type { TransformDeps } from "./transform";
import type { MessageLike } from "./transform-operations";

const MODEL = { providerID: "anthropic", modelID: "claude-opus-5-5" };
const MODEL_KEY = "anthropic/claude-opus-5-5";

const databases: ContextDatabase[] = [];
const unregisters: Array<() => void> = [];
let sessionCounter = 0;

afterEach(() => {
    __resetToolDefinitionMeasurements();
    resetEmergencyRecoveryRegistryForTest();
    closeReadOnlySessionDb();
    transformDecisionTest.reset();
    for (const unregister of unregisters.splice(0)) unregister();
    for (const db of databases.splice(0)) closeQuietly(db);
});

function makeDb(): ContextDatabase {
    const db = new Database(":memory:") as ContextDatabase;
    initializeDatabase(db);
    runMigrations(db);
    databases.push(db);
    return db;
}

function installRawProvider(sessionId: string): void {
    const row = { id: "m1", timeCreated: 1, contributesOrdinal: true, hasValidInfo: true };
    unregisters.push(
        setRawMessageProvider(sessionId, {
            readMessages: () => [row],
            readMessageOrdinalPage: (after, limit) =>
                !after || row.timeCreated > after.timeCreated || row.id > after.id
                    ? [row].slice(0, limit)
                    : [],
            getStoredMessageCount: () => 1,
            readMessagePartsById: () => ({
                id: "m1",
                role: "user",
                parts: [{ type: "text", text: "question" }],
                createdAt: 1,
            }),
        }),
    );
}

function user(sessionId: string, id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: sessionId, model: { ...MODEL } },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

function assistant(sessionId: string, id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [{ type: "text", text: `answer of ${id}` }],
    } as MessageLike;
}

function thinkingAssistant(sessionId: string, id: string): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: sessionId },
        parts: [
            {
                type: "reasoning",
                text: `thinking of ${id}`,
                metadata: { anthropic: { signature: `signature-${id}` } },
            },
            { type: "text", text: `answer of ${id}` },
        ],
    } as MessageLike;
}

function sha(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The module tags every user message the way the Rust tag overlay does. */
function tagAllUsers(input: MessageLike[]): unknown[] {
    return structuredClone(input).map((message, index) =>
        message.info.role === "user"
            ? {
                  ...message,
                  parts: message.parts.map((part) => {
                      const record = part as { type?: string; text?: string };
                      return record.type === "text" && typeof record.text === "string"
                          ? { ...record, text: `§${index + 1}§ ${record.text}` }
                          : part;
                  }),
              }
            : message,
    );
}

type Step = "throw" | string;

/**
 * A Rust session on a prefix-bound model whose module answers each pass from a
 * script (a decision string, or "throw" for a module failure) and renders the
 * input through `moduleOutput`. Captures commit inline.
 */
function frozenSession(label: string, options: { compactionOff?: boolean } = {}) {
    sessionCounter += 1;
    const sessionId = `rust-frozen-defects-${label}-${sessionCounter}-${Date.now()}`;
    const db = makeDb();
    installRawProvider(sessionId);
    recordDetectedContextLimit(db, sessionId, 200_000, MODEL_KEY);
    let pass = 0;
    const script: Step[] = [];
    let moduleOutput: (input: MessageLike[]) => unknown[] = (input) => structuredClone(input);
    let lastInput: MessageLike[] = [];
    const moduleClient: RustModeModuleClient = {
        call: async ({ method }) => {
            if (method !== "transform") return { ok: true };
            pass += 1;
            const step = script.shift() ?? "SOFT+";
            if (step === "throw") throw new Error("daemon unavailable");
            return {
                decision: step,
                served_from: "transform",
                row_version: pass,
                native_messages: moduleOutput(lastInput),
            };
        },
    };
    const deps: TransformDeps = {
        tagger: {} as TransformDeps["tagger"],
        scheduler: {} as TransformDeps["scheduler"],
        contextUsageMap: new Map(),
        db,
        protectedTokens: 4,
        clearReasoningAge: 50,
        historyRefreshSessions: new Set(),
        pendingMaterializationSessions: new Set(),
        lastHeuristicsTurnId: new Map(),
        directory: "/tmp/project",
        projectPath: "/tmp/project",
        memoryConfig: { enabled: false, injectionBudgetTokens: 1000, autoPromote: false },
        liveModelBySession: new Map([[sessionId, { ...MODEL }]]),
        sessionDirectoryBySession: new Map(),
        transformMode: "rust",
        rustModeModuleClient: moduleClient,
        historianRunner: "broca",
        getModelKey: () => MODEL_KEY,
        ...(options.compactionOff ? { compactionOff: true } : {}),
    };
    const transform = createRustModeTransform(deps, {
        moduleClient,
        modulePageMaxBytes: 512 * 1024,
        scheduleLkgCapture: (capture) => capture(),
    });
    const meta = () => {
        const sessionMeta = getOrCreateSessionMeta(db, sessionId);
        recordToolDefinition("anthropic", "claude-opus-5-5", undefined, "read", "read fixture", {
            type: "object",
        });
        if (sessionMeta.systemPromptTokens <= 0) {
            updateSessionMeta(db, sessionId, { systemPromptTokens: 100 });
            sessionMeta.systemPromptTokens = 100;
        }
        return sessionMeta;
    };
    const run = async (input: MessageLike[], step?: Step) => {
        if (step !== undefined) script.push(step);
        lastInput = input;
        const output = { messages: [...input] as unknown[] };
        await transform.run(sessionId, input, output, meta());
        return structuredClone(output.messages);
    };
    const frozenFields = () => {
        const state = transform.getState(sessionId);
        return {
            lkgRepresentationFrozen: state.lkgRepresentationFrozen,
            lkgFrozenAtInputCount: state.lkgFrozenAtInputCount,
            lkgFrozenHealthyPasses: state.lkgFrozenHealthyPasses,
            lkgLastServedCaptureSequence: state.lkgLastServedCaptureSequence,
        };
    };
    return {
        sessionId,
        db,
        deps,
        transform,
        run,
        frozenFields,
        setModuleOutput: (value: (input: MessageLike[]) => unknown[]) => {
            moduleOutput = value;
        },
        /** Arm emergency recovery without provider proof, so no LKG replay is admitted. */
        armEmergency: () =>
            recordOverflowDetected(db, sessionId, undefined, MODEL_KEY, "proactive_model_shrink"),
        disarmEmergency: () => {
            resetEmergencyRecoveryRegistryForTest();
            clearEmergencyRecovery(db, sessionId);
            expect(getOverflowState(db, sessionId).needsEmergencyRecovery).toBe(false);
        },
        /** Report provider usage at the given share of the trusted hard wall. */
        setUsagePercent: (percentage: number) => {
            deps.contextUsageMap.set(sessionId, {
                usage: { inputTokens: 10_000_000 * (percentage / 100), percentage },
                updatedAt: Date.now(),
                hasUsageTokens: true,
            });
        },
    };
}

/** HARD, a module failure that freezes, then two frozen defers that each capture. */
async function freezeWithTwoDefers(s: ReturnType<typeof frozenSession>) {
    const sid = s.sessionId;
    await s.run([user(sid, "m1", "question")], "HARD");
    const conversation: MessageLike[] = [
        user(sid, "m1", "question"),
        thinkingAssistant(sid, "a1"),
        user(sid, "m2", "turn 2"),
    ];
    await s.run([...conversation], "throw");
    conversation.push(assistant(sid, "a2"), user(sid, "m3", "turn 3"));
    await s.run([...conversation], "SOFT+");
    conversation.push(assistant(sid, "a3"), user(sid, "m4", "turn 4"));
    const lastServed = await s.run([...conversation], "SOFT+");
    expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    expect(s.frozenFields().lkgLastServedCaptureSequence).not.toBeNull();
    return { conversation, lastServed };
}

describe("a pass that serves nothing leaves the freeze as it was", () => {
    it("a failed replay that refuses keeps the freeze and the last-served proof", async () => {
        const s = frozenSession("refused-replay");
        const sid = s.sessionId;
        const { conversation, lastServed } = await freezeWithTwoDefers(s);
        const before = s.frozenFields();

        // The module fails and no replay is admitted while emergency recovery is
        // armed, so with compaction on the pass refuses.
        s.armEmergency();
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        await expect(s.run([...conversation], "throw")).rejects.toBeInstanceOf(
            EmergencyFailClosedError,
        );
        expect(s.frozenFields()).toEqual(before);

        // The module recovers and tags everything; the freeze still serves the bytes
        // the provider saw before the refusal, extended only by the new tail.
        s.disarmEmergency();
        s.setModuleOutput(tagAllUsers);
        const served = await s.run([...conversation], "SOFT+");
        expect(sha(served.slice(0, lastServed.length))).toBe(sha(lastServed));
        expect(sha(served.slice(lastServed.length))).toBe(
            sha(conversation.slice(lastServed.length)),
        );
        expect(s.frozenFields().lkgRepresentationFrozen).toBe(true);
    });

    it("a 95% emergency refusal leaves frozen state and last-served proof unchanged", async () => {
        const s = frozenSession("emergency-refusal");
        const sid = s.sessionId;
        const { conversation } = await freezeWithTwoDefers(s);
        const before = s.frozenFields();

        s.setUsagePercent(97);
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        await expect(s.run([...conversation], "throw")).rejects.toBeInstanceOf(
            EmergencyFailClosedError,
        );
        expect(s.frozenFields()).toEqual(before);
    });

    it("a compaction-off raw serve clears the freeze", async () => {
        const s = frozenSession("compaction-off-raw", { compactionOff: true });
        const sid = s.sessionId;
        const { conversation } = await freezeWithTwoDefers(s);

        // No replay is admitted, so compaction-off serves the raw input: the frozen
        // bytes are gone from the wire and the freeze must go with them.
        s.armEmergency();
        conversation.push(assistant(sid, "a4"), user(sid, "m5", "turn 5"));
        const served = await s.run([...conversation], "throw");
        expect(sha(served)).toBe(sha(conversation));
        expect(s.frozenFields()).toMatchObject({
            lkgRepresentationFrozen: false,
            lkgFrozenAtInputCount: null,
            lkgFrozenHealthyPasses: 0,
        });
    });
});
