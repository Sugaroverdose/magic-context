import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import {
	decodeSystemRegionRow,
	readSystemRegion,
} from "@magic-context/core/features/magic-context/system-region";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { clearM0M1PiCache, materializeM0Pi } from "./inject-compartments-pi";
import {
	evaluateRegionVolatileBackstop,
	recomputeRegionVolatileSegmentPi,
	serveRegionVolatilePi,
} from "./region-volatile-pi";
import { processSystemPromptForCache } from "./system-prompt";
import { createTestDb } from "./test-utils.test";

// Unit 7 volatile delta carrier laws (Pi mirror of the plugin's
// region-volatile.test.ts; census Carry-forward B). Each law attacks the
// mechanism, not the happy path (#2644). The codec is a Pi COPY — the no-
// import law below fences the Task-5 boundary.

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

function foldInstall(
	db: ReturnType<typeof createTestDb>,
	state: ReturnType<typeof piState>,
) {
	materializeM0Pi(state, db, undefined, {
		enabled: true,
		reason: "region_first_install",
	});
}

function serve(db: ReturnType<typeof createTestDb>, sessionId: string) {
	return processSystemPromptForCache({
		db,
		sessionId,
		systemPrompt: "HOST GUIDANCE",
		isCacheBusting: false,
		systemRegionLane: true,
	});
}

describe("region-volatile-pi: the codec is a Pi copy (Task 5 boundary)", () => {
	it("imports nothing from the plugin's region-volatile module", () => {
		const codec = readFileSync(
			join(import.meta.dir, "region-volatile-pi.ts"),
			"utf8",
		);
		expect(codec).not.toContain("hooks/magic-context/region-volatile");
		expect(codec).not.toContain('from "./region-volatile"');
		// Rogue control (#2780): the planted import reddens the same scan.
		const rogue = `${codec}\nimport { serveRegionVolatile } from "./region-volatile";\n`;
		expect(rogue).toContain('from "./region-volatile"');
	});
});

