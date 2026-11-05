// Unit 7 volatile segment carrier (Pi mirror of the plugin's Unit 2
// region-volatile.ts; census Carry-forward B). Pi law COPIES the carrier API
// in the Pi codec — it must not import the plugin's hooks tree.
//
// The frozen system region carries only what was true at its capture. The
// delta classes that used to live in the head-era m[1] — memory mutations,
// compartments published after the capture, memories that overflow the frozen
// region panel, profile deltas — render here instead: a small per-session
// segment stored beside the region and served at the tail of the system
// prompt AFTER the region bytes. The segment is absorbed by the next natural
// fold (the fold-row persist clears it inside the fold transaction).
//
// Replay-only law: the serve decodes persisted bytes and performs zero
// computation; recomputation happens only on passes that already hold the
// bust permission (the context-handler runPipeline bust lane). Region and
// volatile bytes are pure functions of the store up to the captured
// watermark — no timestamps, no randomness.

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { writeRegionVolatile } from "@magic-context/core/features/magic-context/storage-meta-shared";
import { decodeSystemRegionRow } from "@magic-context/core/features/magic-context/system-region";
import type { SessionMeta } from "@magic-context/core/features/magic-context/types";
import { DEFAULT_HISTORY_BUDGET_TOKENS } from "@magic-context/core/hooks/magic-context/decay-render";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { sessionLog } from "@magic-context/core/shared/logger";
import {
	type PiM0M1State,
	type PiVolatileWatermark,
	renderM1PiVolatileSegment,
} from "./inject-compartments-pi";

/**
 * The one region-volatile codec: stored bytes → served tail text, null when
 * absent/empty. Shared by the store decode and the serve site so the two can
 * never drift.
 */
export function decodeRegionVolatileBytes(
	value: Buffer | Uint8Array | null | undefined,
): string | null {
	if (value === null || value === undefined) return null;
	const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value);
	return buffer.length === 0 ? null : buffer.toString("utf8");
}

/**
 * THE production serve reader: decode of persisted bytes plus the epoch
 * guard — a segment is servable only when its watermark names the region row
 * being served (an older segment is refused). Called from the serve site with
 * the session meta it already loaded: stored bytes verbatim, zero
 * computation, zero live reads beyond the row. The fold and the bust-lane
 * recompute are the only writers; this is the only reader.
 */
export function serveRegionVolatilePi(meta: SessionMeta): string | null {
	if (
		meta.cachedM0MaterializedAt === null ||
		meta.regionVolatileWatermark !== meta.cachedM0MaterializedAt
	) {
		return null;
	}
	return decodeRegionVolatileBytes(meta.regionVolatileBytes);
}

/**
 * Growth backstop (head-era port, plugin parity): when the delta carrier has
 * grown past a head-era-verified threshold it REQUESTS a fold from the
 * scheduler — it never re-renders the region itself and never holds a bust
 * authority of its own. Three independent arms (any one requests):
 * supersede-delta drift (size-independent), volatile/region size ratio with a
 * small-region floor, and an absolute token cap measured against the history
 * budget. Token counts on both sides of the ratio (NOT chars): XML-heavy and
 * non-Latin content diverges sharply.
 */
const VOLATILE_UPDATE_COUNT_CAP = 40;
const VOLATILE_DRIFT_RATIO = 0.15;
const REGION_DRIFT_RATIO_FLOOR_TOKENS = 500;
const VOLATILE_ABSOLUTE_CAP_RATIO = 0.2;

export function evaluateRegionVolatileBackstop(args: {
	regionText: string | null;
	volatileText: string;
	memoryUpdateCount: number;
	historyBudgetTokens: number | undefined;
}): { request: boolean; reason: string | null } {
	if (args.volatileText === "") return { request: false, reason: null };
	if (args.memoryUpdateCount > VOLATILE_UPDATE_COUNT_CAP) {
		return { request: true, reason: "volatile_update_count" };
	}
	const volatileTokens = estimateTokens(args.volatileText);
	const budget = args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS;
	if (volatileTokens > budget * VOLATILE_ABSOLUTE_CAP_RATIO) {
		return { request: true, reason: "volatile_absolute_cap" };
	}
	if (args.regionText !== null) {
		const regionTokens = estimateTokens(args.regionText);
		if (
			regionTokens >= REGION_DRIFT_RATIO_FLOOR_TOKENS &&
			volatileTokens > regionTokens * VOLATILE_DRIFT_RATIO
		) {
			return { request: true, reason: "volatile_drift_ratio" };
		}
	}
	return { request: false, reason: null };
}

