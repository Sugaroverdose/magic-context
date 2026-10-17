/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { CallIdTagResolver } from "../../features/magic-context/tag-call-bridge";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { Database } from "../../shared/sqlite";
import { createCtxReduceTools } from "./tools";

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
    messageId: string;
    sessionId: string;
    contentId?: string;
    status?: string;
    tagType?: "message" | "tool";
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
            "INSERT INTO tags (message_id, type, status, content_id, byte_size, session_id, tag_number) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ).run(
            tag.messageId,
            tag.tagType ?? "tool",
            tag.status ?? "active",
            tag.contentId ?? null,
            100,
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
 * DI fake for the call-id bridge: the unit tests' tags table carries a
 * content_id column as the fake world's registry key. The production bridge
 * (host-store rank pairing) is covered against a host-shaped store in
 * tag-call-bridge.test.ts, not here.
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
                        "SELECT tag_number, message_id, status, type FROM tags WHERE session_id = ? AND content_id = ? AND content_id IS NOT NULL LIMIT 1",
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

describe("ctx_reduce ids lane", () => {
    let db: Database;
    const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

    const seed = (d: Database) =>
        seedTags(d, [
            { tagNumber: 5, messageId: "msg-5", sessionId: "ses-1", contentId: "call-a" },
            { tagNumber: 7, messageId: "msg-7", sessionId: "ses-1", contentId: "call-b" },
            { tagNumber: 9, messageId: "msg-9", sessionId: "ses-1", contentId: "call-c" },
            {
                tagNumber: 11,
                messageId: "msg-11",
                sessionId: "ses-1",
                contentId: "call-d",
                status: "dropped",
            },
            { tagNumber: 3, messageId: "msg-3", sessionId: "ses-2", contentId: "call-e" },
        ]);

    beforeEach(() => {
        db = createTestDb();
        seed(db);
    });

    it("resolves copied call ids, mirrors slots in input order, reports noop facts outside", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>([9]),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a", "call-b", "call-d", "call-c"] },
            ctx,
        )) as string;

        expect(response).toContain("toolcall_ids: 5, 7, 11, 9.");
        expect(response).toContain("already released: 11.");
        expect(response).toContain(
            "call-c provided in toolcall_ids is inside the protected working set; it applies once newer work displaces it.",
        );
        // Protected items are queued deferred (upstream semantics), not refused.
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
    });

    it("is idempotent: re-sent ids report the queued noop and queue nothing new", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        await tools.ctx_reduce!.execute({ toolcall_ids: ["call-a"] }, ctx);
        const before = pendingTagNumbers(db, "ses-1");
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a"] },
            ctx,
        )) as string;
        expect(response).toBe(
            [
                "All requested tags were already queued or processed. No new action is needed.",
                "toolcall_ids: 5.",
                "queued for release: 5.",
            ].join("\n"),
        );
        expect(pendingTagNumbers(db, "ses-1")).toEqual(before);
    });

    it("keeps positional slots for repeated ids: same tag per slot, one queued op", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a", "call-a"] },
            ctx,
        )) as string;
        expect(response).toBe("toolcall_ids: 5, 5.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5]);
    });

    it("rejects a foreign-session id as broken input, never a foreign release", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-e"] },
            ctx,
        )) as string;
        expect(response).toContain(
            "error: call-e provided in toolcall_ids was not found: no tool call with this id exists in this session.",
        );
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        expect(pendingTagNumbers(db, "ses-2")).toEqual([]);
    });

    it("rejects the whole batch when the bridge cannot pair one id, valid siblings unapplied", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: { resolve: () => new Map() },
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-b"] },
            ctx,
        )) as string;
        expect(response).toContain("error: call-b provided in toolcall_ids was not found");
        expect(response).not.toContain("toolcall_ids:");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("error shape never coexists with success lines", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a", "nope-1"] },
            ctx,
        )) as string;
        expect(response).toContain("error: nope-1 provided in toolcall_ids was not found");
        // The valid sibling is NOT applied: the corrected resend applies all slots.
        expect(response).not.toContain("toolcall_ids:");
        expect(response).not.toContain("already released");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("rejects mixing ids with the legacy drop grammar", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a"], drop: "7" },
            ctx,
        )) as string;
        expect(response).toContain("cannot be combined");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("no-arg invocation releases the bulk default set", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
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
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            rustToolBackends,
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });

        queued = 2;
        const first = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(received).toBe("5,7");
        expect(first).toBe("toolcall_ids: 5, 7.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);

        queued = 0;
        const second = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(second).toContain("already released: 5, 7.");
        expect(second).toContain("toolcall_ids: 5, 7.");
    });

    it("refuses capability when the module backend throws", async () => {
        const rustToolBackends = {
            reduce: (async () => {
                throw new Error("module down");
            }) as unknown as RustToolBackends["reduce"],
        };
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            rustToolBackends,
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-a"] },
            ctx,
        )) as string;
        expect(response).toContain("cleanup");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });
});

