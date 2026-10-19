/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { OrdinalMint } from "../../features/magic-context/reduce-resolver";
import {
    type CallIdTagResolver,
    createRegistryCallIdResolver,
} from "../../features/magic-context/tool-call-registry";
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
 * be the seeded geometry. Resolution runs the real createRegistryCallIdResolver
 * (the production path), on top of that geometry.
 *
 * Every case runs on the parameterized `buildWorld` (rows spec -> exactly
 * that geometry) and the `runTable` driver; table rows are
 * [name, execute args, world overrides, response assertions].
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

function pendingTagNumbers(db: Database, sessionId: string): number[] {
    return (
        db
            .prepare(
                "SELECT tag_id FROM pending_ops WHERE session_id = ? AND operation = 'drop' ORDER BY tag_id ASC",
            )
            .all(sessionId) as Array<{ tag_id: number }>
    ).map((row) => row.tag_id);
}

/** FTS mirror row; `tag` seeds the shell with the suffixed `base:pK` registry key. */
type MsgRow = { id: string; ordinal: number; role: string; content: string; tag?: number; part?: number; status?: string; session?: string };
/** Tool row in the production shape: message_id = wire call id, owner = bare message. */
type ToolRow = { tag: number; callId: string; owner: string; status?: string; tokens?: number | null; session?: string };
/** Rows spec + DI boundaries for the parameterized production-key world. */
type WorldSpec = { messages?: MsgRow[]; tools?: ToolRow[]; mintExtra?: Record<string, number>; latestUserOrdinal?: number; prequeued?: number[]; protectedSet?: ReadonlySet<number>; resolver?: CallIdTagResolver; rustToolBackends?: RustToolBackends };
/** Table case: [name, execute args, world overrides over the lane seed, response assertions]. */
type Case = [name: string, args: Record<string, unknown>, world: WorldSpec, run: (response: string, db: Database) => void];

const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

function mergeWorld(base: WorldSpec, over: WorldSpec): WorldSpec {
    return {
        messages: [...(base.messages ?? []), ...(over.messages ?? [])],
        tools: [...(base.tools ?? []), ...(over.tools ?? [])],
        prequeued: [...(base.prequeued ?? []), ...(over.prequeued ?? [])],
        mintExtra: { ...base.mintExtra, ...over.mintExtra },
        latestUserOrdinal: "latestUserOrdinal" in over ? over.latestUserOrdinal : base.latestUserOrdinal,
        protectedSet: over.protectedSet ?? base.protectedSet,
        resolver: over.resolver ?? base.resolver,
        rustToolBackends: over.rustToolBackends ?? base.rustToolBackends,
    };
}

/**
 * The single parameterized world: seeds the production key geometry — FTS
 * mirror rows (bare ids), message shells as `base:pK` tags, tool tags keyed
 * by wire call id with the bare owner id, pre-queued drop ops, mint
 * boundary — and wires the DI fakes onto a fresh db.
 */
function buildWorld(spec: WorldSpec): { db: Database; tools: ReturnType<typeof createCtxReduceTools> } {
    const db = createTestDb();
    seedMessages(db, (spec.messages ?? []).map((m) => ({ messageId: m.id, ordinal: m.ordinal, role: m.role, content: m.content, sessionId: m.session })));
    seedTags(db, [
        ...(spec.messages ?? []).filter((m) => m.tag !== undefined).map((m) => ({
            tagNumber: m.tag as number, messageId: `${m.id}:p${m.part ?? 0}`, sessionId: m.session ?? "ses-1", tagType: "message" as const, status: m.status,
        })),
        ...(spec.tools ?? []).map((t) => ({
            tagNumber: t.tag, messageId: t.callId, owner: t.owner, sessionId: t.session ?? "ses-1", status: t.status, tokens: t.tokens,
        })),
    ]);
    for (const tagId of spec.prequeued ?? []) {
        db.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES ('ses-1', ?, 'drop', 1)").run(tagId);
    }
    return {
        db,
        tools: createCtxReduceTools({
            db,
            protectedSet: spec.protectedSet ?? new Set<number>(),
            callIdResolver: spec.resolver ?? createRegistryCallIdResolver(db, "ses-1"),
            ordinalMint: () => fakeOrdinalMint(db, spec.mintExtra ?? {}, spec.latestUserOrdinal),
            rustToolBackends: spec.rustToolBackends,
        }),
    };
}

