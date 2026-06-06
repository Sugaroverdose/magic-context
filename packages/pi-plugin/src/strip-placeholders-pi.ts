/**
 * Pi dropped-placeholder stripping — mirrors OpenCode's
 * `stripDroppedPlaceholderMessages` plus persisted
 * `session_meta.stripped_placeholder_ids` replay.
 *
 * OpenCode replaces placeholder-only messages with sentinel shells to
 * keep provider-cache array structure stable. Pi rebuilds `AgentMessage[]`
 * from JSONL on every pass, so the Pi-native operation is simpler: remove
 * messages whose only model-visible content is `[dropped §N§]` after
 * `applyFlushedStatuses` has replayed dropped tag state.
 *
 * Replay is persistent and runs on every pass from stable Pi message ids.
 * Discovery of new placeholder-only ids happens only on cache-busting
 * passes, matching OpenCode's "discover on execute, replay everywhere"
 * contract.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	applyStrippedPlaceholderDelta,
	getStrippedPlaceholderIds,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { resolvePiStableId } from "./read-session-pi";

const DROPPED_SEGMENT_PATTERN = /^\[dropped(?: §[^§]+§)?\]$/;

function isDroppedOnlyText(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	const segments = trimmed
		.split(/(?=\[dropped(?: §[^§]+§)?\])/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	return (
		segments.length > 0 &&
		segments.every((s) => DROPPED_SEGMENT_PATTERN.test(s))
	);
}

function messageIsPlaceholderOnly(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const msg = message as { role?: unknown; content?: unknown };
	// Only assistant messages may be neutralized/removed. User-role messages
	// anchor turn boundaries the AI SDK relies on to avoid merging consecutive
	// assistants — removing one can collapse a boundary. Mirrors OpenCode's
	// strip-content.ts ("Never neutralize user-role messages — they anchor turn
	// boundaries"). In Pi's raw array, tool results carry role "toolResult"
	// (synthetic tool-result user folds live only in the transcript view, never
	// written back to this array), so genuine user prompts are the only user-role
	// entries here — never all-[dropped] — making this a safe parity guard.
	if (msg.role !== "assistant") return false;

	if (typeof msg.content === "string") return isDroppedOnlyText(msg.content);
	if (!Array.isArray(msg.content)) return false;
	if (msg.content.length === 0) return false;

	let sawVisibleContent = false;
	for (const part of msg.content) {
		if (!part || typeof part !== "object") return false;
		const p = part as { type?: unknown; text?: unknown };
		if (p.type !== "text") return false;
		if (typeof p.text !== "string") return false;
		sawVisibleContent = true;
		if (!isDroppedOnlyText(p.text)) return false;
	}
	return sawVisibleContent;
}

export interface StripPiDroppedPlaceholderResult {
	removed: number;
	discovered: number;
}

export function stripPiDroppedPlaceholderMessages(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	isCacheBusting: boolean;
	/**
	 * Carried stable-id map keyed by message object reference, built by the caller
	 * POST-commit / PRE-injection (see context-handler). This runs AFTER
	 * injectM0M1Pi splices the array, so positional index→id is stale; object
	 * identity survives the splice. Skip-on-miss: the only legitimate misses are
	 * injection's synthetic m[0]/m[1] prepends (never placeholders).
	 */
	stableIdByRef?: ReadonlyMap<object, string>;
	/**
	 * Force placeholder rediscovery regardless of isCacheBusting. Set on the
	 * stable-id-scheme cutover pass so previously-stripped placeholders get
	 * re-keyed under the new scheme (discovery is otherwise history-refresh-gated).
	 */
	forceDiscovery?: boolean;
}): StripPiDroppedPlaceholderResult {
	const { db, sessionId, messages, isCacheBusting, stableIdByRef } = args;
	const persistedIds = getStrippedPlaceholderIds(db, sessionId);
	const idsToStrip = new Set(persistedIds);
	let discovered = 0;

	// Resolve a message's stable id: carried map (object-ref, survives splice)
	// first; fall back to the index-based id only when the message isn't in the
	// map (legacy callers that pass no map, or the rare unmapped message).
	const idOf = (msg: unknown, index: number): string | undefined => {
		const m = msg && typeof msg === "object" ? (msg as object) : undefined;
		const carried = m ? stableIdByRef?.get(m) : undefined;
		if (typeof carried === "string" && carried.length > 0) return carried;
		// Skip-on-miss when a map was provided: the only unmapped messages
		// post-injection are synthetic m[0]/m[1] prepends, never placeholders.
		if (stableIdByRef) return undefined;
		// No carried map (legacy/test callers): resolve via the unified resolver
		// (index-only inputs → the pi-msg-* fallback). Production always passes the
		// map, so this branch is the legacy path only.
		return resolvePiStableId(msg, index);
	};

	// Ids of every message present in the CURRENT (trimmed+injected) window,
	// captured BEFORE the removal splice. Used to prune below-boundary ids from
	// the persisted set. Captured pre-removal so placeholders stripped THIS pass
	// stay in the set — Pi rebuilds AgentMessage[] from JSONL every pass, so a
	// still-in-window placeholder must keep its id to be re-stripped next pass.
	// Only populated when discovering (cache-busting/cutover) AND a carried map
	// is present (production path); the index-fallback path can't safely prune.
	const canPrune =
		(isCacheBusting || args.forceDiscovery === true) && !!stableIdByRef;
	const presentIds = canPrune ? new Set<string>() : null;

	// Track the exact ids discovered THIS pass so we can persist an add-delta
	// (CAS) instead of overwriting the whole set — a sibling process's concurrent
	// discovery/prune must not be clobbered.
	const discoveredIds: string[] = [];
	if (isCacheBusting || args.forceDiscovery) {
		for (let i = 0; i < messages.length; i++) {
			const id = idOf(messages[i], i);
			if (!id) continue;
			presentIds?.add(id);
			if (!messageIsPlaceholderOnly(messages[i])) continue;
			if (!idsToStrip.has(id)) {
				idsToStrip.add(id);
				discoveredIds.push(id);
				discovered++;
			}
		}
	}

	let removed = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const id = idOf(messages[i], i);
		if (!id || !idsToStrip.has(id)) continue;
		messages.splice(i, 1);
		removed++;
	}

	// Persist on cache-busting/cutover passes. When pruning is possible (carried
	// map present) also drop below-boundary ids (in the persisted set but no
	// longer in the window) so the set doesn't grow unbounded over a long session
	// — Pi's compaction boundary only advances, so an id absent from the current
	// window is gone for good and safe to drop. Pruning is storage-only and gated
	// to cache-busting passes (parity with note-nudge/sticky GC): the bytes
	// already change on these passes, and a defer pass must never mutate persisted
	// replay state.
	let pruned = 0;
	if (presentIds) {
		// Below-boundary ids: in the persisted set (pre-discovery) but no longer
		// in the window. Compute against `persistedIds` (the original set), not
		// the in-memory idsToStrip, so we emit a precise remove-delta.
		const removedIds: string[] = [];
		for (const id of persistedIds) {
			if (!presentIds.has(id)) removedIds.push(id);
		}
		pruned = removedIds.length;
		if (discoveredIds.length > 0 || removedIds.length > 0) {
			// CAS delta merge (parity with OpenCode): add discovered, remove
			// below-boundary, applied atomically against a fresh read so a sibling
			// process's concurrent change is preserved.
			applyStrippedPlaceholderDelta(db, sessionId, {
				add: discoveredIds,
				remove: removedIds,
			});
		}
	} else if (discoveredIds.length > 0) {
		// No carried map (legacy/test path): can't safely prune, but still persist
		// newly discovered ids as an add-delta.
		applyStrippedPlaceholderDelta(db, sessionId, { add: discoveredIds });
	}

	if (removed > 0 || discovered > 0 || pruned > 0) {
		sessionLog(
			sessionId,
			`placeholder strip: removed=${removed} discovered=${discovered} pruned=${pruned}`,
		);
	}
	return { removed, discovered };
}
