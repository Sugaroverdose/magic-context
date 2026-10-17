/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { OrdinalMint } from "../../features/magic-context/reduce-resolver";
import type { CallIdTagResolver } from "../../features/magic-context/tool-call-registry";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { Database } from "../../shared/sqlite";
import { createCtxReduceTools } from "./tools";

/**
 * The unit-test world mirrors the PRODUCTION key shapes (live context.db
 * census): registry message rows carry the suffixed content key `base:pK`,
 * registry tool rows carry the WIRE call id in message_id with the bare owner
 * message in tool_owner_message_id, and the FTS mirror carries bare message
 * ids. A world that seeded bare ids on message rows and owner ids on tool
 * rows silently hid every cross-domain join miss — production geometry must
 * be the seeded geometry. The host-store bridge (rank pairing) is covered
 * against a host-shaped store in tag-call-bridge.test.ts; this file's fake
 * resolver answers the production query shape (message_id = wire call id).
 */

function createTestDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      message_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      drop_mode TEXT DEFAULT 'full',
      tool_name TEXT,
      content_id TEXT,
      input_byte_size INTEGER DEFAULT 0,
      byte_size INTEGER NOT NULL DEFAULT 0,
      session_id TEXT NOT NULL,
      tag_number INTEGER NOT NULL,
      reasoning_byte_size INTEGER NOT NULL DEFAULT 0,
      caveman_depth INTEGER NOT NULL DEFAULT 0,
      harness TEXT NOT NULL DEFAULT 'opencode',
      tool_owner_message_id TEXT DEFAULT NULL,
      token_count INTEGER DEFAULT NULL,
      input_token_count INTEGER DEFAULT NULL,
      entry_fingerprint TEXT DEFAULT NULL
    );
    CREATE TABLE pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      tag_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      queued_at INTEGER NOT NULL,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
    CREATE VIRTUAL TABLE message_history_fts USING fts5(
      session_id UNINDEXED,
      message_ordinal UNINDEXED,
      message_id UNINDEXED,
      role,
      content,
      tokenize='porter unicode61'
    );
    CREATE TABLE session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER,
      cache_ttl TEXT,
      counter INTEGER DEFAULT 0,
      last_nudge_tokens INTEGER DEFAULT 0,
      last_nudge_band TEXT DEFAULT '',
      last_transform_error TEXT DEFAULT '',
      is_subagent INTEGER DEFAULT 0,
      last_context_percentage REAL DEFAULT 0,
      last_input_tokens INTEGER DEFAULT 0,
      observed_safe_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_alert_sent INTEGER NOT NULL DEFAULT 0,
      times_execute_threshold_reached INTEGER DEFAULT 0,
      compartment_in_progress INTEGER DEFAULT 0,
      historian_failure_count INTEGER DEFAULT 0,
      historian_last_error TEXT DEFAULT NULL,
      historian_last_failure_at INTEGER DEFAULT NULL,
      system_prompt_hash INTEGER DEFAULT 0,
      system_prompt_tokens INTEGER DEFAULT 0,
      conversation_tokens INTEGER DEFAULT 0,
      tool_call_tokens INTEGER DEFAULT 0,
      cleared_reasoning_through_tag INTEGER DEFAULT 0,
      last_todo_state TEXT DEFAULT '',
      cached_m0_workspace_fingerprint TEXT,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return db;
}

interface SeedTag {
    tagNumber: number;
    /**
     * Production registry key: `base:pK` for message rows, the WIRE CALL ID
     * for tool rows.
     */
    messageId: string;
    sessionId: string;
    /** Bare owner message id (tool rows). */
    owner?: string;
    status?: string;
    tagType?: "message" | "tool";
    tokens?: number | null;
}

interface SeedMessage {
    messageId: string;
    ordinal: number;
    role: string;
    content: string;
    sessionId?: string;
}

function seedTags(db: Database, tags: SeedTag[]) {
    for (const tag of tags) {
        db.prepare(
            "INSERT INTO tags (message_id, type, status, tool_owner_message_id, byte_size, token_count, session_id, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
            tag.messageId,
            tag.tagType ?? "tool",
            tag.status ?? "active",
            tag.owner ?? null,
            100,
            tag.tokens ?? null,
            tag.sessionId,
            tag.tagNumber,
        );
    }
}

