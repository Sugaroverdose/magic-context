import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	queueMemoryMutation,
} from "@magic-context/core/features/magic-context/storage";
import {
	decodeSystemRegionRow,
	isSystemRegionBytes,
	readSystemRegion,
	writeSystemRegion,
} from "@magic-context/core/features/magic-context/system-region";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	createPiM0M1PassSnapshot,
	injectM0M1Pi,
	materializeM0Pi,
	mustMaterializePi,
	piRegionRotationPromotion,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { createPiLkgCoordinator } from "./pi-lkg";
import { createTestDb } from "./test-utils.test";

// Stage P2 (design §23): the Pi fold installs the frozen system region
// through the rotation funnel and stops splicing synthetic heads onto the
// wire. These laws mirror the OpenCode-1 fold/rotation laws (L3/L4/L5) onto
// the Pi surface; each attacks the mechanism, not the happy path (#2644).

function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
		hardSignals: {
			systemHash: "",
			modelKey: "",
			cacheExpired: false,
			lastResponseTime: 0,
		},
	};
}

function seedStore(
	db: ReturnType<typeof createTestDb>,
	state: ReturnType<typeof piState>,
) {
	appendCompartments(db, state.sessionId, [
		{
			sequence: 1,
			startMessage: 1,
			endMessage: 9,
			startMessageId: "u1",
			endMessageId: "a2",
			title: "Early",
			content: "U: setup\nearly work on the parser",
		},
	]);
	insertMemory(db, {
		projectPath: state.projectIdentity,
		category: "ARCHITECTURE",
		content: "transform lives in inject-compartments-pi",
	});
}

function systemEntry(text = "base system") {
	return { role: "system", content: text };
}

function userMsg(text: string) {
	return { role: "user", content: text, timestamp: 1 };
}

function assistantMsg(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
	};
}

