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
    markCompactionRequest,
    messageIdsOf,
    rememberServedRender,
    renderCompactionRequest,
    resetCompactionRequestsForTest,
    takeCompactionMessagesTransform,
    takeCompactionSystemTransform,
} from "./compaction-request";
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
    it("shipped 1.18.30 order: compacting, system, messages; then the real turn's system, messages", () => {
        expect(takeCompactionSystemTransform("ses_a")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);

        markCompactionRequest("ses_a");
        expect(takeCompactionSystemTransform("ses_a")).toBe(true);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(true);
        // Another session is never affected.
        expect(takeCompactionSystemTransform("ses_b")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_b")).toBe(false);

        // The real turn after the compaction.
        expect(takeCompactionSystemTransform("ses_a")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
        expect(takeCompactionSystemTransform("ses_a")).toBe(false);
    });

    it("source-tag order: compacting, messages, system per attempt; then the real turn's messages, system", () => {
        markCompactionRequest("ses_a");
        expect(takeCompactionMessagesTransform("ses_a")).toBe(true);
        // One system transform per attempt of the compaction agent's LLM call.
        expect(takeCompactionSystemTransform("ses_a")).toBe(true);
        expect(takeCompactionSystemTransform("ses_a")).toBe(true);

        // The real turn after the compaction.
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
        expect(takeCompactionSystemTransform("ses_a")).toBe(false);
    });

    it("a new compaction reopens the window", () => {
        markCompactionRequest("ses_a");
        expect(takeCompactionSystemTransform("ses_a")).toBe(true);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(true);
        markCompactionRequest("ses_a");
        expect(takeCompactionSystemTransform("ses_a")).toBe(true);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(true);
    });

    it("forgets a deleted session", () => {
        markCompactionRequest("ses_a");
        clearCompactionRequest("ses_a");
        expect(takeCompactionSystemTransform("ses_a")).toBe(false);
        expect(takeCompactionMessagesTransform("ses_a")).toBe(false);
    });
});

describe("renderCompactionRequest", () => {
    const sessionId = "ses_served_render";
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
    // Magic Context's own compaction marker summary: not host input to the pass,
    // and not flagged synthetic.
    const markerSummary: MessageLike = {
        info: { id: "msg_marker_summary", role: "assistant", sessionID: sessionId },
        parts: [{ type: "text", text: "marker summary" }],
    } as unknown as MessageLike;

    function remember(input: TestMessage[], served: MessageLike[]): void {
        rememberServedRender(sessionId, messageIdsOf(input as unknown as MessageLike[]), served);
    }

    const idsOf = (messages: readonly MessageLike[] | null) =>
        messages?.map((message) => (message.info as { id: string }).id);

    it("serves the last render narrowed to the requested rows, plus rows newer than it", () => {
        const input = conversation(sessionId, 3);
        // The last pass folded turn 1 into m[0], tagged turn 2's reply and
        // dropped turn 3's reply.
        const served = [
            m0,
            markerSummary,
            input[2],
            { ...input[3], parts: [{ type: "text", text: "§7§ assistant reply 2" }] },
            input[4],
        ] as unknown as MessageLike[];
        remember(input, served);

        // The compaction request leaves out the retained tail (turn 3).
        const request = input.slice(0, 4) as unknown as MessageLike[];
        const result = renderCompactionRequest(sessionId, request);
        expect(idsOf(result)).toEqual(["mc_m0", "msg_marker_summary", "msg_u2", "msg_a2"]);
        expect(JSON.stringify(result)).toContain("§7§ assistant reply 2");
        expect(JSON.stringify(result)).not.toContain("user turn 1");
        // A copy: the remembered render is out of reach of the host.
        expect(result?.[0]).not.toBe(m0);

        // Rows newer than the last pass come after its render, as OpenCode sent
        // them; the reply that pass dropped stays out.
        const withNewer = [...input, ...turn(sessionId, 4)] as unknown as MessageLike[];
        expect(idsOf(renderCompactionRequest(sessionId, withNewer))).toEqual([
            "mc_m0",
            "msg_marker_summary",
            "msg_u2",
            "msg_a2",
            "msg_u3",
            "msg_u4",
            "msg_a4",
        ]);
    });

    it("declines without a render, or when the render shares no row with the request", () => {
        const input = conversation(sessionId, 2);
        expect(renderCompactionRequest(sessionId, input as unknown as MessageLike[])).toBe(null);
        remember(input, [m0, ...(input as unknown as MessageLike[])]);
        const unrelated = conversation("ses_other", 1).map((message) => ({
            ...message,
            info: { ...message.info, id: `other_${message.info.id}` },
        }));
        expect(renderCompactionRequest(sessionId, unrelated as unknown as MessageLike[])).toBe(
            null,
        );
        clearCompactionRequest(sessionId);
        expect(renderCompactionRequest(sessionId, input as unknown as MessageLike[])).toBe(null);
    });
});

describe("a compaction request between two real passes", () => {
    it("system-prompt hook keeps the stored hash and raises no refresh", async () => {
        useTempDataHome("compaction-request-system-");
        const sessionId = "ses_compaction_system";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stored-hash",
            systemPromptTokens: 1,
        });
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

        // Shipped order: the compaction's system transform runs before its messages
        // transform. The prompt matches none of the known internal-agent prompt
        // openers, so only the compacting hook's mark can identify the request.
        markCompactionRequest(sessionId);
        const system = ["An unrecognised summarizer prompt."];
        await handler({ sessionID: sessionId }, { system });
        expect(system).toEqual(["An unrecognised summarizer prompt."]);
        expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe("stored-hash");
        expect(historyRefreshSessions.has(sessionId)).toBe(false);
        takeCompactionMessagesTransform(sessionId);

        // The real turn's system transform comes next and is handled normally:
        // guidance is injected and a changed prompt is a real change.
        const realTurn = ["You are the main agent with a changed prompt."];
        await handler({ sessionID: sessionId }, { system: realTurn });
        expect(realTurn[0]).toContain("## Magic Context");
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
    });

    it("OpenCode 1.18's compaction prompt is recognised even outside the window", async () => {
        useTempDataHome("compaction-request-signature-");
        const sessionId = "ses_compaction_signature";
        const db = openDatabase();
        getOrCreateSessionMeta(db, sessionId);
        updateSessionMeta(db, sessionId, {
            systemPromptHash: "stored-hash",
            systemPromptTokens: 1,
        });
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
            db
                .prepare("SELECT * FROM tags WHERE session_id = ? ORDER BY tag_number")
                .all(sessionId),
        );

        // A historian publish lands between the passes. It is the next real
        // pass's to consume, not the compaction request's.
        historyRefreshSessions.add(sessionId);

        // OpenCode builds the compaction request from the history before the
        // retained tail (the last turn here).
        markCompactionRequest(sessionId);
        expect(takeCompactionSystemTransform(sessionId)).toBe(true);
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