function seedMessages(db: Database, messages: SeedMessage[], sessionId = "ses-1") {
    for (const message of messages) {
        db.prepare(
            "INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
        ).run(
            message.sessionId ?? sessionId,
            message.ordinal,
            message.messageId,
            message.role,
            message.content,
        );
    }
}

/**
 * DI fake for the canonical message-ordinal mint: production recomputes from
 * the host `message` table plus the part-data call ids; this world keeps
 * positions in the FTS mirror, so the fake reads those plus explicit
 * overrides, and builds the wire-call-id map from the seeded production-
 * shaped tool rows (message_id = call id, owner = positioned message).
 */
function fakeOrdinalMint(
    db: Database,
    extra: Record<string, number> = {},
    latestUserOrdinal?: number,
): OrdinalMint {
    const rows = db
        .prepare(
            "SELECT message_id, CAST(message_ordinal AS INTEGER) AS ordinal FROM message_history_fts",
        )
        .all() as unknown as { message_id: string; ordinal: number }[];
    const ordinalByMessageId = new Map<string, number>();
    for (const row of rows) ordinalByMessageId.set(row.message_id, row.ordinal);
    for (const [messageId, ordinal] of Object.entries(extra)) {
        ordinalByMessageId.set(messageId, ordinal);
    }
    const ordinalByCallId = new Map<string, number>();
    const toolRows = db
        .prepare(
            "SELECT message_id, tool_owner_message_id FROM tags WHERE type = 'tool' AND message_id NOT LIKE 'msg-%'",
        )
        .all() as unknown as { message_id: string; tool_owner_message_id: string | null }[];
    for (const row of toolRows) {
        const ordinal = row.tool_owner_message_id
            ? ordinalByMessageId.get(row.tool_owner_message_id)
            : undefined;
        if (typeof ordinal === "number") ordinalByCallId.set(row.message_id, ordinal);
    }
    return { ordinalByMessageId, ordinalByCallId, latestUserOrdinal };
}

/**
 * DI fake for the call-id bridge answering in the PRODUCTION query shape:
 * tool rows key themselves by the wire call id in message_id. The host-store
 * rank pairing lives in tag-call-bridge.test.ts against a host-shaped store.
 */
function fakeCallIdResolver(db: Database, sessionId: string): CallIdTagResolver {
    return {
        resolve(callIds) {
            const map = new Map<
                string,
                { tag_number: number; message_id: string; status: string; type: string } | undefined
            >();
            for (const callId of callIds) {
                const row = db
                    .prepare(
                        "SELECT tag_number, message_id, status, type FROM tags WHERE session_id = ? AND message_id = ? AND type = 'tool' LIMIT 1",
                    )
                    .get(sessionId, callId) as
                    | { tag_number: number; message_id: string; status: string; type: string }
                    | undefined;
                map.set(callId, row);
            }
            return map;
        },
    };
}

function pendingTagNumbers(db: Database, sessionId: string): number[] {
    return (
        db
            .prepare(
                "SELECT tag_id FROM pending_ops WHERE session_id = ? AND operation = 'drop' ORDER BY tag_id ASC",
            )
            .all(sessionId) as Array<{ tag_id: number }>
    ).map((row) => row.tag_id);
}

