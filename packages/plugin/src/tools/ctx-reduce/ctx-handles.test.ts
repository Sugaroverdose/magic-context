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
type MsgRow = {
    id: string;
    ordinal: number;
    role: string;
    content: string;
    tag?: number;
    part?: number;
    status?: string;
    session?: string;
};
/** Tool row in the production shape: message_id = wire call id, owner = bare message. */
type ToolRow = {
    tag: number;
    callId: string;
    owner: string;
    status?: string;
    tokens?: number | null;
    session?: string;
};
/** Rows spec + DI boundaries for the parameterized production-key world. */
type WorldSpec = {
    messages?: MsgRow[];
    tools?: ToolRow[];
    mintExtra?: Record<string, number>;
    latestUserOrdinal?: number;
    prequeued?: number[];
    protectedSet?: ReadonlySet<number>;
    resolver?: CallIdTagResolver;
    rustToolBackends?: RustToolBackends;
};
/** Table case: [name, execute args, world overrides over the lane seed, response assertions]. */
type Case = [
    name: string,
    args: Record<string, unknown>,
    world: WorldSpec,
    run: (response: string, db: Database) => void,
];

const ctx = { sessionID: "ses-1", directory: "/tmp" } as never;

function mergeWorld(base: WorldSpec, over: WorldSpec): WorldSpec {
    return {
        messages: [...(base.messages ?? []), ...(over.messages ?? [])],
        tools: [...(base.tools ?? []), ...(over.tools ?? [])],
        prequeued: [...(base.prequeued ?? []), ...(over.prequeued ?? [])],
        mintExtra: { ...base.mintExtra, ...over.mintExtra },
        latestUserOrdinal:
            "latestUserOrdinal" in over ? over.latestUserOrdinal : base.latestUserOrdinal,
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
function buildWorld(spec: WorldSpec): {
    db: Database;
    tools: ReturnType<typeof createCtxReduceTools>;
} {
    const db = createTestDb();
    seedMessages(
        db,
        (spec.messages ?? []).map((m) => ({
            messageId: m.id,
            ordinal: m.ordinal,
            role: m.role,
            content: m.content,
            sessionId: m.session,
        })),
    );
    seedTags(db, [
        ...(spec.messages ?? [])
            .filter((m) => m.tag !== undefined)
            .map((m) => ({
                tagNumber: m.tag as number,
                messageId: `${m.id}:p${m.part ?? 0}`,
                sessionId: m.session ?? "ses-1",
                tagType: "message" as const,
                status: m.status,
            })),
        ...(spec.tools ?? []).map((t) => ({
            tagNumber: t.tag,
            messageId: t.callId,
            owner: t.owner,
            sessionId: t.session ?? "ses-1",
            status: t.status,
            tokens: t.tokens,
        })),
    ]);
    for (const tagId of spec.prequeued ?? []) {
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES ('ses-1', ?, 'drop', 1)",
        ).run(tagId);
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
        [
            "resolves copied call ids, echoes ordinals in input order, reports noop facts outside",
            { ctx_handles: ["call-a", "call-b", "call-d", "call-c"] },
            { protectedSet: new Set<number>([9]) },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.stamped).toEqual([5, 7]);
                expect(report.ctx_handles).toEqual([5, 7, 11, 9]);
                expect(report.noop).toEqual({ released: [11] });
                expect(report.held).toEqual([9]);
                // Protected items are queued deferred (upstream semantics), not refused.
                expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
            },
        ],
        [
            "keeps positional slots for repeated ids: same ordinal per slot, one queued op",
            { ctx_handles: ["call-a", "call-a"] },
            {},
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual([5]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([5]);
                expect(JSON.parse(response).ctx_handles).toEqual([5, 5]);
            },
        ],
        [
            "rejects a foreign-session id as broken input, never a foreign release",
            { ctx_handles: ["call-e"] },
            {},
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("not-found");
                expect(report.errors[0].entries).toEqual(["call-e"]);
                expect(report.ctx_handles).toBeUndefined();
                expect(report.errors[0].note).toContain("current context window");
                expect(report.errors[0].note).toContain(
                    "Nothing was stamped; resend the corrected batch.",
                );
                expect(report.stamped).toBeUndefined();
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
                expect(pendingTagNumbers(db, "ses-2")).toEqual([]);
            },
        ],
        [
            "rejects the whole batch when the bridge cannot pair ANY id, reporting EVERY dead id at once (all-failed stays loud, S-4 + Rev 6.1)",
            { ctx_handles: ["call-b", "call-a"] },
            { resolver: { resolve: () => new Map() } },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.errors[0].entries).toEqual(["call-b", "call-a"]);
                expect(report.errors.length).toBe(1);
                expect(report.ctx_handles).toBeUndefined();
                expect(report.stamped).toBeUndefined();
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            },
        ],
        [
            "plain not-found coexists with success lines as a graceful noop (S-4 ruling)",
            { ctx_handles: ["call-a", "nope-1"] },
            {},
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.stamped).toEqual([5]);
                expect(report.errors[0].class).toBe("not-found");
                expect(report.ctx_handles).toEqual([5, null]);
                expect(report.errors[0].entries).toEqual(["nope-1"]);
                expect(report.errors[0].note).toContain("the rest of the batch was stamped");
                expect(report.errors[0].note).not.toContain("Nothing was stamped");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([5]);
            },
        ],
        [
            "rejects mixing handles with the legacy drop grammar",
            { ctx_handles: ["call-a"], drop: "7" },
            {},
            (response, db) => {
                expect(response).toContain("cannot be combined");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            },
        ],
        [
            "no-arg invocation releases the bulk default set",
            {},
            { latestUserOrdinal: 11 },
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual([5, 7, 9]);
                expect(JSON.parse(response).ctx_handles).toBeUndefined();
                expect(pendingTagNumbers(db, "ses-1")).toEqual([5, 7, 9]);
            },
        ],
        [
            "refuses capability when the module backend throws",
            { ctx_handles: ["call-a"] },
            {
                rustToolBackends: {
                    reduce: (async () => {
                        throw new Error("module down");
                    }) as unknown as RustToolBackends["reduce"],
                },
            },
            (response, db) => {
                expect(response).toContain("cleanup");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            },
        ],
    ]);

    it("is idempotent: re-sent ids report the queued noop and queue nothing new", async () => {
        const { db, tools } = buildWorld(IDS_SEED);
        await tools.ctx_reduce!.execute({ ctx_handles: ["call-a"] }, ctx);
        const before = pendingTagNumbers(db, "ses-1");
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a"] },
            ctx,
        )) as string;
        const report = JSON.parse(response);
        expect(report.noop).toEqual({ queued: [5] });
        expect(report.ctx_handles).toEqual([5]);
        expect(report.note).toContain("already queued or processed");
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
        const first = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-b"] },
            ctx,
        )) as string;
        expect(received).toBe("5,7");
        expect(JSON.parse(first).stamped).toEqual([5, 7]);
        expect(JSON.parse(first).ctx_handles).toEqual([5, 7]);
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);

        queued = 0;
        const second = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-b"] },
            ctx,
        )) as string;
        const report = JSON.parse(second);
        expect(report.noop).toEqual({ released: [5, 7] });
        expect(report.ctx_handles).toEqual([5, 7]);
        expect(report.note).toContain("already queued or processed");
    });
});

