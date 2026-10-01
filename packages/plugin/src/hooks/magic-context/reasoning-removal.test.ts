/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addRemovedReasoningIds,
    getRemovedReasoningIds,
} from "../../features/magic-context/storage-reasoning-removal";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import {
    removeNeutralizedReasoningParts,
    removeReasoningParts,
    selectReasoningRemovals,
} from "./reasoning-removal";
import {
    isAnthropicFamilyRoute,
    isNeutralizedReasoningPart,
    makeSentinel,
    neutralizeDroppedReasoningPart,
} from "./sentinel";
import type { MessageLike } from "./tag-messages";
import { tagMessages } from "./tag-messages";
import { runPostTransformPhase } from "./transform-postprocess-phase";

type PostTransformArgs = Parameters<typeof runPostTransformPhase>[0];

let db: Database | undefined;
afterEach(() => {
    db?.close();
    db = undefined;
});

const REASONING = new Set(["reasoning", "thinking", "redacted_thinking"]);
const reasoningCount = (message: MessageLike): number =>
    message.parts.filter((part) => REASONING.has(String((part as { type?: unknown }).type))).length;
const sha256 = (value: unknown): string =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * One user turn followed by `steps` assistant steps, each shaped like an
 * OpenCode step on OpenAI Responses: step markers, a reasoning part whose
 * encrypted payload lives in provider metadata, and a completed tool call.
 * Assistant step `i` owns tag `i + 2` (the user text is tag 1).
 */
function toolLoop(steps: number, options: { reasoningOnlyStep?: number } = {}) {
    const messages: MessageLike[] = [
        {
            info: { id: "user-1", role: "user", sessionID: "s" },
            parts: [{ type: "text", text: "do the work" }],
        } as unknown as MessageLike,
    ];
    for (let step = 0; step < steps; step += 1) {
        const reasoningOnly = options.reasoningOnlyStep === step;
        messages.push({
            info: { id: `assistant-${step}`, role: "assistant", sessionID: "s" },
            parts: [
                { type: "step-start" },
                {
                    type: "reasoning",
                    text: `thinking ${step}`,
                    metadata: {
                        openai: {
                            itemId: `rs_${step}`,
                            reasoningEncryptedContent: `ENC_${step}_${"x".repeat(64)}`,
                        },
                    },
                },
                ...(reasoningOnly
                    ? []
                    : [
                          {
                              type: "tool",
                              tool: "bash",
                              callID: `call-${step}`,
                              state: { status: "completed", input: {}, output: `out ${step}` },
                          },
                      ]),
                { type: "step-finish" },
            ],
        } as unknown as MessageLike);
    }
    const tags = new Map<MessageLike, number>();
    messages.forEach((message, index) => {
        if (message.info.role === "user") tags.set(message, 1);
        else if (message.parts.some((part) => (part as { type?: string }).type === "tool"))
            tags.set(message, index + 1);
    });
    return { messages, tags };
}

describe("selectReasoningRemovals", () => {
    it("selects old reasoning-bearing assistants and never the newest", () => {
        const { messages, tags } = toolLoop(8);
        // maxTag = 9, age 3 → cutoff 6 → assistants with tags 2..6 (steps 0..4).
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(selected).toEqual([
            "assistant-0",
            "assistant-1",
            "assistant-2",
            "assistant-3",
            "assistant-4",
        ]);

        // A newer user turn with many tags ages every assistant past the
        // cutoff; the newest assistant still keeps its reasoning.
        const followUp = {
            info: { id: "user-2", role: "user", sessionID: "s" },
            parts: [{ type: "text", text: "next" }],
        } as unknown as MessageLike;
        tags.set(followUp, 40);
        const all = selectReasoningRemovals({
            messages: [...messages, followUp],
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(all).toContain("assistant-6");
        expect(all).not.toContain("assistant-7");
    });

    it("skips a message that would be left with no wire content", () => {
        const { messages, tags } = toolLoop(8, { reasoningOnlyStep: 2 });
        // A reasoning-only step has no tag of its own; give it one so only the
        // wire-content rule can exclude it.
        tags.set(messages[3], 4);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(),
            prefixBound: false,
        });
        expect(selected).not.toContain("assistant-2");
        expect(selected).toContain("assistant-3");
    });

    it("keeps the removed set a contiguous oldest prefix on prefix-bound models", () => {
        const { messages, tags } = toolLoop(8, { reasoningOnlyStep: 2 });
        tags.set(messages[3], 4);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(),
            prefixBound: true,
        });
        // assistant-2 cannot be removed, so nothing after it may be either.
        expect(selected).toEqual(["assistant-0", "assistant-1"]);
    });

    it("does not reselect ids that are already removed", () => {
        const { messages, tags } = toolLoop(8);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(["assistant-0", "assistant-1"]),
            prefixBound: true,
        });
        expect(selected).toEqual(["assistant-2", "assistant-3", "assistant-4"]);
    });
});

