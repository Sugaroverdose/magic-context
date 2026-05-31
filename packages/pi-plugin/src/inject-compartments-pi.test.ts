import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import { getCompartments } from "@magic-context/core/features/magic-context/storage";
import {
	getActiveUserMemories,
	insertUserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import {
	__test,
	injectM0M1Pi,
	materializeM0Pi,
	materializeM0PiWithRetry,
	mustMaterializePi,
	renderM0Pi,
	renderM1Pi,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("trimPiMessagesToBoundary", () => {
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});

	it("resolves a synth-user-* cutoff to the underlying real toolResult entry id", () => {
		// A compartment ending on a folded-toolResult boundary carries
		// endMessageId = `synth-user-<realToolResultEntryId>`. The live array has
		// no message with that synthetic id — only the real toolResult (entry id
		// "tr-real"). Pre-fix, the cutoff never matched and NOTHING was trimmed
		// (history duplicated -> overflow). The fix strips the prefix and matches
		// the real toolResult, then the orphan sweep removes its paired assistant.
		const messages = [
			assistant(["call-a"]),
			result("call-a"),
			assistant([], "next turn"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "tr-real", "a2", "keep"],
			"synth-user-tr-real",
		);

		// toolResult "tr-real" (cutoff) + its paired assistant "call-a" (orphan
		// sweep) are removed; the later turn + keep survive.
		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect((messages[1] as { content: string }).content).toBe("keep");
	});

	it("returns 0 (no spurious trim) when a synth-user-* cutoff has no matching real entry", () => {
		const messages = [assistant(["call-a"]), user("keep")];
		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "keep"],
			"synth-user-nonexistent",
		);
		expect(removed).toBe(0);
		expect(messages.length).toBe(2);
	});

	it("does not over-remove a later kept tool pair that reuses a trimmed callId", () => {
		const messages = [
			assistant(["reused"]),
			result("reused"),
			user("between turns"),
			assistant(["reused"]),
			result("reused"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a1", "r1", "u1", "a2", "r2", "u2"],
			"a1",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect((messages[3] as { content: string }).content).toBe("keep");
	});

	it("renders frozen compartment and user-profile snapshots without m[0]/m[1] duplication", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-frozen-cp-profile-"));
		try {
			const state = piState("ses-pi-frozen-cp-profile", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Frozen",
					content: "U: old turn\nold compartment body",
				},
			]);
			insertUserMemory(db, "old profile memory", []);
			const frozenCompartments = getCompartments(db, state.sessionId);
			const frozenUserProfile = getActiveUserMemories(db);

			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-2",
					endMessageId: "entry-2",
					title: "Concurrent",
					content: "U: new turn\nnew compartment body",
				},
			]);
			insertUserMemory(db, "new profile memory", []);

			const m0 = renderM0Pi(
				state,
				db,
				"",
				1,
				[],
				frozenCompartments,
				frozenUserProfile,
			);
			const m1 = renderM1Pi(state, db, {
				maxCompartmentSeq: 1,
				maxMemoryId: 0,
				maxMutationId: 0,
				projectMemoryEpoch: 0,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: 0,
				upgradeState: "",
				lastBaselineEndMessageId: "entry-1",
			});

			expect(m0).toContain("old compartment body");
			expect(m0).toContain("old profile memory");
			expect(m0).not.toContain("new compartment body");
			expect(m0).not.toContain("new profile memory");
			expect(m1).toContain("new compartment body");
			expect(m1).not.toContain("old compartment body");
			expect(m1).not.toContain("old profile memory");
		} finally {
			closeQuietly(db);
		}
	});
});

function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