describe("Pi region lane: mustMaterializePi region arms (D5)", () => {
	it("a head-row session installs the region instead of failing the head decoder", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-install-");
		try {
			const state = piState("ses-pi-region-install", dir);
			seedStore(db, state);
			// Head lane first: a normal head fold.
			materializeM0Pi(state, db);
			expect(mustMaterializePi(state, db).value).toBe(false);
			// Region lane: the same stored row must fold (install), never
			// cached_m1_missing / cache_invalid from head-decoding region-era
			// expectations.
			const decision = mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			});
			expect(decision.value).toBe(true);
			expect(decision.reason).toBe("region_first_install");
		} finally {
			closeQuietly(db);
		}
	});

	it("a corrupt region row folds once (self-healing install), not via head-decode reasons", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-corrupt-decision-");
		try {
			const state = piState("ses-pi-region-corrupt", dir);
			seedStore(db, state);
			getOrCreateSessionMeta(db, state.sessionId);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
			).run(Buffer.from([0x2d, 0x2d, 0x3e, 0xed, 0xa0, 0x80]), state.sessionId);
			// Head lane: null m1 keeps the row on the head-decode lanes.
			expect(mustMaterializePi(state, db).reason).toBe("cached_m1_missing");
			// Region lane: not served, folds via a content/marker arm — never the
			// head-only cached_m1_missing reason.
			const decision = mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			});
			expect(decision.value).toBe(true);
			expect(decision.reason).not.toBe("cached_m1_missing");
		} finally {
			closeQuietly(db);
		}
	});

	it("an installed region row with matching markers is stable (no fold)", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-stable-");
		try {
			const state = piState("ses-pi-region-stable", dir);
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const decision = mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			});
			expect(decision).toEqual({ value: false, reason: null });
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi region lane: the fold installs through the rotation funnel (D4)", () => {
	it("fold writes sentinel region bytes, nulls m1, and captures markers + boundary atomically", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-fold-");
		try {
			const state = piState("ses-pi-region-fold", dir);
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const row = db
				.prepare(
					`SELECT cached_m0_bytes, cached_m1_bytes,
					        cached_m0_last_baseline_end_message_id AS boundary,
					        cached_m0_max_memory_id, cached_m0_upgrade_state
			   FROM session_meta WHERE session_id = ?`,
				)
				.get(state.sessionId) as {
				cached_m0_bytes: Uint8Array;
				cached_m1_bytes: Uint8Array | null;
				boundary: string | null;
				cached_m0_max_memory_id: number | null;
				cached_m0_upgrade_state: string | null;
			};
			expect(isSystemRegionBytes(row.cached_m0_bytes)).toBe(true);
			const region = decodeSystemRegionRow(row.cached_m0_bytes);
			expect(typeof region).toBe("string");
			// Baseline + newest deltas live in the region now (m[1] folded in).
			expect(region).toContain("<session-history");
			expect(region).toContain("early work on the parser");
			expect(region).toContain("transform lives in inject-compartments-pi");
			// The head delta column is vacated — region mode has no m[1].
			expect(row.cached_m1_bytes).toBeNull();
			// Marker capture + boundary persist with the bytes (co-transaction).
			expect(row.cached_m0_max_memory_id).not.toBeNull();
			expect(row.cached_m0_upgrade_state).not.toBeNull();
			expect(row.boundary).toBe("a2");
		} finally {
			closeQuietly(db);
		}
	});

	it("rotation re-installs region bytes with the new delta content (delta fields ride the boundary)", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-rotate-");
		try {
			const state = piState("ses-pi-region-rotate", dir);
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const before = readSystemRegion(db, state.sessionId);
			expect(before).not.toBeNull();
			expect(before).not.toContain("late added fact");
			// Additive memory = m[1]-delta field: rotates only at a boundary.
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: "late added fact",
			});
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "max_memory_id",
			});
			const after = readSystemRegion(db, state.sessionId);
			expect(after).toContain("late added fact");
			expect(after).not.toBe(before);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi region lane: rotation promotion is ride-only (D7, L3/L4 mirror)", () => {
	function installed(dir: string, sid: string) {
		const db = createTestDb();
		const state = piState(sid, dir);
		seedStore(db, state);
		materializeM0Pi(state, db, undefined, {
			enabled: true,
			reason: "region_first_install",
		});
		return { db, state };
	}

	it("stale manifest promotes only on a boundary permission", () => {
		const dir = createTestTempDirFromPath("/tmp/pi-region-promote-");
		const { db, state } = installed(dir, "ses-pi-region-promote");
		try {
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: 1,
				queuedAt: Date.now(),
			});
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			const args = {
				state,
				db,
				passSnapshot: snapshot,
				systemRegionLane: true,
				foldDue: false,
				boundaryPermission: true,
				forceBand: false,
			};
			expect(piRegionRotationPromotion(args)).toEqual({
				promote: true,
				reason: "max_memory_mutation_id",
			});
			// Ride-only (L4): without the boundary the stale manifest never promotes.
			expect(
				piRegionRotationPromotion({ ...args, boundaryPermission: false }),
			).toEqual({ promote: false, reason: null });
			// A fold already due belongs to mustMaterialize, not the promotion.
			expect(piRegionRotationPromotion({ ...args, foldDue: true })).toEqual({
				promote: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("fresh manifest on a warm boundary never promotes; absent region declines", () => {
		const dir = createTestTempDirFromPath("/tmp/pi-region-fresh-");
		const { db, state } = installed(dir, "ses-pi-region-fresh");
		try {
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			const args = {
				state,
				db,
				passSnapshot: snapshot,
				systemRegionLane: true,
				foldDue: false,
				boundaryPermission: true,
				forceBand: false,
			};
			expect(piRegionRotationPromotion(args)).toEqual({
				promote: false,
				reason: null,
			});
			// Control: the same pass with a stale manifest DOES promote (the
			// decline above is the gate, not a broken reader).
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: 1,
				queuedAt: Date.now(),
			});
			const staleSnapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			expect(
				piRegionRotationPromotion({ ...args, passSnapshot: staleSnapshot })
					.promote,
			).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("an absent region installs via the fold path, never via promotion", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-absent-");
		try {
			const state = piState("ses-pi-region-absent", dir);
			seedStore(db, state);
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			expect(
				piRegionRotationPromotion({
					state,
					db,
					passSnapshot: snapshot,
					systemRegionLane: true,
					foldDue: false,
					boundaryPermission: true,
					forceBand: false,
				}),
			).toEqual({ promote: false, reason: null });
		} finally {
			closeQuietly(db);
		}
	});

	it("force band re-tiers an aged region on a boundary pass", () => {
		const dir = createTestTempDirFromPath("/tmp/pi-region-force-");
		const { db, state } = installed(dir, "ses-pi-region-force");
		try {
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			expect(
				piRegionRotationPromotion({
					state,
					db,
					passSnapshot: snapshot,
					systemRegionLane: true,
					foldDue: false,
					boundaryPermission: true,
					forceBand: true,
				}),
			).toEqual({ promote: true, reason: "force_band" });
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi region lane: LKG slot is region-orthogonal (D10, L6)", () => {
	function slotText(messages: readonly unknown[]): string {
		return JSON.stringify(messages);
	}
	it("the captured slot carries no panel bytes and replays byte-identical across a rotation", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-lkg-");
		try {
			const sid = "ses-pi-region-lkg";
			const state = piState(sid, dir);
			seedStore(db, state);
			const coordinator = createPiLkgCoordinator(db, (capture) => capture());
			const wireMessages = [
				systemEntry(),
				userMsg("question"),
				assistantMsg("answer"),
				userMsg("keep me"),
			];
			const ids = ["s0", "u1", "a2", "u3"];
			// Pass 1 warms the slot (capture is synchronous in this test).
			const snap1 = coordinator.beginPass({
				sessionId: sid,
				messages: wireMessages,
				entryIds: ids,
				modelKey: "m",
				providerKey: "p",
			});
			coordinator.captureAppliedPass({
				snapshot: snap1,
				outputMessages: wireMessages,
				outputEntryIds: ids,
				cacheBusting: true,
			});
			// Pass 2 snapshots against the warm slot…
			const snap2 = coordinator.beginPass({
				sessionId: sid,
				messages: wireMessages,
				entryIds: ids,
				modelKey: "m",
				providerKey: "p",
			});
			// …a rotation lands between snapshot and replay…
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			// …replay is unaffected: the region never entered the slot.
			const replay = coordinator.replay(snap2);
			expect(replay.ok).toBe(true);
			if (!replay.ok) throw new Error("unreachable");
			expect(slotText(replay.messages)).toBe(slotText(wireMessages));
			expect(slotText(replay.messages)).not.toContain("<session-history");
			expect(slotText(replay.messages)).not.toContain("<project-memory");
			expect(sha256ish(slotText(replay.messages))).toBe(
				sha256ish(slotText(wireMessages)),
			);
		} finally {
			closeQuietly(db);
		}
	});
});

function sha256ish(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

describe("Pi region lane: heads come off the wire (D8, L5)", () => {
	it("region-mode injection splices no synthetic heads and counts none", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-novheads-");
		try {
			const state = {
				...piState("ses-pi-region-noheads", dir),
				freezePrefixForPass: true,
			};
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const messages = [
				systemEntry(),
				userMsg("old question"),
				assistantMsg("old answer"),
				userMsg("keep me"),
			];
			const entryIds = ["s0", "u1", "a2", "u3"];
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				entryIds,
				false,
				snapshot,
				{
					systemRegion: { enabled: true, reason: "hard_fold" },
				},
			);
			// No user-role synthetic head anywhere on the wire.
			for (const message of messages) {
				const text =
					typeof message.content === "string"
						? message.content
						: (message.content as Array<{ text?: string }>)
								.map((part) => part.text ?? "")
								.join("");
				expect(text).not.toContain("<session-history");
				expect(text).not.toContain("<project-memory");
			}
			// Pi's own leading system entries keep their identity; MC contributes
			// zero heads (system[2] never exists on this lane).
			expect(result.syntheticLeadingCount).toBe(1);
			expect(messages[0].role).toBe("system");
			// L6 support: no array-side prefix exists to freeze.
			expect(
				(state as { preparedPrefix?: unknown }).preparedPrefix,
			).toBeUndefined();
			expect(result.injected).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi region lane: trim reads region-co-resident boundaries only (D6, #2674)", () => {
	it("a fold-written region + co-resident boundary trims summarized messages", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-trim-");
		try {
			const state = piState("ses-pi-region-trim", dir);
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const messages = [
				systemEntry(),
				userMsg("summarized question"),
				assistantMsg("summarized answer"),
				userMsg("keep me"),
			];
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			const removed = trimPiMessagesToCachedBoundary(
				db,
				state.sessionId,
				messages as never,
				["s0", "u1", "a2", "u3"],
				snapshot,
			);
			expect(removed).toBeGreaterThan(0);
			const last = messages[messages.length - 1];
			expect((last as { content: string }).content).toBe("keep me");
		} finally {
			closeQuietly(db);
		}
	});

	it("a funnel-written region (boundary NULLed at the write site) trims nothing", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-trim-null-");
		try {
			const state = piState("ses-pi-region-trim-null", dir);
			seedStore(db, state);
			// Seed a boundary FIRST, then write the region through the funnel —
			// the write site nulls the boundary (write-site property).
			db.prepare(
				"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
			).run("m9", state.sessionId);
			writeSystemRegion(
				db,
				state.sessionId,
				"<project-memory>plain</project-memory>",
			);
			const messages = [
				systemEntry(),
				userMsg("old question"),
				assistantMsg("old answer"),
				userMsg("keep me"),
			];
			const removed = trimPiMessagesToCachedBoundary(
				db,
				state.sessionId,
				messages as never,
				["s0", "u1", "a2", "u3"],
			);
			expect(removed).toBe(0);
			expect(messages.length).toBe(4);
		} finally {
			closeQuietly(db);
		}
	});

	it("a corrupt region row trims nothing (reader-level refusal keeps its force)", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-trim-corrupt-");
		try {
			const state = piState("ses-pi-region-trim-corrupt", dir);
			seedStore(db, state);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
			).run(
				Buffer.concat([
					new TextEncoder().encode("<!-- mc:system-region v1 -->\n"),
					Buffer.from([0xed, 0xa0, 0x80]),
				]),
				"m9",
				state.sessionId,
			);
			const messages = [
				systemEntry(),
				userMsg("old question"),
				assistantMsg("old answer"),
				userMsg("keep me"),
			];
			const removed = trimPiMessagesToCachedBoundary(
				db,
				state.sessionId,
				messages as never,
				["s0", "u1", "a2", "u3"],
			);
			expect(removed).toBe(0);
			expect(messages.length).toBe(4);
		} finally {
			closeQuietly(db);
		}
	});
});