describe("removeReasoningParts", () => {
    it("removes whole reasoning parts with their provider metadata and keeps everything else", () => {
        const { messages } = toolLoop(3);
        const removed = removeReasoningParts(messages, new Set(["assistant-0"]), "openai");
        expect(removed).toBe(1);
        expect(reasoningCount(messages[1])).toBe(0);
        expect(JSON.stringify(messages[1])).not.toContain("ENC_0");
        expect(messages[1].parts.map((part) => (part as { type: string }).type)).toEqual([
            "step-start",
            "tool",
            "step-finish",
        ]);
        expect(reasoningCount(messages[2])).toBe(1);
    });

    it("never leaves a selected message without wire content", () => {
        const { messages } = toolLoop(3, { reasoningOnlyStep: 0 });
        removeReasoningParts(messages, new Set(["assistant-0"]), "openai");
        expect(messages[1].parts).toContainEqual({ type: "text", text: "[dropped]" });
    });
});

describe("reasoning removal through postprocess", () => {
    function openDb(): Database {
        db = new Database(":memory:");
        initializeDatabase(db);
        return db;
    }

    function pass(
        database: Database,
        sessionId: string,
        session: { messages: MessageLike[]; tags: Map<MessageLike, number> },
        options: { busting: boolean; providerID: string; prefixBound?: boolean },
    ) {
        const args: PostTransformArgs = {
            sessionId,
            db: database,
            messages: session.messages,
            tags: [],
            targets: new Map(),
            reasoningByMessage: new Map(),
            messageTagNumbers: session.tags,
            tagger: createTagger(),
            ctxReduceAvailability: { callable: true, frozen: true },
            todowriteAvailability: { callable: true, frozen: true },
            batch: null,
            contextUsage: { percentage: 20, inputTokens: 1000 },
            usableWindow: 128_000,
            schedulerDecision: "defer",
            schedulerDeferReason: "scheduler_defer",
            fullFeatureMode: false,
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
            sessionMeta: getOrCreateSessionMeta(database, sessionId),
            currentTurnId: null,
            pendingMaterializationSessions: new Set(options.busting ? [sessionId] : []),
            deferredHistoryRefreshSessions: new Set(),
            deferredMaterializationSessions: new Set(),
            lastHeuristicsTurnId: new Map(),
            clearReasoningAge: 3,
            protectedTagIds: new Set(),
            protectedTagNumbers: new Set(),
            protectedCutoff: null,
            protectedCount: 0,
            pendingCompartmentInjection: null,
            didMutateFromFlushedStatuses: false,
            watermark: 0,
            forceMaterializationPercentage: 85,
            hasRecentReduceCall: false,
            resolvedProviderID: options.providerID,
            thinkingBindingRecoveryEnabledForModel: options.prefixBound ?? false,
        };
        return runPostTransformPhase(args);
    }

    it("removes old reasoning on a rebuilding pass and replays it byte-identically on defer passes", async () => {
        const database = openDb();
        const sessionId = "ses-openai-removal";

        // A defer pass never originates a removal.
        const before = toolLoop(8);
        await pass(database, sessionId, before, { busting: false, providerID: "openai" });
        expect(before.messages.slice(1).every((m) => reasoningCount(m) === 1)).toBe(true);
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(0);

        // The rebuilding pass freezes and removes the old reasoning.
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "openai" });
        const removed = [0, 1, 2, 3, 4].map((step) => `assistant-${step}`);
        expect(getRemovedReasoningIds(database, sessionId)).toEqual(new Set(removed));
        for (const id of removed) {
            const message = busting.messages.find((m) => m.info.id === id) as MessageLike;
            expect(reasoningCount(message)).toBe(0);
        }
        expect(JSON.stringify(busting.messages)).not.toContain("ENC_0");
        expect(reasoningCount(busting.messages[busting.messages.length - 1])).toBe(1);

        // OpenCode rebuilds the array from its DB on every pass. Two defer
        // passes, the second with a longer tail, serve the same shared prefix.
        const deferOne = toolLoop(8);
        await pass(database, sessionId, deferOne, { busting: false, providerID: "openai" });
        expect(sha256(deferOne.messages)).toBe(sha256(busting.messages));

        const deferTwo = toolLoop(12);
        await pass(database, sessionId, deferTwo, { busting: false, providerID: "openai" });
        expect(sha256(deferTwo.messages.slice(0, busting.messages.length))).toBe(
            sha256(busting.messages),
        );
        // Newly aged reasoning waits for the next rebuilding pass.
        expect(reasoningCount(deferTwo.messages[6])).toBe(1);
        expect(getRemovedReasoningIds(database, sessionId)).toEqual(new Set(removed));
    });

    it("leaves canonical Anthropic on its existing lane and its frozen set empty", async () => {
        const database = openDb();
        const sessionId = "ses-anthropic-unchanged";
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "anthropic" });
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(0);
    });

    it("applies nothing when the persisted replay document is unreadable", async () => {
        const database = openDb();
        const sessionId = "ses-removal-write-fails";
        getOrCreateSessionMeta(database, sessionId);
        // A trailing-blank document this writer cannot parse makes every CAS fail.
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run('{"version":7}', sessionId);
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "openai" });
        expect(busting.messages.slice(1).every((m) => reasoningCount(m) === 1)).toBe(true);
    });

    it("stores the set without disturbing other replay document lanes", () => {
        const database = openDb();
        const sessionId = "ses-removal-document";
        getOrCreateSessionMeta(database, sessionId);
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run(JSON.stringify({ "assistant-x": "strip" }), sessionId);
        expect(addRemovedReasoningIds(database, sessionId, ["assistant-0"])).toBe(true);
        const raw = database
            .prepare(
                "SELECT trailing_blank_decisions AS raw FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { raw: string };
        expect(JSON.parse(raw.raw)).toEqual({
            version: 2,
            trailingBlank: { "assistant-x": "strip" },
            reasoningRemoval: { messageIds: ["assistant-0"] },
        });
    });
});