describe("ctx_reduce handles lane (quotes)", () => {
    // Production shape: the registry keys the shells with the suffixed
    // content key (`:pK`, often K>=1); the mirror keeps bare ids. The
    // geometry must join across the suffix.
    runTable(
        {
            messages: [
                {
                    id: "msg-a",
                    ordinal: 100,
                    role: "user",
                    tag: 40,
                    part: 2,
                    content: "the quarterly figures show revenue climbing twelve percent overall",
                },
                {
                    id: "msg-b",
                    ordinal: 101,
                    role: "assistant",
                    tag: 41,
                    part: 3,
                    content: "notes: revenue climbing\ttwelve   percent across all regions",
                },
                {
                    id: "msg-c",
                    ordinal: 102,
                    role: "user",
                    tag: 42,
                    part: 1,
                    content: "unrelated deployment checklist for staging",
                },
            ],
        },
        [
            [
                "releases the uniquely matched message shell across the key suffix, slot echoes its ordinal",
                { ctx_handles: ["unrelated deployment checklist"] },
                {},
                (response, db) => {
                    expect(JSON.parse(response).stamped).toEqual([102]);
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
                    expect(JSON.parse(response).ctx_handles).toEqual([102]);
                },
            ],
            [
                "matches through whitespace variance (mirror collapses, both sides tokenize)",
                { ctx_handles: ["revenue climbing twelve percent"] },
                {},
                (response, db) => {
                    const report = JSON.parse(response);
                    expect(report.errors[0].class).toBe("ambiguous");
                    // Candidate ordinals are not published (2026-10-22 ruling:
                    // bare numbers are ctx_expand bait — the opposite of reducing).
                    expect(report.errors[0].candidates).toBeUndefined();
                    expect(report.errors[0].entries).toEqual(["revenue climbing twelve percent"]);
                    expect(report.ctx_handles).toBeUndefined();
                    expect(report.errors[0].note).toContain("Copy a longer run");
                    expect(report.errors[0].note).toContain(
                        "Nothing was stamped; resend the corrected batch.",
                    );
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
                },
            ],
            [
                "ambiguity nulls its own slot; sibling handles in the same batch stamp (2026-10-22 ruling: plain ambiguous is a graceful noop)",
                { ctx_handles: ["revenue climbing twelve percent", "unrelated deployment"] },
                {},
                (response, db) => {
                    const report = JSON.parse(response);
                    expect(report.errors[0].class).toBe("ambiguous");
                    expect(report.errors[0].entries).toEqual(["revenue climbing twelve percent"]);
                    expect(report.ctx_handles).toEqual([null, 102]);
                    expect(report.stamped).toEqual([102]);
                    expect(report.errors[0].note).toContain("the rest of the batch was stamped");
                    expect(report.errors[0].note).not.toContain("Nothing was stamped");
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
                },
            ],
            [
                "counts only LIVE matches: a dropped twin leaves a unique winner",
                { ctx_handles: ["quarterly figures show revenue"] },
                {
                    messages: [
                        {
                            id: "msg-d",
                            ordinal: 103,
                            role: "user",
                            tag: 43,
                            part: 0,
                            status: "dropped",
                            content:
                                "the quarterly figures show revenue climbing twelve percent overall",
                        },
                    ],
                },
                (response, db) => {
                    expect(JSON.parse(response).stamped).toEqual([100]);
                    expect(JSON.parse(response).ctx_handles).toEqual([100]);
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([40]);
                },
            ],
            [
                "rejects a quote that matches nothing anywhere as broken input",
                { ctx_handles: ["purple platypus parliament"] },
                {},
                (response, db) => {
                    const report = JSON.parse(response);
                    expect(report.errors[0].class).toBe("not-found");
                    expect(report.errors[0].entries).toEqual(["purple platypus parliament"]);
                    expect(report.errors[0].note).toContain("current context window");
                    expect(report.errors[0].note).toContain(
                        "Nothing was stamped; resend the corrected batch.",
                    );
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
                },
            ],
            [
                "diagnoses an out-of-window quote as a noop, not an error",
                { ctx_handles: ["archived changelog entry"] },
                {
                    messages: [
                        {
                            id: "msg-dead",
                            ordinal: 99,
                            role: "assistant",
                            tag: 44,
                            part: 1,
                            status: "dropped",
                            content: "the archived changelog entry from last release",
                        },
                    ],
                },
                (response, db) => {
                    const report = JSON.parse(response);
                    expect(report.noop).toEqual({ released: [99] });
                    expect(report.ctx_handles).toEqual([99]);
                    expect(report.note).toContain("already queued or processed");
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
                },
            ],
            [
                "queues a protected message match with the upstream promise line",
                { ctx_handles: ["deployment checklist"] },
                { protectedSet: new Set<number>([42]) },
                (response, db) => {
                    expect(JSON.parse(response).held).toEqual([102]);
                    expect(JSON.parse(response).ctx_handles).toEqual([102]);
                    // Upstream semantics: protected drops are queued, applied on displacement.
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([42]);
                },
            ],
            [
                "mixes ids and quotes in one array, one applied call, one queued transaction",
                { ctx_handles: ["call-t", "deployment checklist"] },
                {
                    tools: [{ tag: 55, callId: "call-t", owner: "msg-t" }],
                    mintExtra: { "msg-t": 90 },
                },
                (response, db) => {
                    expect(JSON.parse(response).stamped).toEqual([90, 102]);
                    expect(JSON.parse(response).ctx_handles).toEqual([90, 102]);
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([42, 55]);
                },
            ],
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
            {
                id: "msg-b",
                ordinal: 11,
                role: "assistant",
                content: "beta task two",
                tag: 2,
                part: 2,
            },
            {
                id: "msg-c",
                ordinal: 12,
                role: "assistant",
                content: "gamma task three",
                tag: 3,
                part: 1,
            },
        ],
        tools: [
            { tag: 21, callId: "call-a", owner: "msg-a" },
            { tag: 22, callId: "call-b", owner: "msg-b" },
            { tag: 23, callId: "call-c", owner: "msg-c" },
        ],
    };

    runTable(RANGE_SEED, [
        [
            "releases the inclusive stretch between two quote endpoints across key domains, span slot in echo",
            { ctx_handles: ["alpha task one..gamma task three"] },
            {},
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual(["10-12"]);
                // Registration span 1..3: the tag band, one event.
                expect(JSON.parse(response).ctx_handles).toEqual(["10-12"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3]);
            },
        ],
        [
            "resolves range endpoints through the id lane too",
            { ctx_handles: ["call-a..call-b"] },
            {},
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual(["10-11"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([21, 22]);
            },
        ],
        [
            "resolves a range whose endpoints are different handle kinds",
            { ctx_handles: ["call-a..gamma task three"] },
            {},
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual(["10-12"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([3, 21]);
            },
        ],
        [
            "resolves a quote-start/id-end range",
            { ctx_handles: ["alpha task one..call-b"] },
            {},
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual(["10-11"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 21, 22]);
            },
        ],
        [
            "keeps a literal double-dot as phrase text when the full entry matches",
            { ctx_handles: ["the .. marks a path segment"] },
            {
                messages: [
                    {
                        id: "msg-dot",
                        ordinal: 20,
                        role: "user",
                        content: "the .. marks a path segment in this quote",
                        tag: 8,
                        part: 0,
                    },
                ],
            },
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual([20]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([8]);
            },
        ],
        [
            "treats a reversed-written range as the same span (direction is irrelevant)",
            { ctx_handles: ["gamma task three..alpha task one"] },
            {},
            (response, db) => {
                expect(JSON.parse(response).stamped).toEqual(["12-10"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3]);
            },
        ],
        [
            "a missing range endpoint is the same broken-input class as a missing entry",
            { ctx_handles: ["alpha task one..purple platypus"] },
            {},
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("range-endpoint");
                expect(report.ctx_handles).toBeUndefined();
                expect(report.errors[0].entries).toEqual(["purple platypus"]);
                expect(report.errors[0].note).toContain(
                    'It is the end of the range "alpha task one..purple platypus".',
                );
                expect(report.errors[0].note).toContain(
                    "Endpoints inside tool output are call ids.",
                );
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            },
        ],
        [
            "protected items inside a stretch queue deferred with the range promise line",
            { ctx_handles: ["alpha task one..delta task four"] },
            {
                messages: [
                    {
                        id: "msg-d",
                        ordinal: 13,
                        role: "user",
                        content: "delta task four",
                        tag: 4,
                        part: 2,
                    },
                ],
                protectedSet: new Set<number>([3]),
            },
            (response, db) => {
                expect(JSON.parse(response).held).toEqual(["10-13"]);
                expect(JSON.parse(response).ctx_handles).toEqual(["10-13"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 4]);
            },
        ],
        // msg-b's shell already queued (pre-queued op): the stretch still
        // spans, the inside noop reports without touching the slot.
        [
            "noop facts inside a stretch report ordinals, span slot unchanged",
            { ctx_handles: ["alpha task one..gamma task three"] },
            { prequeued: [2] },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.stamped).toEqual(["10-12"]);
                expect(report.noop).toEqual({ queued: [11] });
                expect(report.ctx_handles).toEqual(["10-12"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3]);
            },
        ],
        [
            "handles array mixes a single entry, a range, and repeats in one positional line",
            { ctx_handles: ["call-b", "alpha task one..gamma task three"] },
            {},
            (response, db) => {
                // Positional mirror: entry 1 is the single id (ordinal 11), entry 2 the span.
                expect(JSON.parse(response).stamped).toEqual([11, "10-12"]);
                expect(JSON.parse(response).ctx_handles).toEqual([11, "10-12"]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([1, 2, 3, 22]);
            },
        ],
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
            [
                "releases only consumed tool tags past the floor and before the newest user message",
                {},
                {},
                (response, db) => {
                    expect(JSON.parse(response).stamped).toEqual([50]);
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([60, 63]);
                },
            ],
            [
                "holds a protected consumed tag instead of releasing it",
                {},
                { protectedSet: new Set<number>([60]) },
                (response, db) => {
                    expect(JSON.parse(response).stamped).toBeUndefined();
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
                },
            ],
            [
                "reports nothing-to-release when only protected work is left",
                {},
                { protectedSet: new Set<number>([60]) },
                (response, db) => {
                    expect(JSON.parse(response).note).toContain("Nothing older to release");
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
                },
            ],
            [
                "without a newest user message nothing has been responded past: nothing bulk-released",
                {},
                { latestUserOrdinal: undefined },
                (response, db) => {
                    expect(JSON.parse(response).note).toContain("Nothing to release");
                    // Only the pre-seeded pending op remains; nothing new was queued.
                    expect(pendingTagNumbers(db, "ses-1")).toEqual([63]);
                },
            ],
        ],
    );
});