describe("ctx_reduce handles lane (ids)", () => {
    let db: Database;
    const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

    const seed = (d: Database) =>
        seedTags(d, [
            { tagNumber: 5, messageId: "call-a", owner: "msg-5", sessionId: "ses-1" },
            { tagNumber: 7, messageId: "call-b", owner: "msg-7", sessionId: "ses-1" },
            { tagNumber: 9, messageId: "call-c", owner: "msg-9", sessionId: "ses-1" },
            {
                tagNumber: 11,
                messageId: "call-d",
                owner: "msg-11",
                sessionId: "ses-1",
                status: "dropped",
            },
            { tagNumber: 3, messageId: "call-e", owner: "msg-3", sessionId: "ses-2" },
        ]);

    beforeEach(() => {
        db = createTestDb();
        seed(db);
    });

    const withWorld = (overrides: {
        protectedSet?: ReadonlySet<number>;
        rustToolBackends?: RustToolBackends;
        resolver?: CallIdTagResolver;
        mintExtra?: Record<string, number>;
        latestUserOrdinal?: number;
    }) =>
        createCtxReduceTools({
            db,
            protectedSet: overrides.protectedSet ?? new Set<number>(),
            callIdResolver: overrides.resolver ?? fakeCallIdResolver(db, "ses-1"),
            ordinalMint: () =>
                fakeOrdinalMint(
                    db,
                    {
                        "msg-5": 5,
                        "msg-7": 7,
                        "msg-9": 9,
                        "msg-11": 11,
                        "msg-3": 3,
                        ...overrides.mintExtra,
                    },
                    overrides.latestUserOrdinal,
                ),
            rustToolBackends: overrides.rustToolBackends,
        });

    it("resolves copied call ids, echoes ordinals in input order, reports noop facts outside", async () => {
        const tools = withWorld({ protectedSet: new Set<number>([9]) });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-b", "call-d", "call-c"] },
            ctx,
        )) as string;

        expect(response).toContain("ctx_handles: 5, 7, 11, 9.");
        expect(response).toContain("already released: 11.");
        expect(response).toContain(
            "call-c provided in ctx_handles is inside the protected working set; it applies once newer work displaces it.",
        );
        // Protected items are queued deferred (upstream semantics), not refused.
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
    });

    it("is idempotent: re-sent ids report the queued noop and queue nothing new", async () => {
        const tools = withWorld({});
        await tools.ctx_reduce!.execute({ ctx_handles: ["call-a"] }, ctx);
        const before = pendingTagNumbers(db, "ses-1");
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a"] },
            ctx,
        )) as string;
        expect(response).toBe(
            [
                "All requested tags were already queued or processed. No new action is needed.",
                "ctx_handles: 5.",
                "queued for release: 5.",
            ].join("\n"),
        );
        expect(pendingTagNumbers(db, "ses-1")).toEqual(before);
    });

    it("keeps positional slots for repeated ids: same ordinal per slot, one queued op", async () => {
        const tools = withWorld({});
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-a"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 5, 5.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5]);
    });

    it("rejects a foreign-session id as broken input, never a foreign release", async () => {
        const tools = withWorld({});
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-e"] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "call-e" provided in ctx_handles was not found: no tool call id and no message text matches it in this session.',
        );
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        expect(pendingTagNumbers(db, "ses-2")).toEqual([]);
    });

    it("rejects the whole batch when the bridge cannot pair one id, valid siblings unapplied", async () => {
        const tools = withWorld({ resolver: { resolve: () => new Map() } });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-b", "call-a"] },
            ctx,
        )) as string;
        expect(response).toContain('error: "call-b" provided in ctx_handles was not found');
        expect(response).not.toContain("ctx_handles: 7");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("error shape never coexists with success lines", async () => {
        const tools = withWorld({});
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "nope-1"] },
            ctx,
        )) as string;
        expect(response).toContain('error: "nope-1" provided in ctx_handles was not found');
        // The valid sibling is NOT applied: the corrected resend applies all slots.
        expect(response).not.toContain("ctx_handles: 5");
        expect(response).not.toContain("already released");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("rejects mixing handles with the legacy drop grammar", async () => {
        const tools = withWorld({});
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a"], drop: "7" },
            ctx,
        )) as string;
        expect(response).toContain("cannot be combined");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("no-arg invocation releases the bulk default set", async () => {
        const tools = withWorld({ latestUserOrdinal: 11 });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("released everything responded past: 5, 7, 9.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
    });

    it("routes queued numbers through the module backend and honors its dedupe", async () => {
        let received: string | null = null;
        let queued = 0;
        const rustToolBackends = {
            reduce: (async (request: { drop: string }) => {
                received = request.drop;
                return { result: { ok: true, queued } };
            }) as unknown as RustToolBackends["reduce"],
        };
        const tools = withWorld({ rustToolBackends });

        queued = 2;
        const first = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(received).toBe("5,7");
        expect(first).toBe("ctx_handles: 5, 7.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);

        queued = 0;
        const second = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(second).toContain("already released: 5, 7.");
        expect(second).toContain("ctx_handles: 5, 7.");
    });

    it("refuses capability when the module backend throws", async () => {
        const rustToolBackends = {
            reduce: (async () => {
                throw new Error("module down");
            }) as unknown as RustToolBackends["reduce"],
        };
        const tools = withWorld({ rustToolBackends });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a"] },
            ctx,
        )) as string;
        expect(response).toContain("cleanup");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });
});

