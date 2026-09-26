/// <reference types="bun-types" />

/**
 * OpenCode 1 builds its native compaction request through this session's
 * messages and system-prompt hooks. These tests pin how Magic Context tells that
 * request apart from a real turn, and that the request leaves the session's
 * served bytes and stored state exactly as the last real pass left them.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import {
    clearCompactionRequest,
    isCompactionSystemRequest,
    markCompactionRequest,
    renderCompactionRequestFromLkg,
    resetCompactionRequestsForTest,
    takeCompactionMessagesTransform,
} from "./compaction-request";
import { captureLkgSlot } from "./lkg-replay";
import { resetLkgSlotsForTest } from "./lkg-slot";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";
import type { MessageLike } from "./transform-operations";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    resetCompactionRequestsForTest();
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

/** The first line of OpenCode 1.18's compaction agent prompt (agent/prompt/compaction.txt). */
const COMPACTION_AGENT_PROMPT =
    "You are a context summarization agent. You are given a conversation between a user and an agent. Your goal is to produce a structured summary.";

type TestMessage = {
    info: Record<string, unknown> & { id: string; role: string };
    parts: Array<Record<string, unknown>>;
};

function turn(sessionId: string, index: number): TestMessage[] {
    const created = 1_000_000 + index * 10_000;
    return [
        {
            info: { id: `msg_u${index}`, role: "user", sessionID: sessionId, time: { created } },
            parts: [{ type: "text", text: `user turn ${index}` }],
        },
        {
            info: {
                id: `msg_a${index}`,
                role: "assistant",
                sessionID: sessionId,
                time: { created: created + 1, completed: created + 2 },
            },
            parts: [{ type: "text", text: `assistant reply ${index}` }],
        },
    ];
}

function conversation(sessionId: string, turns: number): TestMessage[] {
    const messages: TestMessage[] = [];
    for (let index = 1; index <= turns; index++) messages.push(...turn(sessionId, index));
    return messages;
}

const sha = (messages: readonly unknown[]): string =>
    createHash("sha256").update(JSON.stringify(messages)).digest("hex");