describe("ctx_reduce partial accept (S-4 ruling)", () => {
    const world = (): ReturnType<typeof buildWorld> =>
        buildWorld({
            messages: [
                { id: "m1", ordinal: 1, role: "user", content: "fix the auth bypass", tag: 40 },
                {
                    id: "m2",
                    ordinal: 2,
                    role: "assistant",
                    content: "the cache ttl caused the login failure",
                    tag: 41,
                },
            ],
            tools: [{ callId: "call-a", tag: 50, owner: "m1" }],
        });

    it("a lone not-found in a batch is a graceful noop; siblings stamp", async () => {
        const { db, tools } = world();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "purple platypus parliament"] },
            ctx,
        )) as string;
        const report = JSON.parse(response);
        expect(report.stamped).toEqual([1]);
        expect(report.ctx_handles).toEqual([1, null]);
        expect(report.errors[0].entries).toEqual(["purple platypus parliament"]);
        expect(report.errors[0].note).toContain("current context window");
        expect(report.errors[0].note).not.toContain("Nothing was stamped");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([50]);
    });

    it("a range with a dead endpoint keeps failing the whole call loudly", async () => {
        const { db, tools } = world();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "call-a..purple platypus parliament"] },
            ctx,
        )) as string;
        expect(JSON.parse(response).errors[0].note).toContain("Nothing was stamped");
        expect(JSON.parse(response).ctx_handles).toBeUndefined();
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("an ambiguous plain entry is a graceful noop; siblings stamp (2026-10-22 ruling)", async () => {
        const { db, tools } = buildWorld({
            messages: [
                { id: "m1", ordinal: 1, role: "user", content: "the cache ttl is fine", tag: 40 },
                {
                    id: "m2",
                    ordinal: 2,
                    role: "assistant",
                    content: "the cache ttl caused the login failure",
                    tag: 41,
                },
            ],
            tools: [{ callId: "call-a", tag: 50, owner: "m1" }],
        });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "cache ttl"] },
            ctx,
        )) as string;
        const report = JSON.parse(response);
        expect(report.stamped).toEqual([1]);
        expect(report.ctx_handles).toEqual([1, null]);
        expect(report.errors[0].class).toBe("ambiguous");
        expect(report.errors[0].entries).toEqual(["cache ttl"]);
        expect(report.errors[0].candidates).toBeUndefined();
        expect(report.errors[0].note).toContain("Found twice");
        expect(report.errors[0].note).toContain("the rest of the batch was stamped");
        expect(report.errors[0].note).not.toContain("Nothing was stamped");
        expect(pendingTagNumbers(db, "ses-1")).toEqual([50]);
    });

    it("ambiguous as a range endpoint still fails the whole call loudly", async () => {
        const { db, tools } = buildWorld({
            messages: [
                { id: "m1", ordinal: 1, role: "user", content: "the cache ttl is fine", tag: 40 },
                {
                    id: "m2",
                    ordinal: 2,
                    role: "assistant",
                    content: "the cache ttl caused the login failure",
                    tag: 41,
                },
                {
                    id: "m3",
                    ordinal: 3,
                    role: "user",
                    content: "unrelated deployment checklist for staging",
                    tag: 42,
                },
            ],
            tools: [{ callId: "call-a", tag: 50, owner: "m1" }],
        });
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["call-a", "cache ttl..unrelated deployment checklist"] },
            ctx,
        )) as string;
        const report = JSON.parse(response);
        expect(report.errors[0].class).toBe("ambiguous");
        expect(report.errors[0].note).toContain("It is the start of the range");
        expect(report.errors[0].note).toContain("Nothing was stamped");
        expect(report.ctx_handles).toBeUndefined();
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("the loud path reports every failing entry, grouped by class+note (no note duplication)", async () => {
        const { db, tools } = world();
        const response = (await tools.ctx_reduce!.execute(
            {
                ctx_handles: [
                    "call-a",
                    "ghost one",
                    "ghost one",
                    "ghost two",
                    "call-a..ghost missing",
                ],
            },
            ctx,
        )) as string;
        const report = JSON.parse(response);
        expect(report.ctx_handles).toBeUndefined();
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
        // Two groups, first-appearance order; duplicate echo deduped inside its group.
        expect(report.errors.map((e: { class: string }) => e.class)).toEqual([
            "not-found",
            "range-endpoint",
        ]);
        expect(report.errors[0].entries).toEqual(["ghost one", "ghost two"]);
        // The endpoint echo names the failing ENDPOINT; the full range entry
        // rides once inside the note's range hint.
        expect(report.errors[1].entries).toEqual(["ghost missing"]);
        expect(report.errors[1].note).toContain("It is the end of the range");
        expect(report.errors[1].note).toContain('"call-a..ghost missing"');
        // Grouping proof: 4 failing entries (one a duplicate echo) answer in
        // 2 objects — the naive per-entry shape would carry 3 copies of the
        // identical not-found note. The shared base clause rides once per
        // GROUP (the groups differ: plain vs range-hinted note).
        expect(report.errors.length).toBe(2);
        expect(report.errors[0].note).not.toBe(report.errors[1].note);
        expect((response.match(/No tool call id/g) ?? []).length).toBe(2);
        expect((response.match(/Endpoints inside tool output/g) ?? []).length).toBe(1);
    });

    it("a lone entry that is the only pointer still fails as an error", async () => {
        const { db, tools } = world();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["purple platypus parliament"] },
            ctx,
        )) as string;
        expect(JSON.parse(response).errors[0].note).toContain("Nothing was stamped");
        expect(JSON.parse(response).ctx_handles).toBeUndefined();
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });

    it("all entries not-found stays an error (nothing stamped is the truth)", async () => {
        const { db, tools } = world();
        const response = (await tools.ctx_reduce!.execute(
            { ctx_handles: ["purple platypus parliament", "ghost senate chamber"] },
            ctx,
        )) as string;
        expect(JSON.parse(response).errors[0].note).toContain("Nothing was stamped");
        expect(JSON.parse(response).ctx_handles).toBeUndefined();
        expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
    });
});