function runTable(seed: WorldSpec, cases: Case[]) {
    for (const [name, args, world, run] of cases) {
        it(name, async () => {
            const { db, tools } = buildWorld(mergeWorld(seed, world));
            const response = (await tools.ctx_reduce!.execute(args as never, ctx)) as string;
            run(response, db);
        });
    }
}

describe("ctx_reduce handles lane (ids)", () => {
    // Lane seed: tool rows keyed by wire call id (bare owners), message
    // positions supplied by the mint's extra map — no FTS rows in this lane.
    const IDS_SEED: WorldSpec = {
        tools: [
            { tag: 5, callId: "call-a", owner: "msg-5" },
            { tag: 7, callId: "call-b", owner: "msg-7" },
            { tag: 9, callId: "call-c", owner: "msg-9" },
            { tag: 11, callId: "call-d", owner: "msg-11", status: "dropped" },
            { tag: 3, callId: "call-e", owner: "msg-3", session: "ses-2" },
        ],
        mintExtra: { "msg-5": 5, "msg-7": 7, "msg-9": 9, "msg-11": 11, "msg-3": 3 },
    };

    runTable(IDS_SEED, [
        ["resolves copied call ids, echoes ordinals in input order, reports noop facts outside", { ctx_handles: ["call-a", "call-b", "call-d", "call-c"] }, { protectedSet: new Set<number>([9]) }, (response, db) => {
            expect(response).toContain("ctx_handles: 5, 7, 11, 9");
            expect(response).toContain("already cleared: 11");
            expect(response).toContain(
                "call-c provided in ctx_handles is inside the protected working set; it applies once newer work displaces it.",
            );
            // Protected items are queued deferred (upstream semantics), not refused.
            expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
        }],
        ["keeps positional slots for repeated ids: same ordinal per slot, one queued op", { ctx_handles: ["call-a", "call-a"] }, {}, (response, db) => {
            expect(response).toBe("ctx_handles: 5, 5");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([5]);
        }],
        ["rejects a foreign-session id as broken input, never a foreign release", { ctx_handles: ["call-e"] }, {}, (response, db) => {
            expect(response).toContain(
                'error: "call-e" provided in ctx_handles was not found: no tool call id and no message text matches it in your current context window.',
            );
            expect(response).toContain("Nothing was stamped; resend the corrected batch.");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            expect(pendingTagNumbers(db, "ses-2")).toEqual([]);
        }],
        ["rejects the whole batch when the bridge cannot pair one id, valid siblings unapplied", { ctx_handles: ["call-b", "call-a"] }, { resolver: { resolve: () => new Map() } }, (response, db) => {
            expect(response).toContain('error: "call-b" provided in ctx_handles was not found');
            expect(response).not.toContain("ctx_handles: 7");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        }],
        ["error shape never coexists with success lines", { ctx_handles: ["call-a", "nope-1"] }, {}, (response, db) => {
            expect(response).toContain('error: "nope-1" provided in ctx_handles was not found');
            // The valid sibling is NOT applied: the corrected resend applies all slots.
            expect(response).not.toContain("ctx_handles: 5");
            expect(response).not.toContain("already released");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        }],
        ["rejects mixing handles with the legacy drop grammar", { ctx_handles: ["call-a"], drop: "7" }, {}, (response, db) => {
            expect(response).toContain("cannot be combined");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        }],
        ["no-arg invocation releases the bulk default set", {}, { latestUserOrdinal: 11 }, (response, db) => {
            expect(response).toContain("stamped everything you've responded past: 5, 7, 9");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
        }],
        ["refuses capability when the module backend throws", { ctx_handles: ["call-a"] }, { rustToolBackends: { reduce: (async () => { throw new Error("module down"); }) as unknown as RustToolBackends["reduce"] } }, (response, db) => {
            expect(response).toContain("cleanup");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        }],
    ]);

    it("is idempotent: re-sent ids report the queued noop and queue nothing new", async () => {
        const { db, tools } = buildWorld(IDS_SEED);
        await tools.ctx_reduce!.execute({ ctx_handles: ["call-a"] }, ctx);
        const before = pendingTagNumbers(db, "ses-1");
        const response = (await tools.ctx_reduce!.execute({ ctx_handles: ["call-a"] }, ctx)) as string;
        expect(response).toBe(
            [
                "All requested tags were already queued or processed. No new action is needed.",
                "ctx_handles: 5",
                "stamped, waiting for the sweep: 5",
            ].join("\n"),
        );
        expect(pendingTagNumbers(db, "ses-1")).toEqual(before);
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
        const { db, tools } = buildWorld({ ...IDS_SEED, rustToolBackends });

        queued = 2;
        const first = (await tools.ctx_reduce!.execute({ ctx_handles: ["call-a", "call-b"] }, ctx)) as string;
        expect(received).toBe("5,7");
        expect(first).toBe("ctx_handles: 5, 7");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);

        queued = 0;
        const second = (await tools.ctx_reduce!.execute({ ctx_handles: ["call-a", "call-b"] }, ctx)) as string;
        expect(second).toContain("already cleared: 5, 7");
        expect(second).toContain("ctx_handles: 5, 7");
    });
});