describe("compaction request detection", () => {
    it("claims only the messages transform right after the compacting hook", () => {
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
        expect(isCompactionSystemRequest("ses_a")).toBe(false);

        markCompactionRequest("ses_a");
        // The compaction request's own system transforms (one per attempt of its
        // LLM call) are all inside the window.
        expect(isCompactionSystemRequest("ses_a")).toBe(true);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(true);
        expect(isCompactionSystemRequest("ses_a")).toBe(true);
        expect(isCompactionSystemRequest("ses_a")).toBe(true);
        // Another session is never affected.
        expect(isCompactionSystemRequest("ses_b")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_b")).toBe(false);

        // The next messages transform is a real turn, and closes the window before
        // that turn's own system transform runs.
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
        expect(isCompactionSystemRequest("ses_a")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
    });

    it("forgets a deleted session", () => {
        markCompactionRequest("ses_a");
        clearCompactionRequest("ses_a");
        expect(isCompactionSystemRequest("ses_a")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
    });
});

describe("renderCompactionRequestFromLkg", () => {
    const sessionId = "ses_lkg_render";
    const m0: MessageLike = {
        info: { id: "mc_m0", role: "user", sessionID: sessionId },
        parts: [
            {
                type: "text",
                text: "<session-history>earlier work</session-history>",
                synthetic: true,
            },
        ],
    } as unknown as MessageLike;

    function capture(input: TestMessage[], output: MessageLike[]): void {
        expect(
            captureLkgSlot({
                sessionId,
                input: input as unknown as MessageLike[],
                output,
                modelKey: "anthropic/claude",
                providerKey: "anthropic",
            }),
        ).toBe(true);
    }

    it("serves the last render narrowed to the requested rows, plus rows newer than it", () => {
        const input = conversation(sessionId, 3);
        // The last render folded turn 1 into m[0] and tagged turn 2's reply.
        const rendered = [
            m0,
            input[2],
            { ...input[3], parts: [{ type: "text", text: "§7§ assistant reply 2" }] },
            input[4],
        ] as unknown as MessageLike[];
        capture(input, rendered);

        // The compaction request drops the retained tail (turn 3) and carries a
        // reply the render never saw.
        const request = [...input.slice(0, 4)] as unknown as MessageLike[];
        const result = renderCompactionRequestFromLkg(sessionId, request);
        expect(result?.map((message) => (message.info as { id: string }).id)).toEqual([
            "mc_m0",
            "msg_u2",
            "msg_a2",
        ]);
        expect(JSON.stringify(result)).toContain("§7§ assistant reply 2");
        expect(JSON.stringify(result)).not.toContain("user turn 1");

        const withNewer = [...input, ...turn(sessionId, 4)] as unknown as MessageLike[];
        expect(
            renderCompactionRequestFromLkg(sessionId, withNewer)?.map(
                (message) => (message.info as { id: string }).id,
            ),
        ).toEqual(["mc_m0", "msg_u2", "msg_a2", "msg_u3", "msg_a3", "msg_u4", "msg_a4"]);
    });

    it("declines without a render, or when the render shares no row with the request", () => {
        const input = conversation(sessionId, 2);
        expect(renderCompactionRequestFromLkg(sessionId, input as unknown as MessageLike[])).toBe(
            null,
        );
        capture(input, [m0, ...(input as unknown as MessageLike[])]);
        const unrelated = conversation("ses_other", 1).map((message) => ({
            ...message,
            info: { ...message.info, id: `other_${message.info.id}` },
        }));
        expect(
            renderCompactionRequestFromLkg(sessionId, unrelated as unknown as MessageLike[]),
        ).toBe(null);
    });
});

describe("a compaction request between two real passes", () => {
    it("system-prompt hook keeps the stored hash and raises no refresh", async () => {
        useTempDataHome("compaction-request-system-");
        const sessionId = "ses_compaction_system";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "stored-hash", systemPromptTokens: 1 });
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = createSystemPromptHashHandler({
            db,
            dreamerEnabled: false,
            resolveModel: () => ({ providerID: "provider", modelID: "model" }),
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
        });

        markCompactionRequest(sessionId);
        takeCompactionMessagesTransform(sessionId);
        // A prompt the signature list does not know, so only the window decides.
        const system = ["An unrecognised summarizer prompt."];
        await handler({ sessionID: sessionId }, { system });
        expect(system).toEqual(["An unrecognised summarizer prompt."]);
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe("stored-hash");
        expect(historyRefreshSessions.has(sessionId)).toBe(false);

        // Control: once a real turn closes the window, the same differing prompt is
        // a real change.
        takeCompactionMessagesTransform(sessionId);
        await handler({ sessionID: sessionId }, { system: ["An unrecognised summarizer prompt."] });
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
    });

    it("OpenCode 1.18's compaction prompt is recognised even outside the window", async () => {
        useTempDataHome("compaction-request-signature-");
        const sessionId = "ses_compaction_signature";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, { systemPromptHash: "stored-hash", systemPromptTokens: 1 });
        const historyRefreshSessions = new Set<string>();
        const { handler } = createSystemPromptHashHandler({
            db,
            dreamerEnabled: false,
            resolveModel: () => ({ providerID: "provider", modelID: "model" }),
            historyRefreshSessions,
            systemPromptRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
        });
        const system = [COMPACTION_AGENT_PROMPT];
        await handler({ sessionID: sessionId }, { system });
        expect(system).toEqual([COMPACTION_AGENT_PROMPT]);
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe("stored-hash");
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
    });

    it("priced pass A, compaction request, append, defer pass B: B starts with A's bytes", async () => {
        useTempDataHome("compaction-request-defer-");
        const sessionId = "ses_compaction_defer";
        const db = openDatabase();
        const historyRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 30_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions,
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 1,
        });
        const handler = createMessagesTransformHandler({
            magicContext: {
                "experimental.chat.messages.transform": transform as never,
            },
        });
        const run = async (messages: TestMessage[]): Promise<TestMessage[]> => {
            const output = { messages: messages as never[] };
            await handler({}, output);
            return output.messages as unknown as TestMessage[];
        };

        await run(conversation(sessionId, 3));
        const passA = await run(conversation(sessionId, 3));
        const metaAfterA = JSON.stringify(getOrCreateSessionMeta(db, sessionId));
        const tagsAfterA = JSON.stringify(
            db.prepare("SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number").all(sessionId),
        );

        // A historian publish lands between the passes. It is the next real
        // pass's to consume, not the compaction request's.
        historyRefreshSessions.add(sessionId);

        // OpenCode builds the compaction request from the history before the
        // retained tail (the last turn here).
        markCompactionRequest(sessionId);
        const compactionHead = await run(conversation(sessionId, 2));
        expect(compactionHead.map((message) => message.info.id)).toEqual(
            passA.slice(0, compactionHead.length).map((message) => message.info.id),
        );
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(JSON.stringify(getOrCreateSessionMeta(db, sessionId))).toBe(metaAfterA);
        expect(
            JSON.stringify(
                db
                    .prepare("SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number")
                    .all(sessionId),
            ),
        ).toBe(tagsAfterA);
        historyRefreshSessions.delete(sessionId);

        // The compaction produced no summary (it failed), so the next real pass is
        // an ordinary defer on the same history plus one appended turn.
        const passB = await run([...conversation(sessionId, 3), ...turn(sessionId, 4)]);
        expect(passB.length).toBe(passA.length + 2);
        expect(sha(passB.slice(0, passA.length))).toBe(sha(passA));
    });
});