describe("region-volatile-pi: inter-fold delta visibility (the Unit 7 bug fix)", () => {
	it("an inter-fold memory write becomes visible on serve without a rotation", () => {
		// THE bug this unit fixes: the pre-Unit-7 fold baked the delta half
		// into the region and left no carrier, so a memory written between
		// folds surfaced only on the next unrelated HARD fold. Fenced rogue
		// class: a current-data read planted into the volatile render would
		// render NOTHING here (the live cursor already covers the memory) and
		// this law would redden — the cached watermark is load-bearing.
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-visible";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-visible-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			foldInstall(db, state);
			const metaBefore = getOrCreateSessionMeta(db, sessionId);
			const regionBefore = decodeSystemRegionRow(
				metaBefore.cachedM0Bytes ?? null,
			);
			const materializedAtBefore = metaBefore.cachedM0MaterializedAt;
			expect(regionBefore).not.toBeNull();

			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: "VolVisibleToken inter-fold write",
			});
			// The bust-lane recompute (the ONE post-fold mutation arm).
			const rendered = recomputeRegionVolatileSegmentPi({
				db,
				sessionId,
				meta: getOrCreateSessionMeta(db, sessionId),
				state,
			});
			expect(rendered?.text).toContain("VolVisibleToken");

			const served = serve(db, sessionId);
			expect(served.systemPrompt).toContain("VolVisibleToken");
			// Zero rotations: the region row and its materialized_at did not
			// move — the delta surfaced through the volatile segment only.
			const metaAfter = getOrCreateSessionMeta(db, sessionId);
			expect(decodeSystemRegionRow(metaAfter.cachedM0Bytes ?? null)).toBe(
				regionBefore,
			);
			expect(metaAfter.cachedM0MaterializedAt).toBe(materializedAtBefore);
		} finally {
			closeQuietly(db);
		}
	});

	it("the recompute is idempotent: an unchanged store renders no byte movement", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-idempotent";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-idem-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			foldInstall(db, state);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: "VolIdemToken",
			});
			const meta = () => getOrCreateSessionMeta(db, sessionId);
			const first = recomputeRegionVolatileSegmentPi({
				db,
				sessionId,
				meta: meta(),
				state,
			});
			expect(first?.text).toContain("VolIdemToken");
			const bytesAfterFirst = meta().regionVolatileBytes;
			const second = recomputeRegionVolatileSegmentPi({
				db,
				sessionId,
				meta: meta(),
				state,
			});
			expect(second).toBeNull();
			expect(
				meta().regionVolatileBytes?.equals(bytesAfterFirst as Buffer),
			).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("region-volatile-pi: store and serve (replay-only)", () => {
	it("the fold absorbs a pending delta into the region baseline and clears the segment", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-absorb";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-absorb-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			// Pending delta BEFORE the fold: the fold's own capture renders it
			// into the baseline panels, so the segment starts (and stays)
			// empty — the absorbed state.
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: "pre-fold absorbed fact",
			});
			foldInstall(db, state);
			const meta = getOrCreateSessionMeta(db, sessionId);
			expect(readSystemRegion(db, sessionId)).toContain(
				"pre-fold absorbed fact",
			);
			expect(meta.regionVolatileBytes).toBeNull();
			expect(meta.regionVolatileWatermark).toBe(meta.cachedM0MaterializedAt);
			// Recompute finds nothing pending; the serve carries no tail.
			expect(
				recomputeRegionVolatileSegmentPi({ db, sessionId, meta, state }),
			).toBeNull();
			expect(serveRegionVolatilePi(meta)).toBeNull();
			const served = serve(db, sessionId);
			expect(served.systemPrompt).toContain("pre-fold absorbed fact");
			expect(
				served.systemPrompt.endsWith(readSystemRegion(db, sessionId) as string),
			).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("never serves a segment rendered against a different region epoch (stale-watermark refusal)", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-stale";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-stale-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			foldInstall(db, state);
			const meta = getOrCreateSessionMeta(db, sessionId);
			const materializedAt = meta.cachedM0MaterializedAt as number;
			// A segment whose watermark names the current region serves.
			updateSessionMeta(db, sessionId, {
				regionVolatileBytes: Buffer.from("CURRENT EPOCH TAIL"),
				regionVolatileWatermark: materializedAt,
			});
			expect(serveRegionVolatilePi(getOrCreateSessionMeta(db, sessionId))).toBe(
				"CURRENT EPOCH TAIL",
			);
			// Break the pairing: the region row now names a different epoch —
			// bytes rendered against an older region are refused.
			updateSessionMeta(db, sessionId, {
				cachedM0MaterializedAt: materializedAt + 1,
			});
			expect(
				serveRegionVolatilePi(getOrCreateSessionMeta(db, sessionId)),
			).toBeNull();
			// Serve-site integration: the stale tail never reaches the wire.
			const served = serve(db, sessionId);
			expect(served.systemPrompt).not.toContain("CURRENT EPOCH TAIL");
		} finally {
			closeQuietly(db);
		}
	});

	it("the volatile tail does not move the watched hash (hash covers host bytes only)", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-hash";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-hash-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			foldInstall(db, state);
			serve(db, sessionId);
			const hashBefore = getOrCreateSessionMeta(db, sessionId).systemPromptHash;
			// Rotate the volatile row content — the served tail moves, the
			// watched hash (host bytes only) must not.
			const meta = getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				regionVolatileBytes: Buffer.from(
					"<session-history-since>tail bytes v2</session-history-since>",
				),
				regionVolatileWatermark: meta.cachedM0MaterializedAt,
			});
			const second = serve(db, sessionId);
			expect(second.systemPrompt).toContain("tail bytes v2");
			expect(getOrCreateSessionMeta(db, sessionId).systemPromptHash).toBe(
				hashBefore,
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("the cache-clear funnel nulls the volatile columns (the clearCachedM0M1 caveat)", () => {
		// The census found clearCachedM0M1 did NOT null the volatile columns;
		// the watermark guard is defense-in-depth, not the fix. The funnel
		// itself must leave no stale segment behind a cleared region row.
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-clear";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-clear-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			foldInstall(db, state);
			const meta = getOrCreateSessionMeta(db, sessionId);
			updateSessionMeta(db, sessionId, {
				regionVolatileBytes: Buffer.from("STALE SEGMENT"),
				regionVolatileWatermark: meta.cachedM0MaterializedAt as number,
			});
			clearM0M1PiCache(db, sessionId, "test-clear");
			const row = db
				.prepare(
					"SELECT region_volatile_bytes, region_volatile_watermark FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as {
				region_volatile_bytes: Buffer | null;
				region_volatile_watermark: number;
			};
			expect(row.region_volatile_bytes).toBeNull();
			expect(row.region_volatile_watermark).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
});

describe("region-volatile-pi: growth backstop REQUESTS a fold, never rotates", () => {
	it("threshold table: head-era arms ported (update-count > 40, ratio past 15% with a 500-token floor, absolute cap past 20% of budget)", () => {
		const small = "x".repeat(400); // < 500 tokens floor
		const big = "x ".repeat(4000); // comfortably past any ratio/cap here
		expect(
			evaluateRegionVolatileBackstop({
				regionText: big,
				volatileText: "x ".repeat(100),
				memoryUpdateCount: 3,
				historyBudgetTokens: 40000,
			}),
		).toEqual({ request: false, reason: null });
		expect(
			evaluateRegionVolatileBackstop({
				regionText: big,
				volatileText: "x ".repeat(100),
				memoryUpdateCount: 41,
				historyBudgetTokens: 40000,
			}),
		).toEqual({ request: true, reason: "volatile_update_count" });
		expect(
			evaluateRegionVolatileBackstop({
				regionText: big,
				volatileText: "x ".repeat(2000),
				memoryUpdateCount: 0,
				historyBudgetTokens: 4_000_000,
			}),
		).toEqual({ request: true, reason: "volatile_drift_ratio" });
		expect(
			evaluateRegionVolatileBackstop({
				regionText: small,
				volatileText: "x ".repeat(100),
				memoryUpdateCount: 0,
				historyBudgetTokens: 4_000_000,
			}),
		).toEqual({ request: false, reason: null });
		expect(
			evaluateRegionVolatileBackstop({
				regionText: small,
				volatileText: big,
				memoryUpdateCount: 0,
				historyBudgetTokens: 200,
			}),
		).toEqual({ request: true, reason: "volatile_absolute_cap" });
	});

	it("an oversized freshly recomputed segment fires the fold REQUEST with zero region mutation", () => {
		const db = createTestDb();
		const sessionId = "ses-pi-volatile-backstop";
		const dir = createTestTempDirFromPath("/tmp/pi-volatile-backstop-");
		try {
			const state = piState(sessionId, dir);
			seedStore(db, state);
			foldInstall(db, state);
			const regionBefore = decodeSystemRegionRow(
				getOrCreateSessionMeta(db, sessionId).cachedM0Bytes ?? null,
			);
			const materializedAtBefore = getOrCreateSessionMeta(
				db,
				sessionId,
			).cachedM0MaterializedAt;
			// Push the delta past the absolute cap: budget 200 tokens -> cap 40.
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "CONSTRAINTS",
				content: `VolatileBackstopToken ${"large fact content ".repeat(30)}`,
			});
			const requests: string[] = [];
			const meta = () => getOrCreateSessionMeta(db, sessionId);
			const rendered = recomputeRegionVolatileSegmentPi({
				db,
				sessionId,
				meta: meta(),
				state: { ...state, historyBudgetTokens: 200 },
				onFoldRequest: (reason) => requests.push(reason),
			});
			expect(rendered).not.toBeNull();
			expect(rendered?.text).toContain("VolatileBackstopToken");
			expect(requests).toEqual(["volatile_absolute_cap"]);
			// The request is a signal, not an action: zero region byte changes
			// and zero materialized_at movement on the requesting pass.
			expect(decodeSystemRegionRow(meta().cachedM0Bytes ?? null)).toBe(
				regionBefore,
			);
			expect(meta().cachedM0MaterializedAt).toBe(materializedAtBefore);
		} finally {
			closeQuietly(db);
		}
	});
});