describe("ctx_reduce handles lane (quotes)", () => {
    // Production shape: the registry keys the shells with the suffixed
    // content key (`:pK`, often K>=1); the mirror keeps bare ids. The
    // geometry must join across the suffix.
    runTable(
        {
            messages: [
                { id: "msg-a", ordinal: 100, role: "user", tag: 40, part: 2, content: "the quarterly figures show revenue climbing twelve percent overall" },
                { id: "msg-b", ordinal: 101, role: "assistant", tag: 41, part: 3, content: "notes: revenue climbing\ttwelve   percent across all regions" },
                { id: "msg-c", ordinal: 102, role: "user", tag: 42, part: 1, content: "unrelated deployment checklist for staging" },
            ],
        },
        [
            ["releases the uniquely matched message shell across the key suffix, slot echoes its ordinal", { ctx_handles: ["unrelated deployment checklist"] }, {}, (response, db) => {
                expect(response).toBe("ctx_handles: 102");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
            }],
            ["matches through whitespace variance (mirror collapses, both sides tokenize)", { ctx_handles: ["revenue climbing twelve percent"] }, {}, (response, db) => {
                expect(response).toContain(
                    'error: "revenue climbing twelve percent" provided in ctx_handles was found twice',
                );
                // Candidates are listed in bm25 relevance order, named by context position.
                expect(response).toContain('100: "the quarterly');
                expect(response).toContain('101: "notes:');
                expect(response).toContain("Copy a longer run");
                expect(response).toContain("Nothing was stamped; resend the corrected batch.");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            }],
            ["ambiguity rejects the whole call, other handles in the same batch unapplied", { ctx_handles: ["revenue climbing twelve percent", "unrelated deployment"] }, {}, (response, db) => {
                expect(response).toContain("was found twice");
                expect(response).toContain("Nothing was stamped; resend the corrected batch.");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            }],
            ["counts only LIVE matches: a dropped twin leaves a unique winner", { ctx_handles: ["quarterly figures show revenue"] }, { messages: [{ id: "msg-d", ordinal: 103, role: "user", tag: 43, part: 0, status: "dropped", content: "the quarterly figures show revenue climbing twelve percent overall" }] }, (response, db) => {
                expect(response).toBe("ctx_handles: 100");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([40]);
            }],
            ["rejects a quote that matches nothing anywhere as broken input", { ctx_handles: ["purple platypus parliament"] }, {}, (response, db) => {
                expect(response).toContain(
                    'error: "purple platypus parliament" provided in ctx_handles was not found: no tool call id and no message text matches it in your current context window.',
                );
                expect(response).toContain("Nothing was stamped; resend the corrected batch.");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            }],
            ["diagnoses an out-of-window quote as a noop, not an error", { ctx_handles: ["archived changelog entry"] }, { messages: [{ id: "msg-dead", ordinal: 99, role: "assistant", tag: 44, part: 1, status: "dropped", content: "the archived changelog entry from last release" }] }, (response, db) => {
                expect(response).toBe(
                    [
                        "All requested tags were already queued or processed. No new action is needed.",
                        "ctx_handles: 99",
                        "already cleared: 99",
                    ].join("\n"),
                );
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            }],
            ["queues a protected message match with the upstream promise line", { ctx_handles: ["deployment checklist"] }, { protectedSet: new Set<number>([42]) }, (response, db) => {
                expect(response).toBe(
                    [
                        "ctx_handles: 102",
                        "deployment checklist provided in ctx_handles is inside the protected working set; it applies once newer work displaces it.",
                    ].join("\n"),
                );
                // Upstream semantics: protected drops are queued, applied on displacement.
                expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
            }],
            ["mixes ids and quotes in one array, one applied call, one queued transaction", { ctx_handles: ["call-t", "deployment checklist"] }, { tools: [{ tag: 55, callId: "call-t", owner: "msg-t" }], mintExtra: { "msg-t": 90 } }, (response, db) => {
                expect(response).toBe("ctx_handles: 90, 102");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([42, 55]);
            }],
        ],
    );
});

