/**
 * ctx_reduce v1 pointing surface on the Pi harness.
 *
 * The unit world seeds PRODUCTION Pi key shapes: tool rows key on the wire
 * call id in `message_id`, message rows carry the synthetic registration key
 * grammar `pi-msg-<ordinal>-<ts>-<role>:pK` (birth ordinal embedded — the
 * shared key resolver reads it), and the FTS mirror carries bare ids. The
 * mint is DI'd the way `createPiOrdinalMint` shapes it (message map, wire
 * call-id map, newest-user boundary).
 */

import { describe, expect, it } from "bun:test";
import type { OrdinalMint } from "@magic-context/core/features/magic-context/reduce-resolver";
import { getPendingOps } from "@magic-context/core/features/magic-context/storage";
import {
	insertTag,
	updateTagTokenCount,
} from "@magic-context/core/features/magic-context/storage-tags";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { Database } from "@magic-context/core/shared/sqlite";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxReduceTool } from "./ctx-reduce";

function seedTool(
	db: Database,
	sessionId: string,
	callId: string,
	tagNumber: number,
): void {
	insertTag(db, sessionId, callId, "tool", 100, tagNumber);
}

/**
 * Protection-window ballast: the legacy recipe (four newest tool tags at
 * 4,000 tokens each over the 16,000 floor) makes the window boundary real,
 * so the older targeted tags sit OUTSIDE the protected working set.
 */
function seedWindowFillers(db: Database, sessionId: string): void {
	for (const [tagNumber, callId] of [
		[20, "call-f1"],
		[21, "call-f2"],
		[22, "call-f3"],
		[23, "call-f4"],
	] as const) {
		seedTool(db, sessionId, callId, tagNumber);
		updateTagTokenCount(db, sessionId, tagNumber, 4000);
	}
}

function seedMessage(
	db: Database,
	sessionId: string,
	syntheticKey: string,
	tagNumber: number,
): void {
	insertTag(db, sessionId, syntheticKey, "message", 100, tagNumber);
}

function seedMirror(
	db: Database,
	sessionId: string,
	ordinal: number,
	messageId: string,
	role: string,
	content: string,
): void {
	db.prepare(
		"INSERT INTO message_history_fts (session_id, message_ordinal, message_id, role, content) VALUES (?, ?, ?, ?, ?)",
	).run(sessionId, ordinal, messageId, role, content);
}

async function call(
	db: Database,
	sessionId: string,
	args: Record<string, unknown>,
	mint: OrdinalMint,
) {
	const tool = createCtxReduceTool({
		db,
		protectedTags: 0,
		ordinalMint: () => mint,
	});
	const result = await tool.execute(
		"tc-1",
		args as never,
		new AbortController().signal,
		undefined,
		fakeContext(sessionId) as never,
	);
	return {
		text: (result.content[0] as { text: string }).text,
		isError: result.isError === true,
	};
}

