/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
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

    it("resolves copied call ids, releases the live ones in input order, reports the rest", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>([9]) });
        const response = (await tools.ctx_reduce!.execute(
            { ids: ["call-a", "call-b", "nope-1", "call-d", "call-e", "call-c"] },
            ctx,
        )) as string;

        expect(response).toContain("Released: msg-5, msg-7.");
        expect(response).toContain("Already released: 1");
        expect(response).toContain("Unknown: 2");
        expect(response).toContain("Held: 1");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7]);
    });

    it("is idempotent: re-sent ids report already released and queue nothing new", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        await tools.ctx_reduce!.execute({ ids: ["call-a"] }, ctx);
        const before = pendingTagNumbers(db, "ses-1");
        const response = (await tools.ctx_reduce!.execute({ ids: ["call-a"] }, ctx)) as string;
        expect(response).toContain("Already released: 1");
        expect(response).not.toContain("Released: msg");
        expect(pendingTagNumbers(db, "ses-1")).toEqual(before);
    });

    it("deduplicates repeated ids to one released echo and one queued op", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { ids: ["call-a", "call-a"] },
            ctx,
        )) as string;
        expect(response).toBe("Released: msg-5.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([5]);
    });

    it("treats a foreign-session id as unknown, never a foreign release", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute({ ids: ["call-e"] }, ctx)) as string;
        expect(response).toContain("Unknown: 1");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        expect(pendingTagNumbers(db, "ses-2")).toEqual([]);
    });

    it("refuses a corrupt duplicate registry entry as unknown", async () => {
        seedTags(db, [
            { tagNumber: 21, messageId: "msg-21b", sessionId: "ses-1", contentId: "call-b" },
        ]);
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute({ ids: ["call-b"] }, ctx)) as string;
        expect(response).toContain("Unknown: 1");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("rejects mixing ids with the legacy drop grammar", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { ids: ["call-a"], drop: "7" },
            ctx,
        )) as string;
        expect(response).toContain("cannot be combined");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("requires at least one pointing array", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute({}, ctx)) as string;
        expect(response).toContain("'ids', 'samples', or 'drop' must be provided");
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
        });

        queued = 2;
        const first = (await tools.ctx_reduce!.execute(
            { ids: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(received).toBe("5,7");
        expect(first).toContain("Released: msg-5, msg-7.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);

        queued = 0;
        const second = (await tools.ctx_reduce!.execute(
            { ids: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(second).not.toContain("Released: msg");
        expect(second).toContain("Already released: 2");
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
        });
        const response = (await tools.ctx_reduce!.execute({ ids: ["call-a"] }, ctx)) as string;
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
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { samples: ["unrelated deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toContain("Released from samples: msg-c.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
    });

    it("matches through whitespace variance (mirror collapses, both sides tokenize)", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { samples: ["revenue climbing twelve percent"] },
            ctx,
        )) as string;
        expect(response).toContain("Ambiguous");
        expect(response).toContain("msg-a");
        expect(response).toContain("msg-b");
        expect(response).toContain("Copy a longer run");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("ambiguity rejects the whole call, including ids in the same batch", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { samples: ["revenue climbing twelve percent"], ids: ["call-x"] },
            { sessionID: "ses-1", directory: "/tmp" } as never,
        )) as string;
        expect(response).toContain("Ambiguous");
        expect(response).toContain("nothing was released");
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
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { samples: ["quarterly figures show revenue"] },
            ctx,
        )) as string;
        expect(response).toContain("Released from samples: msg-a.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([40]);
    });

    it("reports no-match without touching anything else", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { samples: ["purple platypus parliament"], ids: [] },
            ctx,
        )) as string;
        expect(response).toContain("No match: 1");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("holds a protected message match with displacement timing", async () => {
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>([42]) });
        const response = (await tools.ctx_reduce!.execute(
            { samples: ["deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toContain("Held: 1");
        expect(response).not.toContain("Released from samples");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("mixes ids and samples in one applied call, one queued transaction", async () => {
        seedTags(db, [
            { tagNumber: 55, messageId: "msg-t", sessionId: "ses-1", contentId: "call-t" },
        ]);
        const tools = createCtxReduceTools({ db, protectedSet: new Set<number>() });
        const response = (await tools.ctx_reduce!.execute(
            { ids: ["call-t"], samples: ["deployment checklist"] },
            ctx,
        )) as string;
        expect(response).toContain("Released: msg-t.");
        expect(response).toContain("Released from samples: msg-c.");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([42, 55]);
    });
});