describe("ctx_reduce range lane", () => {
    // Lane seed: message shells (suffixed keys) AND their tool calls
    // (wire-id keys) sit in disjoint tag bands — the stretch is a
    // registration span (D18), so bands resolve independently.
    const RANGE_SEED: WorldSpec = {
        messages: [
            { id: "msg-a", ordinal: 10, role: "user", content: "alpha task one", tag: 1, part: 1 },
            { id: "msg-b", ordinal: 11, role: "assistant", content: "beta task two", tag: 2, part: 2 },
            { id: "msg-c", ordinal: 12, role: "assistant", content: "gamma task three", tag: 3, part: 1 },
        ],
        tools: [
            { tag: 21, callId: "call-a", owner: "msg-a" },
            { tag: 22, callId: "call-b", owner: "msg-b" },
            { tag: 23, callId: "call-c", owner: "msg-c" },
        ],
    };

    runTable(RANGE_SEED, [
        ["releases the inclusive stretch between two quote endpoints across key domains, span slot in echo", { ctx_handles: ["alpha task one..gamma task three"] }, {}, (response, db) => {
            expect(response).toBe("ctx_handles: 10-12");
            // Registration span 1..3: the tag band, one event.
            expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3]);
        }],
        ["resolves range endpoints through the id lane too", { ctx_handles: ["call-a..call-b"] }, {}, (response, db) => {
            expect(response).toBe("ctx_handles: 10-11");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([21, 22]);
        }],
        ["resolves a range whose endpoints are different handle kinds", { ctx_handles: ["call-a..gamma task three"] }, {}, (response, db) => {
            expect(response).toBe("ctx_handles: 10-12");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([3, 21]);
        }],
        ["resolves a quote-start/id-end range", { ctx_handles: ["alpha task one..call-b"] }, {}, (response, db) => {
            expect(response).toBe("ctx_handles: 10-11");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 21, 22]);
        }],
        ["keeps a literal double-dot as phrase text when the full entry matches", { ctx_handles: ["the .. marks a path segment"] }, { messages: [{ id: "msg-dot", ordinal: 20, role: "user", content: "the .. marks a path segment in this quote", tag: 8, part: 0 }] }, (response, db) => {
            expect(response).toBe("ctx_handles: 20");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([8]);
        }],
        ["treats a reversed-written range as the same span (direction is irrelevant)", { ctx_handles: ["gamma task three..alpha task one"] }, {}, (response, db) => {
            expect(response).toBe("ctx_handles: 12-10");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3]);
        }],
        ["a missing range endpoint is the same broken-input class as a missing entry", { ctx_handles: ["alpha task one..purple platypus"] }, {}, (response, db) => {
            expect(response).toContain('error: "purple platypus" provided in ctx_handles was not found');
            expect(response).toContain('It is the end of the range "alpha task one..purple platypus".');
            expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        }],
        ["protected items inside a stretch queue deferred with the range promise line", { ctx_handles: ["alpha task one..delta task four"] }, { messages: [{ id: "msg-d", ordinal: 13, role: "user", content: "delta task four", tag: 4, part: 2 }], protectedSet: new Set<number>([3]) }, (response, db) => {
            expect(response).toContain("ctx_handles: 10-13");
            expect(response).toContain("covers items inside the protected working set");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 4]);
        }],
        // msg-b's shell already queued (pre-queued op): the stretch still
        // spans, the inside noop reports without touching the slot.
        ["noop facts inside a stretch report ordinals, span slot unchanged", { ctx_handles: ["alpha task one..gamma task three"] }, { prequeued: [2] }, (response, db) => {
            expect(response).toContain("ctx_handles: 10-12");
            expect(response).toContain("stamped, waiting for the sweep: 11");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3]);
        }],
        ["handles array mixes a single entry, a range, and repeats in one positional line", { ctx_handles: ["call-b", "alpha task one..gamma task three"] }, {}, (response, db) => {
            // Positional mirror: entry 1 is the single id (ordinal 11), entry 2 the span.
            expect(response).toContain("ctx_handles: 11, 10-12");
            expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 22]);
        }],
    ]);
});

