/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
    getActiveTagsBySession,
    getOrCreateSessionMeta,
    getTagsBySession,
    insertTag,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    addRemovedReasoningIds,
    getRemovedReasoningIds,
} from "../../features/magic-context/storage-reasoning-removal";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import {
    removeReasoningParts,
    selectReasoningRemovals,
    settleDroppedReasoningParts,
} from "./reasoning-removal";
import {
    isAnthropicFamilyRoute,
    isNeutralizedReasoningPart,
    makeSentinel,
    neutralizeDroppedReasoningPart,
} from "./sentinel";
import type { MessageLike } from "./tag-messages";
import { type TagTarget, tagMessages } from "./tag-messages";
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

    it("selects nothing on prefix-bound models, where removing an older block invalidates every newer one", () => {
        const { messages, tags } = toolLoop(8);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(),
            prefixBound: true,
        });
        expect(selected).toEqual([]);
    });

    it("does not stop at an ineligible message and does not reselect removed ids", () => {
        const { messages, tags } = toolLoop(8, { reasoningOnlyStep: 2 });
        tags.set(messages[3], 4);
        const selected = selectReasoningRemovals({
            messages,
            messageTagNumbers: tags,
            clearReasoningAge: 3,
            alreadyRemoved: new Set(["assistant-0"]),
            prefixBound: false,
        });
        expect(selected).toEqual(["assistant-1", "assistant-3", "assistant-4"]);
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
        options: {
            busting: boolean;
            providerID: string | undefined;
            prefixBound?: boolean;
            overrides?: Partial<PostTransformArgs>;
        },
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
            ...options.overrides,
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

    it("replays the last good set when the persisted state becomes unreadable", async () => {
        const database = openDb();
        const sessionId = "ses-removal-read-failure";
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: "openai" });
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(5);
        const raw = database
            .prepare(
                "SELECT trailing_blank_decisions AS raw FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { raw: string };
        const corrupted = JSON.parse(raw.raw);
        corrupted.reasoningRemoval.messageIds.push(42);
        database
            .prepare("UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?")
            .run(JSON.stringify(corrupted), sessionId);
        const deferred = toolLoop(8);
        await pass(database, sessionId, deferred, { busting: false, providerID: "openai" });
        expect(sha256(deferred.messages)).toBe(sha256(busting.messages));
    });

    it("never selects removals when the provider is unresolved", async () => {
        const database = openDb();
        const sessionId = "ses-removal-unresolved";
        const busting = toolLoop(8);
        await pass(database, sessionId, busting, { busting: true, providerID: undefined });
        expect(getRemovedReasoningIds(database, sessionId).size).toBe(0);
        expect(busting.messages.slice(1).every((m) => reasoningCount(m) === 1)).toBe(true);
    });

    it("serves a drop's old [cleared] bytes until the first rebuilding pass, then leaves reasoning intact", async () => {
        const database = openDb();
        const sessionId = "ses-drop-mode";
        // A drop replay neutralizes the reasoning it is linked to on every pass.
        const withDrop = () => {
            const session = toolLoop(4);
            neutralizeDroppedReasoningPart(session.messages[2].parts[1]);
            return session;
        };
        const legacy = withDrop();
        await pass(database, sessionId, legacy, { busting: false, providerID: "openai" });
        expect(legacy.messages[2].parts[1]).toMatchObject({ type: "reasoning", text: "[cleared]" });
        expect(JSON.stringify(legacy.messages)).toContain("ENC_1");

        const rebuild = withDrop();
        await pass(database, sessionId, rebuild, { busting: true, providerID: "openai" });
        expect((rebuild.messages[2].parts[1] as { text: string }).text).toStartWith("thinking 1");
        expect(JSON.stringify(rebuild.messages)).not.toContain("[cleared]");

        const after = withDrop();
        await pass(database, sessionId, after, { busting: false, providerID: "openai" });
        expect(sha256(after.messages)).toBe(sha256(rebuild.messages));
    });

    it("keeps the emergency minimum when only persisted drops are replayed (100%, sub-2,000 selection)", async () => {
        const database = openDb();
        const sessionId = "ses-emergency-minimum";
        const toolMessage = {
            info: { id: "assistant-fresh", role: "assistant", sessionID: "s" },
            parts: [
                {
                    type: "tool",
                    tool: "bash",
                    callID: "call-fresh",
                    state: { status: "completed", input: {}, output: "word ".repeat(100) },
                },
            ],
        } as unknown as MessageLike;
        const conversation = {
            info: { id: "user-big", role: "user", sessionID: "s" },
            parts: [{ type: "text", text: "word ".repeat(7_000) }],
        } as unknown as MessageLike;
        insertTag(database, sessionId, "user-big", "message", 35_000, 1, 0, null, 0, null, null, {
            tokenCount: 8_750,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        insertTag(database, sessionId, "call-fresh", "tool", 500, 2, 0, "bash", 0, null, null, {
            tokenCount: 125,
            inputTokenCount: 0,
            reasoningTokenCount: 0,
        });
        const targets = new Map<number, TagTarget>([
            [
                1,
                {
                    message: conversation,
                    setContent: () => false,
                    getContent: () => "word ".repeat(7_000),
                },
            ],
            [
                2,
                {
                    message: toolMessage,
                    setContent: () => false,
                    canDrop: () => toolMessage.parts.length > 0,
                    measureReclaim: () => ({
                        beforeTools: 125,
                        afterTools: 0,
                        beforeProse: 0,
                        afterProse: 0,
                    }),
                    drop: () => {
                        toolMessage.parts.splice(0, 1);
                        return "removed";
                    },
                    skeletonReal: () => "truncated",
                    inputStringBytes: () => 0,
                },
            ],
        ]);
        await pass(
            database,
            sessionId,
            { messages: [conversation, toolMessage], tags: new Map() },
            {
                busting: false,
                providerID: "openai",
                overrides: {
                    schedulerDecision: "execute",
                    contextUsage: { percentage: 100, inputTokens: 335_000 },
                    emergencyCeilingTokens: 251_000,
                    // Replaying a persisted drop restored bytes already served; it
                    // must not count as a rewrite this pass already pays for.
                    didMutateFromFlushedStatuses: true,
                    tags: getActiveTagsBySession(database, sessionId),
                    targets,
                    sessionMeta: getOrCreateSessionMeta(database, sessionId),
                },
            },
        );
        const fresh = getTagsBySession(database, sessionId).find((tag) => tag.tagNumber === 2);
        expect(fresh?.status).toBe("active");
        expect(toolMessage.parts).toHaveLength(1);
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

    it("a drop leaves non-Anthropic reasoning to the age lane: the part is restored byte for byte", () => {
        db = new Database(":memory:");
        initializeDatabase(db);
        const { messages } = toolLoop(4);
        const original = structuredClone(messages[1]);
        const tagged = tagMessages("ses-drop-path", messages, createTagger(), db);
        const row = db
            .prepare(
                "SELECT tag_number AS tagNumber FROM tags WHERE message_id = ? AND type = 'tool'",
            )
            .get("call-1") as { tagNumber: number } | undefined;
        expect(tagged.targets.get(row?.tagNumber ?? -1)?.drop?.()).toBe("removed");
        tagged.batch?.finalize();
        // The tag lane links call-1 to the reasoning of the step before it.
        expect(isNeutralizedReasoningPart(messages[1].parts[1])).toBe(true);
        expect(settleDroppedReasoningParts(messages, "restore")).toBe(1);
        expect(JSON.stringify(messages[1].parts[1])).toBe(JSON.stringify(original.parts[1]));
        expect(JSON.stringify(messages)).not.toContain("[cleared]");
    });

    it("legacy mode reproduces the [cleared] bytes drops served before", () => {
        const { messages } = toolLoop(2);
        const part = messages[1].parts[1] as Record<string, unknown>;
        const legacyShape = { ...part, text: "[cleared]" };
        neutralizeDroppedReasoningPart(part);
        settleDroppedReasoningParts(messages, "legacy");
        expect(JSON.stringify(part)).toBe(JSON.stringify(legacyShape));
    });

    it("scopes the forced skeleton to Anthropic-family routes", () => {
        expect(isAnthropicFamilyRoute("anthropic", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("google-vertex-anthropic", "claude-opus-5-5")).toBe(true);
        expect(isAnthropicFamilyRoute("vertex-eu-anthropic", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("amazon-bedrock", "us.anthropic.claude-fable-5-1-v1:0")).toBe(
            true,
        );
        expect(isAnthropicFamilyRoute("github-copilot", "claude-sonnet-5")).toBe(true);
        expect(isAnthropicFamilyRoute("openrouter", "anthropic/claude-haiku-4.5")).toBe(true);
        // Non-Claude Bedrock models produce no signed Anthropic thinking.
        expect(isAnthropicFamilyRoute("amazon-bedrock", "amazon.nova-pro-v1:0")).toBe(false);
        expect(isAnthropicFamilyRoute("amazon-bedrock", "meta.llama3-70b-instruct-v1:0")).toBe(
            false,
        );
        expect(isAnthropicFamilyRoute("openrouter", "google/gemini-3-flash-preview")).toBe(false);
        expect(isAnthropicFamilyRoute("openai", "gpt-6.1-sol")).toBe(false);
        expect(isAnthropicFamilyRoute("google", "gemini-2.5-pro")).toBe(false);
        expect(isAnthropicFamilyRoute("deepseek", "deepseek-reasoner")).toBe(false);
    });
});

/**
 * One OpenCode assistant step for each route shape, carrying the reasoning
 * payload the route's adapter actually sends.
 */
function routeStep(
    route: "openai" | "vertex" | "deepseek" | "openrouter-claude" | "openrouter-gemini",
) {
    const reasoning: Record<string, unknown> = { type: "reasoning", text: "PAYLOAD thought" };
    const tool: Record<string, unknown> = {
        type: "tool",
        tool: "bash",
        callID: "call-x",
        state: { status: "completed", input: {}, output: "out" },
    };
    if (route === "openai")
        reasoning.metadata = {
            openai: { itemId: "rs_x", reasoningEncryptedContent: "PAYLOAD_ENC" },
        };
    if (route === "vertex") reasoning.metadata = { anthropic: { signature: "PAYLOAD_SIG" } };
    if (route === "openrouter-claude") {
        const details = [
            {
                type: "reasoning.text",
                text: "PAYLOAD thought",
                signature: "PAYLOAD_SIG",
                format: "anthropic-claude-v1",
            },
        ];
        reasoning.metadata = { openrouter: { reasoning_details: details } };
        tool.metadata = { openrouter: { reasoning_details: details } };
    }
    if (route === "openrouter-gemini") {
        const details = [
            {
                type: "reasoning.encrypted",
                data: "PAYLOAD_TSIG",
                id: "call-x",
                format: "google-gemini-v1",
            },
        ];
        reasoning.metadata = { openrouter: { reasoning_details: details } };
        tool.metadata = { openrouter: { reasoning_details: details } };
    }
    return {
        info: { id: "assistant-x", role: "assistant", sessionID: "s" },
        parts: [{ type: "step-start" }, reasoning, tool, { type: "step-finish" }],
    } as unknown as MessageLike;
}

describe("the removal lane never changes bytes without taking reasoning off the wire", () => {
    const routes = [
        ["openai", "openai"],
        ["vertex", "google-vertex-anthropic"],
        ["deepseek", "deepseek"],
        ["openrouter-claude", "openrouter"],
        ["openrouter-gemini", "openrouter"],
    ] as const;
    for (const [shape, providerID] of routes) {
        it(`${shape}: either every reasoning payload leaves, or nothing changes`, () => {
            const message = routeStep(shape);
            const newer = {
                ...routeStep("deepseek"),
                info: { id: "assistant-newer", role: "assistant" },
            } as MessageLike;
            const messages = [message, newer];
            const before = JSON.stringify(message);
            const selected = selectReasoningRemovals({
                messages,
                messageTagNumbers: new Map([
                    [message, 1],
                    [newer, 20],
                ]),
                clearReasoningAge: 5,
                alreadyRemoved: new Set(),
                prefixBound: false,
                providerID,
            });
            removeReasoningParts(messages, new Set(["assistant-x"]), providerID);
            const after = JSON.stringify(message);
            if (after !== before) {
                expect(after).not.toContain("PAYLOAD");
                expect(selected).toEqual(["assistant-x"]);
            } else {
                expect(selected).toEqual([]);
            }
        });
    }

    it("openrouter Claude: the signed reasoning_details copies on the tool call leave too", () => {
        const message = routeStep("openrouter-claude");
        removeReasoningParts(
            [message, routeStep("deepseek")],
            new Set(["assistant-x"]),
            "openrouter",
        );
        expect(JSON.stringify(message)).not.toContain("reasoning_details");
        expect(message.parts.some((part) => (part as { type: string }).type === "tool")).toBe(true);
    });

    it("openrouter Gemini: thought signatures on tool calls are never touched", () => {
        const message = routeStep("openrouter-gemini");
        const before = JSON.stringify(message);
        removeReasoningParts(
            [message, routeStep("deepseek")],
            new Set(["assistant-x"]),
            "openrouter",
        );
        expect(JSON.stringify(message)).toBe(before);
    });
});