describe("ctx_reduce handles lane (quotes)", () => {
    let db: Database;
    const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

    beforeEach(() => {
        db = createTestDb();
        seedMessages(db, [
            {
                messageId: "msg-a",
                ordinal: 100,
                role: "user",
                content: "the quarterly figures show revenue climbing twelve percent overall",
            },
            {
                messageId: "msg-b",
                ordinal: 101,
                role: "assistant",
                content: "notes: revenue climbing\ttwelve   percent across all regions",
            },
            {
                messageId: "msg-c",
                ordinal: 102,
                role: "user",
                content: "unrelated deployment checklist for staging",
            },
        ]);
        // Production shape: the registry keys these with the suffixed content
        // key (`:pK`, often K>=1); the mirror keeps bare ids. The geometry must
        // join across the suffix.
        seedTags(db, [
            { tagNumber: 40, messageId: "msg-a:p2", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 41, messageId: "msg-b:p3", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 42, messageId: "msg-c:p1", sessionId: "ses-1", tagType: "message" },
        ]);
    });

    const withWorld = (overrides: { protectedSet?: ReadonlySet<number> } = {}) =>
        createCtxReduceTools({
            db,
            protectedSet: overrides.protectedSet ?? new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
            ordinalMint: () => fakeOrdinalMint(db),
        });

    it("releases the uniquely matched message shell across the key suffix, slot echoes its ordinal", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["unrelated deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 102.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
    });

    it("matches through whitespace variance (mirror collapses, both sides tokenize)", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["revenue climbing twelve percent"] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "revenue climbing twelve percent" provided in ctx_handles was found twice',
        );
        // Candidates are listed in bm25 relevance order, named by context position.
        expect(response).toContain('100: "the quarterly');
        expect(response).toContain('101: "notes:');
        expect(response).toContain("Copy a longer run");
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("ambiguity rejects the whole call, other handles in the same batch unapplied", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["revenue climbing twelve percent", "unrelated deployment"] },
            ctx,
        )) as string;
        expect(response).toContain("was found twice");
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("counts only LIVE matches: a dropped twin leaves a unique winner", async () => {
        seedMessages(db, [
            {
                messageId: "msg-d",
                ordinal: 103,
                role: "user",
                content: "the quarterly figures show revenue climbing twelve percent overall",
            },
        ]);
        seedTags(db, [
            {
                tagNumber: 43,
                messageId: "msg-d:p0",
                sessionId: "ses-1",
                tagType: "message",
                status: "dropped",
            },
        ]);
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["quarterly figures show revenue"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 100.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([40]);
    });

    it("rejects a quote that matches nothing anywhere as broken input", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["purple platypus parliament"] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "purple platypus parliament" provided in ctx_handles was not found: no tool call id and no message text matches it in this session.',
        );
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("diagnoses an out-of-window quote as a noop, not an error", async () => {
        seedMessages(db, [
            {
                messageId: "msg-dead",
                ordinal: 99,
                role: "assistant",
                content: "the archived changelog entry from last release",
            },
        ]);
        seedTags(db, [
            {
                tagNumber: 44,
                messageId: "msg-dead:p1",
                sessionId: "ses-1",
                tagType: "message",
                status: "dropped",
            },
        ]);
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["archived changelog entry"] },
            ctx,
        )) as string;
        expect(response).toBe(
            [
                "All requested tags were already queued or processed. No new action is needed.",
                "ctx_handles: 99.",
                "already released: 99.",
            ].join("\n"),
        );
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("queues a protected message match with the upstream promise line", async () => {
        const tools = withWorld({ protectedSet: new Set<number>([42]) });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toBe(
            [
                "ctx_handles: 102.",
                "deployment checklist provided in ctx_handles is inside the protected working set; it applies once newer work displaces it.",
            ].join("\n"),
        );
        // Upstream semantics: protected drops are queued, applied on displacement.
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
    });

    it("mixes ids and quotes in one array, one applied call, one queued transaction", async () => {
        seedTags(db, [
            { tagNumber: 55, messageId: "call-t", owner: "msg-t", sessionId: "ses-1" },
        ]);
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
            ordinalMint: () => fakeOrdinalMint(db, { "msg-t": 90 }),
        });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-t", "deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 90, 102.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42, 55]);
    });
});