function readMemoryBlockIds(db: ContextDatabase, sessionId: string): number[] {
	const row = db
		.prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
		.get(sessionId) as { memory_block_ids: string | null } | undefined;
	if (!row?.memory_block_ids) return [];
	try {
		const parsed = JSON.parse(row.memory_block_ids) as unknown;
		return Array.isArray(parsed) ? (parsed as number[]) : [];
	} catch {
		return [];
	}
}

/**
 * The bust-lane recompute entry: called only from a pass that already holds
 * the bust permission (context-handler runPipeline). Renders the segment
 * against the stored region row's CACHED markers — never current data — and
 * persists it only when the bytes moved; every other pass serves the stored
 * bytes verbatim. When the fold executed this pass the caller skips this —
 * the fold-row persist absorbed the segment in the fold transaction.
 */
export function recomputeRegionVolatileSegmentPi(args: {
	db: ContextDatabase;
	sessionId: string;
	meta: SessionMeta;
	state: PiM0M1State;
	/** Growth-backstop fold REQUEST sink: fired with the arm reason when the
	 *  recomputed segment passes a threshold. The scheduler consumes the
	 *  request on a later boundary pass; this pass only signals. */
	onFoldRequest?: (reason: string) => void;
}): { text: string; memoryUpdateCount: number; memoryIds: number[] } | null {
	const { db, sessionId, meta } = args;
	if (meta.cachedM0MaterializedAt === null) return null;
	const regionText = decodeSystemRegionRow(meta.cachedM0Bytes ?? null);
	if (regionText === null || typeof regionText !== "string") return null;
	const watermark: PiVolatileWatermark = {
		maxMemoryId: meta.cachedM0MaxMemoryId ?? 0,
		maxCompartmentSeq: meta.cachedM0MaxCompartmentSeq ?? 0,
		maxMemoryMutationId: meta.cachedM0MaxMemoryMutationId ?? 0,
		projectUserProfileVersion: meta.cachedM0ProjectUserProfileVersion ?? 0,
		materializedAt: meta.cachedM0MaterializedAt,
	};
	const rendered = renderM1PiVolatileSegment(
		args.state,
		db,
		watermark,
		readMemoryBlockIds(db, sessionId),
	);
	// Growth backstop: the request fires on every bust-lane recompute where
	// the rendered (wire-truth) segment passes a threshold — including the
	// unchanged case, so a restart that cleared the in-memory request queue
	// re-sights the oversized segment on the next bust pass. Signal only:
	// nothing here touches region bytes or the rotation machinery.
	const backstop = evaluateRegionVolatileBackstop({
		regionText,
		volatileText: rendered.text,
		memoryUpdateCount: rendered.memoryUpdateCount,
		historyBudgetTokens: args.state.historyBudgetTokens,
	});
	if (backstop.request && backstop.reason)
		args.onFoldRequest?.(backstop.reason);
	const stored = decodeRegionVolatileBytes(meta.regionVolatileBytes);
	if (rendered.text === (stored ?? "")) return null;
	writeRegionVolatile(
		db,
		sessionId,
		rendered.text,
		meta.cachedM0MaterializedAt,
	);
	// Hide-filter accounting: the ctx_search hard filter must hide everything
	// the wire shows. The fold owns the exact re-derivation (panel ids ∪
	// fold-volatile ids); the bust-lane recompute only grows the set for the
	// current region epoch — merged volatile ids become stale-excess at most
	// until the next fold, which rewrites the row wholesale.
	if (rendered.memoryIds.length > 0) {
		const prior = new Set(readMemoryBlockIds(db, sessionId));
		for (const id of rendered.memoryIds) prior.add(id);
		const ids = [...prior].sort((left, right) => left - right);
		db.prepare(
			"UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
		).run(ids.length, JSON.stringify(ids), sessionId);
	}
	sessionLog(
		sessionId,
		`region-volatile recomputed bytes=${rendered.text.length} updates=${rendered.memoryUpdateCount}`,
	);
	return rendered;
}