describe("ctx_reduce phrase lane S-2 (substring verify)", () => {
    // Spec: docs/reports/ctx-reduce-surface-failures-2026-10.md (gate tree +
    // test table). LIKE runs ONLY on collisions, over the MATCH shortlist.
    const S2_SEED: WorldSpec = {
        messages: [
            {
                id: "s2-uniq",
                ordinal: 300,
                role: "user",
                tag: 70,
                part: 0,
                content: "tests failed silently on the nightly",
            },
        ],
    };
    runTable(S2_SEED, [
        [
            "row 1: unique skeleton hit, bytes do NOT match — stamps, verify never runs",
            { ctx_handles: ["test failed"] },
            {},
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.stamped).toEqual([300]);
                expect(pendingTagNumbers(db, "ses-1")).toEqual([70]);
            },
        ],
        [
            "row 2: collision, exactly one byte survivor — stamps the survivor, no found-twice",
            { ctx_handles: ["test failed"] },
            {
                messages: [
                    {
                        id: "s2-byte",
                        ordinal: 301,
                        role: "user",
                        tag: 71,
                        part: 0,
                        content: "the test failed on nightly run",
                    },
                    {
                        id: "s2-twin",
                        ordinal: 302,
                        role: "assistant",
                        tag: 72,
                        part: 0,
                        content: "tests failed overnight",
                    },
                ],
            },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.stamped).toEqual([301]);
                expect(report.errors).toBeUndefined();
                expect(pendingTagNumbers(db, "ses-1")).toEqual([71]);
            },
        ],
        [
            "row 3: collision, skeleton twin 'testing failure' — stamps the byte one",
            { ctx_handles: ["test failed"] },
            {
                messages: [
                    {
                        id: "s2-byte2",
                        ordinal: 303,
                        role: "user",
                        tag: 73,
                        part: 0,
                        content: "the test failed again",
                    },
                    {
                        id: "s2-twin2",
                        ordinal: 304,
                        role: "assistant",
                        tag: 74,
                        part: 0,
                        content: "testing failure overnight",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([303]);
            },
        ],
        [
            "row 4: head/tail trim — 'test failed.' passes free (substring predicate)",
            { ctx_handles: ["test failed"] },
            {
                messages: [
                    {
                        id: "s2-trim",
                        ordinal: 305,
                        role: "user",
                        tag: 75,
                        part: 0,
                        content: "test failed.",
                    },
                    {
                        id: "s2-trimtwin",
                        ordinal: 306,
                        role: "assistant",
                        tag: 76,
                        part: 0,
                        content: "tests failed overnight",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([305]);
            },
        ],
        [
            "row 5: interior trim — 'test, failed' is NOT a survivor; 0 survivors, ghosts unnamed",
            { ctx_handles: ["test failed"] },
            {
                messages: [
                    {
                        id: "s2-interior",
                        ordinal: 307,
                        role: "user",
                        tag: 77,
                        part: 0,
                        content: "test, failed with timeout",
                    },
                    {
                        id: "s2-interiortwin",
                        ordinal: 308,
                        role: "assistant",
                        tag: 78,
                        part: 0,
                        content: "tests failed overnight",
                    },
                ],
            },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("not-found");
                expect(report.errors[0].candidates).toBeUndefined();
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            },
        ],
        [
            "row 6: '50%' literal — LIKE wildcards escaped inert, stamps",
            { ctx_handles: ["50%"] },
            {
                messages: [
                    {
                        id: "s2-pct",
                        ordinal: 309,
                        role: "user",
                        tag: 79,
                        part: 0,
                        content: "the rollout is at 50% capacity",
                    },
                    {
                        id: "s2-pcttwin",
                        ordinal: 310,
                        role: "assistant",
                        tag: 80,
                        part: 0,
                        content: "capacity is 50 percent stable",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([309]);
            },
        ],
        [
            "row 7: zero-token entry — not-found naming the shape, no scan",
            { ctx_handles: ["\u2192\u2192\u2192"] },
            {},
            (response) => {
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("not-found");
                expect(report.errors[0].note).toContain("no searchable text");
            },
        ],
        [
            "row 8: audit geometry '===== u90 =====' — collision, 0 survivors, not-found, no ghosts",
            { ctx_handles: ["===== u90 ====="] },
            {
                messages: [
                    {
                        id: "s2-u90a",
                        ordinal: 311,
                        role: "user",
                        tag: 81,
                        part: 0,
                        content: "the u90 constant appeared in logs",
                    },
                    {
                        id: "s2-u90b",
                        ordinal: 312,
                        role: "assistant",
                        tag: 82,
                        part: 0,
                        content: "we discussed u90 today",
                    },
                ],
            },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("not-found");
                expect(report.errors[0].candidates).toBeUndefined();
                expect(pendingTagNumbers(db, "ses-1")).toEqual([]);
            },
        ],
        [
            "survivors >= 2 — found-twice teaches without publishing candidate ordinals (ctx_expand bait, 2026-10-22)",
            { ctx_handles: ["test failed"] },
            {
                messages: [
                    {
                        id: "s2-two1",
                        ordinal: 313,
                        role: "user",
                        tag: 83,
                        part: 0,
                        content: "test failed here",
                    },
                    {
                        id: "s2-two2",
                        ordinal: 314,
                        role: "assistant",
                        tag: 84,
                        part: 0,
                        content: "and test failed there",
                    },
                ],
            },
            (response) => {
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("ambiguous");
                expect(report.errors[0].candidates).toBeUndefined();
                expect(report.errors[0].entries).toEqual(["test failed"]);
                expect(report.errors[0].note).toContain("Found twice");
                expect(report.errors[0].note).not.toContain("313");
                expect(report.errors[0].note).not.toContain("314");
            },
        ],
        [
            "leading/trailing spaces in the entry are absorbed through the byte lane (collapse trims both sides)",
            { ctx_handles: ["   run steps 1 5   "] },
            {
                messages: [
                    {
                        id: "s2-edge",
                        ordinal: 331,
                        role: "assistant",
                        tag: 101,
                        part: 0,
                        content: "run steps 1 5 in parallel",
                    },
                    {
                        id: "s2-edgetwin",
                        ordinal: 332,
                        role: "user",
                        tag: 102,
                        part: 0,
                        content: "run steps 1 5 mapping",
                    },
                ],
            },
            (response) => {
                // Edge-trimmed entry byte-matches BOTH rows (run steps 1 5) —
                // the honest collision answer: found-twice, edges invisible.
                const report = JSON.parse(response);
                expect(report.errors[0].class).toBe("ambiguous");
            },
        ],
        [
            "glyph form: en-dash entry, unique skeleton hit — stamps (10 real entries, all resolved this way)",
            { ctx_handles: ["run steps 1\u20135 in parallel"] },
            {
                messages: [
                    {
                        id: "g-dash",
                        ordinal: 320,
                        role: "assistant",
                        tag: 90,
                        part: 0,
                        content: "I'll run steps 1\u20135 in parallel now",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([320]);
            },
        ],
        [
            "glyph form: en-dash collision, exact bytes — stamps the survivor (byte lane faithful for exact copies)",
            { ctx_handles: ["run steps 1\u20135"] },
            {
                messages: [
                    {
                        id: "g-dash2",
                        ordinal: 321,
                        role: "assistant",
                        tag: 91,
                        part: 0,
                        content: "run steps 1\u20135 in parallel",
                    },
                    {
                        id: "g-dash2twin",
                        ordinal: 322,
                        role: "user",
                        tag: 92,
                        part: 0,
                        content: "run steps 1 5 mapping",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([321]);
            },
        ],
        [
            "glyph form MISMATCH: en-dash entry vs hyphen content — stamp, not a ghost (faithful copy must match: plugin-failure ruling)",
            { ctx_handles: ["run steps 1\u20135"] },
            {
                messages: [
                    {
                        id: "g-dashmism",
                        ordinal: 323,
                        role: "assistant",
                        tag: 93,
                        part: 0,
                        content: "run steps 1-5 in parallel",
                    },
                    {
                        id: "g-dashmismtwin",
                        ordinal: 324,
                        role: "user",
                        tag: 94,
                        part: 0,
                        content: "run steps 1 5 mapping",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([323]);
            },
        ],
        [
            "glyph form MISMATCH: straight-apostrophe entry vs curly content — stamp (curly content surface: 336/48236 mirror rows)",
            { ctx_handles: ["don't fail"] },
            {
                messages: [
                    {
                        id: "g-curly",
                        ordinal: 325,
                        role: "assistant",
                        tag: 95,
                        part: 0,
                        content: "we don\u2019t fail nightly",
                    },
                    {
                        id: "g-curlytwin",
                        ordinal: 326,
                        role: "user",
                        tag: 96,
                        part: 0,
                        content: "do don t fail nightly",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([325]);
            },
        ],
        [
            "cyrillic collision (SCADA geometry), exact bytes — stamps the survivor",
            { ctx_handles: ["SCADA-\u0441\u0438\u0441\u0442\u0435\u043c\u0430 \u042d\u041d\u0422\u0415\u041a"] },
            {
                messages: [
                    {
                        id: "g-cyr",
                        ordinal: 327,
                        role: "user",
                        tag: 97,
                        part: 0,
                        content: "SCADA-\u0441\u0438\u0441\u0442\u0435\u043c\u0430 \u042d\u041d\u0422\u0415\u041a \u0432 \u043b\u0435\u0432\u043e\u0439 \u043a\u043e\u043b\u043e\u043d\u043a\u0435",
                    },
                    {
                        id: "g-cyrtwin",
                        ordinal: 328,
                        role: "assistant",
                        tag: 98,
                        part: 0,
                        content: "SCADA \u0441\u0438\u0441\u0442\u0435\u043c\u0430 \u042d\u041d\u0422\u0415\u0412 \u043e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u044b",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([327]);
            },
        ],
        [
            "NBSP copy is absorbed by the collapse (JS \\s covers U+00A0 on both sides)",
            { ctx_handles: ["budget\u00a0loc"] },
            {
                messages: [
                    {
                        id: "g-nbsp",
                        ordinal: 329,
                        role: "user",
                        tag: 99,
                        part: 0,
                        content: "budget\u00a0loc table",
                    },
                    {
                        id: "g-nbsptwin",
                        ordinal: 330,
                        role: "assistant",
                        tag: 100,
                        part: 0,
                        content: "budget loc list",
                    },
                ],
            },
            (response) => {
                const report = JSON.parse(response);
                // Both rows are byte-survivors after NBSP collapse — the
                // honest answer is found-twice, and NBSP is invisible.
                expect(report.errors[0].class).toBe("ambiguous");
                expect(report.errors[0].candidates).toBeUndefined();
                expect(report.errors[0].entries).toEqual(["budget loc"]);
            },
        ],
        [
            "real-data geometry: table-row copy with a double space, normalized mirror + collision — stamps the target (user ruling: a not-found on a faithful copy is a plugin failure)",
            { ctx_handles: ["budget  loc-i loc-e ref-i"] },
            {
                messages: [
                    {
                        id: "s2-table",
                        ordinal: 318,
                        role: "user",
                        tag: 88,
                        part: 0,
                        content: "budget loc-i loc-e ref-i ndl-i",
                    },
                    {
                        id: "s2-tabletwin",
                        ordinal: 319,
                        role: "assistant",
                        tag: 89,
                        part: 0,
                        content: "budget loc-index loc-end ref-index summary",
                    },
                ],
            },
            (response) => {
                expect(JSON.parse(response).stamped).toEqual([318]);
            },
        ],
        [
            "S-4 interaction: ghost entry in a batch with a resolvable phrase — sibling stamps, ghost is a null slot",
            {
                ctx_handles: [
                    "the test failed on nightly run",
                    "===== u90 =====",
                ],
            },
            {
                messages: [
                    {
                        id: "s2-s4byte",
                        ordinal: 315,
                        role: "user",
                        tag: 85,
                        part: 0,
                        content: "the test failed on nightly run",
                    },
                    {
                        id: "s2-s4u90a",
                        ordinal: 316,
                        role: "assistant",
                        tag: 86,
                        part: 0,
                        content: "the u90 constant appeared in logs",
                    },
                    {
                        id: "s2-s4u90b",
                        ordinal: 317,
                        role: "user",
                        tag: 87,
                        part: 0,
                        content: "we discussed u90 today",
                    },
                ],
            },
            (response, db) => {
                const report = JSON.parse(response);
                expect(report.ctx_handles).toEqual([315, null]);
                expect(report.stamped).toEqual([315]);
                expect(report.errors[0].class).toBe("not-found");
                expect(pendingTagNumbers(db, "ses-1")).toEqual([85]);
            },
        ],
    ]);
});
