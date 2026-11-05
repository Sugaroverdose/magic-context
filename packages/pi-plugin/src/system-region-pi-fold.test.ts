import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	bumpProjectMemoryEpoch,
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
import { piSyntheticHistoryAdoptionWindow } from "./context-handler";
import {
	createPiM0M1PassSnapshot,
	injectM0M1Pi,
	materializeM0Pi,
	mustMaterializePi,
	piRegionRotationPromotion,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { createPiLkgCoordinator } from "./pi-lkg";
import {
	adoptPiCompactionSystemSnapshot,
	resolvePiEffectiveSystemState,
} from "./system-entry-pi";
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

	it("fold absorbs pending delta memory into the region bytes (Unit 2 Task 3)", () => {
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
			// Additive memory = delta class (Task 3): it never triggers a
			// rotation of its own — it rides the volatile segment until the
			// next legitimate fold, which absorbs it into the region panels.
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: "late added fact",
			});
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "hard_fold",
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

// Storm comparator convergence, Pi mirror (§25, Fix A), re-expressed for
// Unit 2 Task 3: the docs hash is demoted from the rotation vocabulary (the
// docs delta rides the volatile segment), so the docs-edit arm can no longer
// promote — and the comparator must still read LIVE current state for the
// surviving compared members (bitten here by the dashboard epoch through the
// production writer). The original defect had two faces: the Pi wrapper fed
// the PERSISTED docs hash on the current side (dead trigger), the TS side a
// placeholder "" (rotate storm); both were caught by pinning the pair to
// what production reads. The live-current-side pin survives on the epoch arm.
describe("Pi region lane: promotion comparator convergence (storm, Fix A mirror; Task 3 demotion)", () => {
	function installedWithDocs(dir: string, sid: string) {
		writeFileSync(
			join(dir, "ARCHITECTURE.md"),
			"# Architecture\n\npanel doc v1.\n",
		);
		writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\nmap v1.\n");
		const db = createTestDb();
		const state = piState(sid, dir);
		seedStore(db, state);
		materializeM0Pi(state, db, undefined, {
			enabled: true,
			reason: "region_first_install",
		});
		return { db, state };
	}

	it("a docs edit never promotes (Task 3): the docs delta rides the volatile segment", () => {
		const dir = createTestTempDirFromPath("/tmp/pi-region-docs-edit-");
		const { db, state } = installedWithDocs(dir, "ses-pi-region-docs-edit");
		try {
			const meta = getOrCreateSessionMeta(db, state.sessionId);
			expect(meta.cachedM0ProjectDocsHash).toBeTruthy();
			writeFileSync(
				join(dir, "ARCHITECTURE.md"),
				"# Architecture\n\npanel doc v2.\n",
			);
			const snapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			// Demoted: even with the boundary permission the docs change is
			// invisible to rotation — the panel converges at the next fold.
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

	it("comparator keeps its bite through the live current side (epoch control)", () => {
		// Fix A's property, transplanted to a surviving compared member: the
		// wrapper's current side must reflect the LIVE store (dashboard epoch
		// bump via the production writer), not the persisted snapshot — the
		// dead-trigger wiring class stays dead.
		const dir = createTestTempDirFromPath("/tmp/pi-region-docs-bite-");
		const { db, state } = installedWithDocs(dir, "ses-pi-region-docs-bite");
		try {
			bumpProjectMemoryEpoch(db, state.projectIdentity);
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
			).toEqual({ promote: true, reason: "project_memory_epoch" });
			// Ride-only still holds without the boundary.
			expect(
				piRegionRotationPromotion({
					state,
					db,
					passSnapshot: snapshot,
					systemRegionLane: true,
					foldDue: false,
					boundaryPermission: false,
					forceBand: false,
				}),
			).toEqual({ promote: false, reason: null });
		} finally {
			closeQuietly(db);
		}
	});

	it("unchanged docs on a warm boundary never promotes (convergence)", () => {
		const dir = createTestTempDirFromPath("/tmp/pi-region-docs-warm-");
		const { db, state } = installedWithDocs(dir, "ses-pi-region-docs-warm");
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
					forceBand: false,
				}),
			).toEqual({ promote: false, reason: null });
		} finally {
			closeQuietly(db);
		}
	});

	it("anti-vacuity: the wrapper composes the current side from the live reader, never the persisted hash", () => {
		// Property over patch: the Pi promotion wrapper must not pass the
		// persisted docs hash into the current-side reader (that was the
		// dead-trigger wiring); the live canonical read is the only
		// sanctioned source, reached via the undefined-parameter fallback.
		const text = readFileSync(
			join(import.meta.dir, "inject-compartments-pi.ts"),
			"utf8",
		);
		expect(
			/readCurrentMarkersFromCompartments\(\s*[\s\S]{0,200}?meta\.cachedM0ProjectDocsHash\s*\?\?\s*undefined\s*,?\s*\)/.test(
				text,
			),
		).toBe(false);
	});

	it("quiescent warm session with a region far past the cap must NOT rotate (Fix C mirror)", () => {
		// §25.3: the Pi wrapper wired pendingBytes = storedRegion.length
		// (absolute size) — same defect class as the TS lane. A quiescent
		// session (markers equal, no force band) must decline no matter how
		// large the region is. The region grows through the PRODUCTION fold
		// (a large memory block, budget raised so the trimmer keeps it) —
		// post-install writeSystemRegion is NOT quiescent on Pi: its H3
		// property retires the boundary deliberately.
		const dir = createTestTempDirFromPath("/tmp/pi-region-big-");
		writeFileSync(
			join(dir, "ARCHITECTURE.md"),
			"# Architecture\n\npanel doc v1.\n",
		);
		writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\nmap v1.\n");
		const db = createTestDb();
		const state = {
			...piState("ses-pi-region-big", dir),
			injectionBudgetTokens: 400_000,
		};
		seedStore(db, state);
		insertMemory(db, {
			projectPath: state.projectIdentity,
			category: "CONSTRAINTS",
			content: "x".repeat(60_000),
		});
		try {
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const region = readSystemRegion(db, state.sessionId);
			expect(region).not.toBeNull();
			// Past every historical cap: the old wiring read this length as
			// the "pending delta" (default budget cap = 40_000 * 0.2 * 4).
			expect((region ?? "").length).toBeGreaterThan(40_000 * 0.2 * 4);
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
	}, 20_000);
});