describe("Pi ctx_reduce v1 (ctx_handles)", () => {
	it("resolves wire call ids to message ordinals in input order and queues one event", async () => {
		const db = createTestDb();
		const sessionId = "pi-v1-ids";
		try {
			seedTool(db, sessionId, "call-a", 5);
			seedTool(db, sessionId, "call-b", 7);
			seedWindowFillers(db, sessionId);
			const mint: OrdinalMint = {
				ordinalByMessageId: new Map(),
				ordinalByCallId: new Map([
					["call-a", 5],
					["call-b", 7],
				]),
				latestUserOrdinal: 100,
			};
			const first = await call(db, sessionId, { ctx_handles: ["call-b", "call-a"] }, mint);
			expect(first.isError).toBe(false);
			expect(first.text).toBe("ctx_handles: 7, 5");
			expect(getPendingOps(db, sessionId).map((op) => op.tagId).sort()).toEqual([5, 7]);

			// Idempotent re-send: noop report, nothing new queued.
			const second = await call(db, sessionId, { ctx_handles: ["call-a"] }, mint);
			expect(second.isError).toBe(false);
			expect(second.text).toContain("stamped, waiting for the sweep: 5");
			expect(getPendingOps(db, sessionId)).toHaveLength(2);
		} finally {
			closeQuietly(db);
		}
	});

	it("resolves a quote through the mirror and echoes the synthetic key's birth ordinal", async () => {
		const db = createTestDb();
		const sessionId = "pi-v1-quote";
		try {
			seedMirror(
				db,
				sessionId,
				9,
				"pi-msg-9-1700000000000-assistant",
				"assistant",
				"the quarterly figures show steady growth overall",
			);
			seedMessage(db, sessionId, "pi-msg-9-1700000000000-assistant:p1", 12);
			const mint: OrdinalMint = {
				ordinalByMessageId: new Map(),
				ordinalByCallId: new Map(),
				latestUserOrdinal: 10,
			};
			const result = await call(
				db,
				sessionId,
				{ ctx_handles: ["quarterly figures show steady growth"] },
				mint,
			);
			expect(result.isError).toBe(false);
			expect(result.text).toBe("ctx_handles: 9");
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([12]);
		} finally {
			closeQuietly(db);
		}
	});

	it("a range stretches across message shells and tool calls, echoing the ordinal span", async () => {
		const db = createTestDb();
		const sessionId = "pi-v1-range";
		try {
			seedMirror(
				db,
				sessionId,
				1,
				"pi-msg-1-111-user",
				"user",
				"alpha task brief",
			);
			seedMirror(
				db,
				sessionId,
				2,
				"pi-msg-2-222-assistant",
				"assistant",
				"beta task response",
			);
			seedMessage(db, sessionId, "pi-msg-1-111-user:p0", 10);
			seedMessage(db, sessionId, "pi-msg-2-222-assistant:p0", 11);
			// Registered AFTER both endpoint shells: outside the tag span 10..11.
			seedTool(db, sessionId, "call-mid", 15);
			// Window ballast so call-mid sits OUTSIDE the protected working
			// set: protected = newest tags by registration order (23..20),
			// call-mid (15) falls past the floor boundary.
			seedWindowFillers(db, sessionId);
			const mint: OrdinalMint = {
				ordinalByMessageId: new Map(),
				ordinalByCallId: new Map([
					["call-mid", 1],
					["call-f1", 100],
					["call-f2", 100],
					["call-f3", 100],
					["call-f4", 100],
				]),
				latestUserOrdinal: 2,
			};
			const result = await call(
				db,
				sessionId,
				{ ctx_handles: ["alpha task brief..beta task response"] },
				mint,
			);
			expect(result.isError).toBe(false);
			expect(result.text).toBe("ctx_handles: 1-2");
			// Registration span (D18): the endpoints' tag band; call-mid (15)
			// registers after the end point and does not join.
			expect(getPendingOps(db, sessionId).map((op) => op.tagId).sort()).toEqual([
				10, 11,
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("broken input is the error shape: isError set, nothing queued", async () => {
		const db = createTestDb();
		const sessionId = "pi-v1-error";
		try {
			seedTool(db, sessionId, "call-a", 5);
			const mint: OrdinalMint = {
				ordinalByMessageId: new Map(),
				ordinalByCallId: new Map([["call-a", 5]]),
				latestUserOrdinal: 10,
			};
			const result = await call(
				db,
				sessionId,
				{ ctx_handles: ["call-a", "nope-9"] },
				mint,
			);
			expect(result.isError).toBe(true);
			expect(result.text).toContain('error: "nope-9" provided in ctx_handles was not found');
			expect(result.text).toContain("Nothing was stamped; resend the corrected batch.");
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
		} finally {
			closeQuietly(db);
		}
	});

	it("no-arg invocation bulk-releases only items responded past the newest user message", async () => {
		const db = createTestDb();
		const sessionId = "pi-v1-bulk";
		try {
			seedTool(db, sessionId, "call-old", 5);
			seedTool(db, sessionId, "call-new", 7);
			seedWindowFillers(db, sessionId);
			const mint: OrdinalMint = {
				ordinalByMessageId: new Map(),
				ordinalByCallId: new Map([
					["call-old", 3],
					["call-new", 7],
					["call-f1", 9],
					["call-f2", 9],
					["call-f3", 9],
					["call-f4", 9],
				]),
				latestUserOrdinal: 5,
			};
			const result = await call(db, sessionId, {}, mint);
			expect(result.isError).toBe(false);
			expect(result.text).toContain("stamped everything you've responded past: 3");
			expect(getPendingOps(db, sessionId).map((op) => op.tagId)).toEqual([5]);
		} finally {
			closeQuietly(db);
		}
	});

	it("mixing handles with the legacy drop grammar is refused", async () => {
		const db = createTestDb();
		const sessionId = "pi-v1-mix";
		try {
			const result = await call(
				db,
				sessionId,
				{ ctx_handles: ["call-a"], drop: "5" },
				{ ordinalByMessageId: new Map() },
			);
			expect(result.isError).toBe(true);
			expect(result.text).toContain("cannot be combined");
			expect(getPendingOps(db, sessionId)).toHaveLength(0);
		} finally {
			closeQuietly(db);
		}
	});
});