describe("ctx_reduce bulk default", () => {
    // Lane seed (production tool-row shape: message_id = wire call id,
    // owner = bare positioned message). The mint owns the bulk boundary:
    // newest user message, live space.
    runTable(
        {
            messages: [
                { id: "u-old", ordinal: 10, role: "user", content: "first task" },
                { id: "u-new", ordinal: 200, role: "user", content: "newest instruction" },
                { id: "t-mid", ordinal: 50, role: "assistant", content: "worked on it" },
                { id: "t-live", ordinal: 210, role: "assistant", content: "current turn" },
            ],
            tools: [
                { tag: 60, callId: "call-x", owner: "t-mid" }, // consumed, unsized => releases
                { tag: 61, callId: "call-y", owner: "t-live" }, // after newest user => never bulk
                { tag: 62, callId: "call-z", owner: "t-mid", tokens: 5 }, // under the floor => stays
                { tag: 63, callId: "call-w", owner: "t-mid", tokens: 900 },
            ],
            prequeued: [63],
            latestUserOrdinal: 200,
        },
        [
            ["releases only consumed tool tags past the floor and before the newest user message", {}, {}, (response, db) => {
                expect(response).toContain("stamped everything you've responded past: 50");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([60, 63]);
            }],
            ["holds a protected consumed tag instead of releasing it", {}, { protectedSet: new Set<number>([60]) }, (response, db) => {
                expect(response).not.toContain("released everything");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
            }],
            ["reports nothing-to-release when only protected work is left", {}, { protectedSet: new Set<number>([60]) }, (response, db) => {
                expect(response).toContain("Nothing older to release");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
            }],
            ["without a newest user message nothing has been responded past: nothing bulk-released", {}, { latestUserOrdinal: undefined }, (response, db) => {
                expect(response).toContain("Nothing to release");
                // Only the pre-seeded pending op remains; nothing new was queued.
                expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
            }],
        ],
    );
});