describe("Pi region lane: compaction adoption touches zero real messages (F1)", () => {
	const HOST_SYSTEM = {
		role: "system" as const,
		content: "Base instructions",
		toolsAdded: Array.from({ length: 12 }, (_, i) => ({
			name: `tool${i}`,
			description: "tool",
			parameters: { type: "object", properties: {} },
		})),
		timestamp: 0,
	};
	function compactionEntries() {
		return [
			{
				type: "compaction",
				id: "cmp-1",
				summary: "Magic Context compacted",
				firstKeptEntryId: "entry-2",
				tokensBefore: 10,
				systemMessage: structuredClone(HOST_SYSTEM),
			},
		];
	}

	it("head lane: the window is the two synthetic MC heads and adoption restamps them", () => {
		// Control pinning the pre-existing head-lane behavior the fix must
		// not disturb: [system, headA, headB, real...] with
		// syntheticLeadingCount=3 selects exactly [headA, headB].
		const headA = {
			role: "user",
			content: "<session-history>a</session-history>",
			timestamp: 50,
		};
		const headB = {
			role: "user",
			content: "<session-history-since>b</session-history-since>",
			timestamp: 60,
		};
		const real = { role: "user", content: "keep me", timestamp: 70 };
		const messages = [structuredClone(HOST_SYSTEM), headA, headB, real];
		const window = piSyntheticHistoryAdoptionWindow(
			messages,
			{ syntheticLeadingCount: 3 },
			false,
		);
		expect(window).toEqual([headA, headB]);
		const adoption = adoptPiCompactionSystemSnapshot(
			messages,
			compactionEntries(),
			"cmp-1",
			resolvePiEffectiveSystemState(messages),
			window,
		);
		expect(adoption.kind).toBe("adopted");
		// snapshot.timestamp(0) + offset - 2 — the two heads are re-stamped…
		expect(headA.timestamp).toBe(-2);
		expect(headB.timestamp).toBe(-1);
		// …and the real envelope is untouched.
		expect(real.timestamp).toBe(70);
	});

	it("region lane: the window is empty and adoption restamps zero real envelopes", () => {
		// F1: syntheticLeadingCount=1 on this lane (only the Pi system entry),
		// so the head-lane pair arithmetic [-1, 1) selects REAL messages and
		// adoption re-stamps their timestamps. The region lane must hand the
		// adoption an empty window: zero real-message envelopes touched.
		const question = { role: "user", content: "question", timestamp: 100 };
		const answer = {
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			timestamp: 101,
		};
		const messages = [structuredClone(HOST_SYSTEM), question, answer];
		const window = piSyntheticHistoryAdoptionWindow(
			messages,
			{ syntheticLeadingCount: 1 },
			true,
		);
		expect(window).toEqual([]);
		const adoption = adoptPiCompactionSystemSnapshot(
			messages,
			compactionEntries(),
			"cmp-1",
			resolvePiEffectiveSystemState(messages),
			window,
		);
		expect(adoption.kind).toBe("adopted");
		expect(question.timestamp).toBe(100);
		expect(answer.timestamp).toBe(101);
		// Object identity of the real entries survives the adoption splice.
		expect(messages).toContain(question);
		expect(messages).toContain(answer);
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
			const state = piState("ses-pi-region-noheads", dir);
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
			// L6 support: no array-side prefix exists to freeze — the
			// preparedPrefix carriage was DELETED in Unit 7 (carry-forward A);
			// the state no longer carries the field at all.
			expect("preparedPrefix" in state).toBe(false);
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

describe("Pi region lane: volatile delta carrier (Unit 7, plugin Unit 2 mirror)", () => {
	it("the fold writes the baseline panels only — no delta half in the region bytes", () => {
		// Unit 7 carry-forward B: the pre-Unit-7 fold baked
		// `${m0}\n\n${m1Render.text}` — the delta half (even as the empty
		// placeholder) froze into the region bytes, so inter-fold deltas had
		// no carrier at all. The region is the four baseline panels; the
		// `<session-history-since>` wrapper belongs to the volatile segment.
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-no-delta-half-");
		try {
			const state = piState("ses-pi-region-no-delta-half", dir);
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const region = readSystemRegion(db, state.sessionId);
			expect(region).not.toBeNull();
			expect(region).toContain("<session-history");
			expect(region).not.toContain("<session-history-since>");
		} finally {
			closeQuietly(db);
		}
	});

	it("inter-fold delta classes fold and promote on no pass (demotion fence)", () => {
		// Fence anchor (plugin system-region-rotation.test.ts Task 3 mirror):
		// re-adding a delta trigger — to mustMaterializePi's region arm or to
		// the shared DELTA_TRIGGER_FIELDS table the promotion comparator
		// reads — reddens this law. The delta's ONLY carrier is the volatile
		// segment; neither the fold nor the promotion may originate its bust.
		const db = createTestDb();
		const dir = createTestTempDirFromPath("/tmp/pi-region-demotion-");
		try {
			const state = piState("ses-pi-region-demotion", dir);
			seedStore(db, state);
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			// Delta classes land AFTER the capture: additive memory
			// (maxMemoryId), published compartment (maxCompartmentSeq),
			// user-profile promotion (profile version).
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: "inter-fold memory write",
			});
			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 10,
					endMessage: 12,
					startMessageId: "u3",
					endMessageId: "a4",
					title: "Later",
					content: "U: later work\nmore parser progress",
				},
			]);
			const decision = mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			});
			expect(decision).toEqual({ value: false, reason: null });
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

	// The bust-lane wiring census (plugin region-volatile.test.ts anti-vacuity
	// mirror, #2718 generalization): the recompute call site is the ONE
	// post-fold mutation arm, so the law pins EVERY operand at the call site —
	// the gate arms, the fold-executed skip, the contention skip, and a
	// request-only callback (deferred queue + receipt, never a rotation).
	// Committed rogue witnesses (#2780): fixture blocks run through the same
	// extractor — a callback that rotates and a call missing the fold skip
	// both redden.
	const HANDLER_SRC = join(import.meta.dir, "context-handler.ts");
	function recomputeBlock(source: string): string | null {
		const blockStart = source.indexOf("const volatileRecomputeAllowed");
		if (blockStart === -1) return null;
		return source.slice(blockStart, source.indexOf("} catch", blockStart));
	}
	function wiringIssues(source: string): string[] {
		const issues: string[] = [];
		const block = recomputeBlock(source);
		if (block === null) {
			issues.push("bust lane never calls recomputeRegionVolatileSegmentPi");
			return issues;
		}
		for (const operand of [
			"db: args.db",
			"sessionId: args.sessionId",
			"meta: args.sessionMeta",
			"state: piM0State",
			"onFoldRequest: (reason)",
			"deferredMaterializationSessions.add(args.sessionId)",
		]) {
			if (!block.includes(operand)) issues.push(`missing operand: ${operand}`);
		}
		for (const forbidden of [
			"executeSystemRegionRotation",
			"writeRegionVolatile",
			"writeSystemRegion",
		]) {
			if (block.includes(forbidden)) {
				issues.push(`request-only callback violated by: ${forbidden}`);
			}
		}
		if (!block.includes("!foldExecutedThisPass")) {
			issues.push("missing skip: fold executed this pass (segment absorbed)");
		}
		if (!block.includes("!prefixPreflightContended")) {
			issues.push(
				"missing skip: contention-exhausted pass replays persisted bytes",
			);
		}
		if (!source.includes("volatileRewroteServedBytes")) {
			issues.push(
				"the ONE mutation permission is not widened by the recompute",
			);
		}
		return issues;
	}

	it("the bust lane recomputes the volatile segment with the four closures (wiring census)", () => {
		expect(wiringIssues(readFileSync(HANDLER_SRC, "utf8"))).toEqual([]);
	});

	it("rogue witnesses: a rotating callback and an ungated call both redden the wiring census (#2780)", () => {
		const rogueRotating = [
			"const volatileRecomputeAllowed =",
			'\t(args.schedulerDecision === "execute" || rideSignals.hardFold) &&',
			"\t!prefixPreflightContended;",
			"const volatileRendered = recomputeRegionVolatileSegmentPi({",
			"\tdb: args.db,",
			"\tsessionId: args.sessionId,",
			"\tmeta: args.sessionMeta,",
			"\tstate: piM0State,",
			"\tonFoldRequest: (reason) => {",
			"\t\twriteRegionVolatile(args.db, args.sessionId, reason, 0);",
			"\t\tdeferredMaterializationSessions.add(args.sessionId);",
			"\t},",
			"});",
			"if (volatileRecomputeAllowed && !foldExecutedThisPass) { volatileRewroteServedBytes = true; }",
		].join("\n");
		const rotatingIssues = wiringIssues(rogueRotating);
		expect(
			rotatingIssues.some((issue) => issue.startsWith("request-only")),
		).toBe(true);

		const rogueUngated = [
			"const volatileRecomputeAllowed = true;",
			"const volatileRendered = recomputeRegionVolatileSegmentPi({",
			"\tdb: args.db,",
			"\tsessionId: args.sessionId,",
			"\tmeta: args.sessionMeta,",
			"\tstate: piM0State,",
			"\tonFoldRequest: (reason) => {",
			"\t\tdeferredMaterializationSessions.add(args.sessionId);",
			"\t},",
			"});",
		].join("\n");
		const ungatedIssues = wiringIssues(rogueUngated);
		expect(
			ungatedIssues.some((issue) => issue.startsWith("missing skip")),
		).toBe(true);
	});
});