describe("injectM0M1Pi", () => {
	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(piState("ses-pi-empty", cwd), db, messages as never);

			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toBe(
				"<session-history-since>(no new content since last materialization)</session-history-since>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState("ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never);

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a new compartment appears", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-compartment-"));
		try {
			const state = piState("ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			// Legacy compartment (no paraphrase tiers) WITH a U: line → v2 renders
			// it at P3 (content kept) per the locked legacy-decay rule. A new
			// compartment must trigger m[0] re-materialization.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"]);

			// m[0] re-materialized and now carries the compartment (title always
			// renders; body present because the U: line keeps it at P3).
			expect(textOf(second[0] as never)).toContain('title="Setup"');
			expect(textOf(second[0] as never)).toContain("Compacted setup");
			expect(textOf(second[1] as never)).toContain(
				"no new content since last materialization",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with NULL required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-null-marker-"));
		try {
			const state = piState("ses-pi-null-marker", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const second = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, second as never);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(textOf(second[0] as never)).toContain("<session-history>");
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with any partial required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-partial-marker-"));
		try {
			const state = piState("ses-pi-partial-marker", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(mustMaterializePi(state, db)).toEqual({
				value: true,
				reason: "cache_invalid",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("retries instead of losing seq-0 compartment published during materialization", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-seq0-race-"));
		try {
			const state = piState("ses-pi-seq0-race", cwd);
			const originalExec = db.exec.bind(db);
			let injectedRace = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedRace) {
					injectedRace = true;
					appendCompartments(db, state.sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 1,
							startMessageId: "entry-0",
							endMessageId: "entry-0",
							title: "First",
							content: "U: first turn\nseq zero body",
						},
					]);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const { m0, snapshotMarkers } = materializeM0PiWithRetry(state, db);

			expect(injectedRace).toBe(true);
			expect(snapshotMarkers.maxCompartmentSeq).toBe(0);
			expect(m0).toContain("seq zero body");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims against the frozen cached boundary instead of live rewritten compartments", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-frozen-boundary-"));
		try {
			const state = piState("ses-pi-frozen-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-end",
					endMessageId: "old-end",
					title: "Frozen",
					content: "U: old turn\nfrozen body",
				},
			]);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			db.prepare(
				"UPDATE compartments SET end_message_id = ? WHERE session_id = ? AND sequence = 0",
			).run("too-far", state.sessionId);

			const messages = [
				userMessage("old visible", 10),
				userMessage("must stay", 11),
				userMessage("keep", 12),
			];
			const result = injectM0M1Pi(state, db, messages as never, [
				"old-end",
				"too-far",
				"keep",
			]);

			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[2] as never)).toBe("must stay");
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE is busy", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0m1-begin-busy-"));
		try {
			const state = piState("ses-pi-begin-busy", cwd);
			injectM0M1Pi(state, db, [userMessage("hello", 10)] as never);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy",
					content: "U: busy turn\nbusy fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(state, db, messages as never);

			expect(result.m0Materialized).toBe(false);
			expect(textOf(messages[0] as never)).toBe(
				"<session-history></session-history>",
			);
			expect(textOf(messages[1] as never)).toContain("busy fallback body");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("renderM0Pi sibling-block layout (OpenCode parity)", () => {
	it("renders <project-memory> as a SIBLING after </session-history>, not nested inside it", () => {
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-siblings-"));
		try {
			const state = piState("ses-pi-siblings", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "The widget service owns rendering.",
				sourceType: "historian",
			});

			const m0 = renderM0Pi(state, db);

			// The <session-history> wrapper must close BEFORE <project-memory>
			// opens — they are siblings (matches OpenCode renderM0). A nested
			// layout (project-memory inside session-history) is the bug this
			// guards against: it would put different bytes on the wire than
			// OpenCode for identical state.
			const historyClose = m0.indexOf("</session-history>");
			const memoryOpen = m0.indexOf("<project-memory>");
			expect(historyClose).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(historyClose);
			// Compartment body lives INSIDE <session-history>; memory does NOT.
			const historyBlock = m0.slice(
				m0.indexOf("<session-history>"),
				historyClose,
			);
			expect(historyBlock).toContain("Compacted setup");
			expect(historyBlock).not.toContain("widget service");
		} finally {
			closeQuietly(db);
		}
	});

	it("materializeM0Pi binds maxMemoryId watermark to the rendered memory set", () => {
		// Regression for the round-7 HIGH: the persisted maxMemoryId watermark must
		// equal the max id of the memories actually rendered into m[0]. If it were
		// read separately (lower), a memory present in m[0] could also satisfy
		// "id > watermark" and render again in m[1] — duplicated across the split.
		const db = createTestDb();
		const cwd = mkdtempSync(join(tmpdir(), "pi-m0-watermark-"));
		try {
			const state = piState("ses-pi-watermark", cwd);
			for (const content of [
				"The widget service owns rendering.",
				"Orders flow through an async queue.",
				"Sessions use stateless JWT.",
			]) {
				insertMemory(db, {
					projectPath: state.projectIdentity,
					category: "ARCHITECTURE",
					content,
					sourceType: "historian",
				});
			}
			const maxId = getMemoriesByProject(db, state.projectIdentity, [
				"active",
				"permanent",
			]).reduce((m, x) => (x.id > m ? x.id : m), 0);

			const { snapshotMarkers } = materializeM0Pi(state, db);

			expect(maxId).toBeGreaterThan(0);
			expect(snapshotMarkers.maxMemoryId).toBe(maxId);
		} finally {
			closeQuietly(db);
		}
	});
});