describe("reasoning invalidated by drops", () => {
    it("neutralizes in place to the exact makeSentinel shape (canonical Anthropic output unchanged)", () => {
        const original = {
            type: "reasoning",
            text: "signed thought",
            metadata: { anthropic: { signature: "sig" } },
            cache_control: { type: "ephemeral" },
        };
        const expected = makeSentinel(structuredClone(original));
        const part = structuredClone(original) as Record<string, unknown>;
        neutralizeDroppedReasoningPart(part);
        expect(JSON.stringify(part)).toBe(JSON.stringify(expected));
        expect(isNeutralizedReasoningPart(part)).toBe(true);
        const redacted = { type: "redacted_thinking", data: "opaque" };
        neutralizeDroppedReasoningPart(redacted);
        expect(redacted).toEqual({ type: "redacted_thinking", data: "opaque" });
    });

    it("a dropped tool takes its reasoning and encrypted payload off a non-Anthropic wire", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const { messages } = toolLoop(4);
        const tagged = tagMessages("ses-drop-path", messages, createTagger(), db);
        const row = db
            .prepare(
                "SELECT tag_number AS tagNumber FROM tags WHERE message_id = ? AND type = 'tool'",
            )
            .get("call-1") as { tagNumber: number } | undefined;
        expect(row).toBeDefined();
        expect(tagged.targets.get(row?.tagNumber ?? -1)?.drop?.()).toBe("removed");
        tagged.batch?.finalize();
        expect(JSON.stringify(messages)).not.toContain("[cleared]");
        const removed = removeNeutralizedReasoningParts(messages, "openai", false);
        expect(removed).toBe(1);
        // The tag lane links an OpenCode tool to the reasoning of the assistant
        // step before it; that reasoning leaves with its encrypted payload.
        const wire = JSON.stringify(messages);
        expect(wire).not.toContain("ENC_0");
        expect(wire).toContain("ENC_2");
        expect(wire).toContain("ENC_3");
        expect(messages.some((m) => m.parts.some(isNeutralizedReasoningPart))).toBe(false);
    });

    it("keeps the sentinel on canonical Anthropic and closes the prefix on bound models", () => {
        const anthropic = toolLoop(4).messages;
        neutralizeDroppedReasoningPart(anthropic[3].parts[1]);
        expect(removeNeutralizedReasoningParts(anthropic, "anthropic", true)).toBe(0);
        expect(anthropic[3].parts[1]).toEqual({ type: "text", text: "" });

        const bound = toolLoop(4).messages;
        neutralizeDroppedReasoningPart(bound[3].parts[1]);
        removeNeutralizedReasoningParts(bound, "google-vertex-anthropic", true);
        // assistant-2 lost its reasoning to a drop; everything older goes too.
        expect([1, 2, 3].map((index) => reasoningCount(bound[index]))).toEqual([0, 0, 0]);
        expect(reasoningCount(bound[4])).toBe(1);
    });

    it("scopes the forced skeleton to Anthropic-family routes", () => {
        expect(isAnthropicFamilyRoute("anthropic", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("google-vertex-anthropic", "claude-opus-5-5")).toBe(true);
        expect(isAnthropicFamilyRoute("amazon-bedrock", "us.anthropic.claude-fable-5-1-v1:0")).toBe(
            true,
        );
        expect(isAnthropicFamilyRoute("github-copilot", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("openai", "gpt-6.1-sol")).toBe(false);
        expect(isAnthropicFamilyRoute("google", "gemini-2.5-pro")).toBe(false);
        expect(isAnthropicFamilyRoute("deepseek", "deepseek-reasoner")).toBe(false);
    });
});