describe("ctx_reduce range lane", () => {
    let db: Database;
    const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

    beforeEach(() => {
        db = createTestDb();
        seedMessages(db, [
            { messageId: "msg-a", ordinal: 10, role: "user", content: "alpha task one" },
            { messageId: "msg-b", ordinal: 11, role: "assistant", content: "beta task two" },
            { messageId: "msg-c", ordinal: 12, role: "assistant", content: "gamma task three" },
        ]);
        // Message shells (suffixed keys) AND their tool calls (wire-id keys)
        // share the span: the inclusive stretch must cross both key domains.
        seedTags(db, [
            { tagNumber: 1, messageId: "msg-a:p1", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 2, messageId: "msg-b:p2", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 3, messageId: "msg-c:p1", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 21, messageId: "call-a", owner: "msg-a", sessionId: "ses-1" },
            { tagNumber: 22, messageId: "call-b", owner: "msg-b", sessionId: "ses-1" },
            { tagNumber: 23, messageId: "call-c", owner: "msg-c", sessionId: "ses-1" },
        ]);
    });

    const withWorld = (overrides: { protectedSet?: ReadonlySet<number> } = {}) =>
        createCtxReduceTools({
            db,
            protectedSet: overrides.protectedSet ?? new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
            ordinalMint: () => fakeOrdinalMint(db),
        });

    it("releases the inclusive stretch between two quote endpoints across key domains, span slot in echo", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["alpha task one..gamma task three"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 10-12.");
        // Inclusive: every registered item in the stretch — message shells via
        // the suffixed key, tool calls via the wire-id map — one event.
        expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 21, 22]);
    });

    it("resolves range endpoints through the id lane too", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a..call-b"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 10-11.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([2, 21, 22]);
    });

    it("resolves a range whose endpoints are different handle kinds", async () => {
        const tools = withWorld();
        // Id start, quote end.
        const forward = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a..gamma task three"] },
            ctx,
        )) as string;
        expect(forward).toBe("ctx_handles: 10-12.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([2, 3, 21, 22]);
    });

    it("resolves a quote-start/id-end range", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["alpha task one..call-b"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 10-11.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 21, 22]);
    });

    it("keeps a literal double-dot as phrase text when the full entry matches", async () => {
        seedMessages(db, [
            {
                messageId: "msg-dot",
                ordinal: 20,
                role: "user",
                content: "the .. marks a path segment in this quote",
            },
        ]);
        seedTags(db, [
            { tagNumber: 8, messageId: "msg-dot:p0", sessionId: "ses-1", tagType: "message" },
        ]);
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["the .. marks a path segment"] },
            ctx,
        )) as string;
        expect(response).toBe("ctx_handles: 20.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([8]);
    });

    it("rejects a reversed range, naming the entry, nothing applied", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["gamma task three..alpha task one"] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "gamma task three..alpha task one" provided in ctx_handles is reversed',
        );
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("a missing range endpoint is the same broken-input class as a missing entry", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["alpha task one..purple platypus"] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "purple platypus" provided in ctx_handles was not found',
        );
        expect(response).toContain('It is the end of the range "alpha task one..purple platypus".');
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("protected items inside a stretch queue deferred with the range promise line", async () => {
        seedMessages(db, [
            {
                messageId: "msg-d",
                ordinal: 13,
                role: "user",
                content: "delta task four",
            },
        ]);
        seedTags(db, [
            {
                tagNumber: 4,
                messageId: "msg-d:p2",
                sessionId: "ses-1",
                tagType: "message",
            },
        ]);
        const tools = withWorld({ protectedSet: new Set<number>([3]) });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["alpha task one..delta task four"] },
            ctx,
        )) as string;
        expect(response).toContain("ctx_handles: 10-13.");
        expect(response).toContain("covers items inside the protected working set");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 4, 21, 22, 23]);
    });

    it("noop facts inside a stretch report ordinals, span slot unchanged", async () => {
        // msg-b's shell already queued: the stretch still spans, the inside
        // noop reports without touching the slot.
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES ('ses-1', 2, 'drop', 1)",
        ).run();
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["alpha task one..gamma task three"] },
            ctx,
        )) as string;
        expect(response).toContain("ctx_handles: 10-12.");
        expect(response).toContain("queued for release: 11.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 21, 22]);
    });

    it("handles array mixes a single entry, a range, and repeats in one positional line", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-b", "alpha task one..gamma task three"] },
            ctx,
        )) as string;
        // Positional mirror: entry 1 is the single id (ordinal 11), entry 2 the span.
        expect(response).toContain("ctx_handles: 11, 10-12.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 21, 22]);
    });
});