describe("ctx_reduce samples lane", () => {
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
        seedTags(db, [
            { tagNumber: 40, messageId: "msg-a", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 41, messageId: "msg-b", sessionId: "ses-1", tagType: "message" },
            { tagNumber: 42, messageId: "msg-c", sessionId: "ses-1", tagType: "message" },
        ]);
    });

    it("releases the uniquely matched message shell via its echoed handle", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["unrelated deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toBe("msg_samples: 42.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
    });

    it("matches through whitespace variance (mirror collapses, both sides tokenize)", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["revenue climbing twelve percent"] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "revenue climbing twelve percent" provided in msg_samples was found twice',
        );
        // Candidates are listed in bm25 relevance order, not tag order.
        expect(response).toContain("Candidates: 4");
        expect(response).toContain('40: "the quarterly');
        expect(response).toContain('41: "notes:');
        expect(response).toContain("Copy a longer run");
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("ambiguity rejects the whole call, including ids in the same batch", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["revenue climbing twelve percent"], toolcall_ids: ["call-x"] },
            { sessionID: "ses-1", directory: "/tmp" } as never,
        )) as string;
        expect(response).toContain("was found twice");
        // The samples-lane ambiguity names itself; the batch never applies.
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
                messageId: "msg-d",
                sessionId: "ses-1",
                tagType: "message",
                status: "dropped",
            },
        ]);
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["quarterly figures show revenue"] },
            ctx,
        )) as string;
        expect(response).toBe("msg_samples: 40.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([40]);
    });

    it("rejects a sample that matches nothing anywhere as broken input", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["purple platypus parliament"], toolcall_ids: [] },
            ctx,
        )) as string;
        expect(response).toContain(
            'error: "purple platypus parliament" provided in msg_samples was not found: this text exists nowhere in this session.',
        );
        expect(response).toContain("Nothing was released; resend the corrected batch.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("diagnoses an out-of-window sample as a noop, not an error", async () => {
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
                messageId: "msg-dead",
                sessionId: "ses-1",
                tagType: "message",
                status: "dropped",
            },
        ]);
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["archived changelog entry"] },
            ctx,
        )) as string;
        expect(response).toBe(
            [
                "All requested tags were already queued or processed. No new action is needed.",
                "msg_samples: 44.",
                "already released: 44.",
            ].join("\n"),
        );
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("queues a protected message match with the upstream promise line", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>([42]),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { msg_samples: ["deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toBe(
            [
                "msg_samples: 42.",
                '"deployment checklist" provided in msg_samples is inside the protected working set; it applies once newer work displaces it.',
            ].join("\n"),
        );
        // Upstream semantics: protected drops are queued, applied on displacement.
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
    });

    it("mixes ids and samples in one applied call, one queued transaction", async () => {
        seedTags(db, [
            { tagNumber: 55, messageId: "msg-t", sessionId: "ses-1", contentId: "call-t" },
        ]);
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute(
            { toolcall_ids: ["call-t"], msg_samples: ["deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toBe(["toolcall_ids: 55.", "msg_samples: 42."].join("\n"));
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42, 55]);
    });
});

describe("ctx_reduce bulk default", () => {
    let db: Database;
    const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

    const seedTool = (
        tagNumber: number,
        messageId: string,
        opts: { tokens?: number; status?: string } = {},
    ) => {
        db.prepare(
            "INSERT INTO tags (message_id, type, status, byte_size, session_id, tag_number, token_count) VALUES (?, 'tool', 'active', ?, 'ses-1', ?, ?)",
        ).run(messageId, 100, tagNumber, opts.tokens ?? null);
    };

    beforeEach(() => {
        db = createTestDb();
        seedMessages(db, [
            { messageId: "u-old", ordinal: 10, role: "user", content: "first task" },
            { messageId: "u-new", ordinal: 200, role: "user", content: "newest instruction" },
            { messageId: "t-mid", ordinal: 50, role: "assistant", content: "worked on it" },
            { messageId: "t-live", ordinal: 210, role: "assistant", content: "current turn" },
        ]);
        seedTool(60, "t-mid"); // consumed, unsized => releases
        seedTool(61, "t-live"); // after newest user message => never bulk
        seedTool(62, "t-mid", { tokens: 5 }); // under the token floor => stays
        db.prepare(
            "INSERT INTO tags (message_id, type, status, byte_size, session_id, tag_number, token_count) VALUES ('t-mid', 'tool', 'active', 100, 'ses-1', 63, 900)",
        ).run();
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES ('ses-1', 63, 'drop', 1)",
        ).run();
    });

    it("releases only consumed tool tags past the floor and before the newest user message", async () => {
        const tools = createCtxReduceTools({
            db,
            protectedSet: new Set<number>(),
            callIdResolver: fakeCallIdResolver(db, "ses-1"),
        });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("released everything responded past: 60.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([60, 63]);
    });

    it("holds a protected consumed tag instead of releasing it", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>([60]) });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).not.toContain("released everything");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
    });

    it("reports nothing-to-release when only protected work is left", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>([60]) });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("Nothing older to release");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
    });
});