describe("ctx_reduce bulk default", () => {
    let db: Database;
    const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

    // Production tool-row shape: message_id = wire call id, owner = bare
    // positioned message.
    const seedTool = (
        tagNumber: number,
        callId: string,
        owner: string,
        opts: { tokens?: number; status?: string } = {},
    ) => {
        db.prepare(
            "INSERT INTO tags (message_id, type, status, tool_owner_message_id, byte_size, session_id, tag_number, token_count) VALUES (?, 'tool', 'active', ?, 100, 'ses-1', ?, ?)",
        ).run(callId, owner, tagNumber, opts.tokens ?? null);
    };

    beforeEach(() => {
        db = createTestDb();
        seedMessages(db, [
            { messageId: "u-old", ordinal: 10, role: "user", content: "first task" },
            { messageId: "u-new", ordinal: 200, role: "user", content: "newest instruction" },
            { messageId: "t-mid", ordinal: 50, role: "assistant", content: "worked on it" },
            { messageId: "t-live", ordinal: 210, role: "assistant", content: "current turn" },
        ]);
        seedTool(60, "call-x", "t-mid"); // consumed, unsized => releases
        seedTool(61, "call-y", "t-live"); // after newest user message => never bulk
        seedTool(62, "call-z", "t-mid", { tokens: 5 }); // under the token floor => stays
        seedTool(63, "call-w", "t-mid", { tokens: 900 });
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES ('ses-1', 63, 'drop', 1)",
        ).run();
    });

    const withWorld = (overrides: { protectedSet?: ReadonlySet<number> } = {}) =>
        createCtxReduceTools({
            db,
            protectedSet: overrides.protectedSet ?? new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
            // The mint owns the bulk boundary: newest user message, live space.
            ordinalMint: () => fakeOrdinalMint(db, {}, 200),
        });

    it("releases only consumed tool tags past the floor and before the newest user message", async () => {
        const tools = withWorld();
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("released everything responded past: 50.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([60, 63]);
    });

    it("holds a protected consumed tag instead of releasing it", async () => {
        const tools = withWorld({ protectedSet: new Set<number>([60]) });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).not.toContain("released everything");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
    });

    it("reports nothing-to-release when only protected work is left", async () => {
        const tools = withWorld({ protectedSet: new Set<number>([60]) });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("Nothing older to release");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
    });

    it("without a newest user message nothing has been responded past: nothing bulk-released", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
            ordinalMint: () => fakeOrdinalMint(db, {}, undefined),
        });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("Nothing to release");
        // Only the pre-seeded pending op remains; nothing new was queued.
        expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
    });
});
