import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    type PersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import type { MarkerUpdateOutcome } from "../../hooks/magic-context/compaction-marker-manager";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { CompactionMarkerStrategy } from "../../hooks/magic-context/transform-postprocess-phase";
import { sessionLog } from "../../shared/logger";
import { v2CompactionMarkerStrategy } from "./markers";

/**
 * Resolve the boundary the served array starts at, given the module's baseline end.
 *
 * OpenCode 1 answers this question by writing a compaction row: it picks the
 * nearest user message at or before the module's baseline end and serves the
 * conversation from there. OpenCode 2 has no such row, so the same rule is
 * applied here against the same raw projection. Keeping the rule identical is
 * what makes the two hosts hand the module the same array for the same baseline.
 *
 * Returns null when the baseline end is unknown or no user message precedes it,
 * which is the case a caller must treat as "do not move the boundary".
 */
export function resolveBoundaryUserMessage(
    messages: readonly RawMessage[],
    endMessageId: string,
): RawMessage | null {
    const end = messages.findIndex((message) => message.id === endMessageId);
    if (end < 0) return null;
    for (let index = end; index >= 0; index -= 1) {
        const candidate = messages[index];
        if (candidate && candidate.role === "user") return candidate;
    }
    return null;
}

/**
 * Marker lifecycle for Rust mode on OpenCode 2.
 *
 * On OpenCode 1 the module's materialized boundary becomes a real compaction row
 * in the host's store. OpenCode 2 exposes no way to write such a row, so the
 * boundary is recorded here instead, in the same `session_meta` columns the
 * OpenCode 1 marker state already uses.
 *
 * Only the carrier differs. The advance-only rule and the compare-and-swap on the
 * pending blob are the shared caller's, unchanged: this records a boundary that
 * moved forward and declines one that did not.
 */
export function createV2RustCompactionMarkerStrategy(
    /**
     * The nearest user turn at or before `endMessageId`, by the rule
     * `resolveBoundaryUserMessage` states; null when there is none. The caller
     * answers it from the store with a bounded backward read.
     */
    findBoundaryUserMessage: (sessionId: string, endMessageId: string) => RawMessage | null,
): CompactionMarkerStrategy {
    return {
        ...v2CompactionMarkerStrategy,
        applyDeferred: (db, sessionId, pending): MarkerUpdateOutcome => {
            const existing = getPersistedCompactionMarkerState(db as ContextDatabase, sessionId);
            if (existing && existing.boundaryOrdinal >= pending.ordinal) {
                return { kind: "already-current" };
            }
            let boundary: RawMessage | null = null;
            try {
                boundary = findBoundaryUserMessage(sessionId, pending.endMessageId);
            } catch (error) {
                return {
                    kind: "retryable-failure",
                    error: error instanceof Error ? error : new Error(String(error)),
                };
            }
            if (!boundary) {
                // Same rule as the OpenCode 1 drain: an unresolvable target leaves the
                // previous boundary in place rather than dropping back to full history.
                return {
                    kind: "retryable-failure",
                    error: new Error(
                        `no user boundary found at or before endMessageId ${pending.endMessageId} (ordinal ${pending.ordinal}); preserving existing boundary`,
                    ),
                };
            }
            // THIS RECORD HAS READERS — it is not bookkeeping for its own sake.
            // Three places read it back, and deleting the write breaks all three:
            //   1. `trimToRecordedBoundary` below, which is what bounds the array
            //      handed to the module on a host that wrote no compaction row;
            //   2. the post-fold restore in src/v2/hooks/context.ts, which uses
            //      `boundaryMessageId` to bound how much pre-cut history it puts
            //      back behind the host's compaction cut;
            //   3. `markerAt` / `persistedBoundaryOrdinal` in
            //      hooks/magic-context/rust-mode-transform.ts, which report the
            //      boundary on the coverage line and gate note-nudge publication.
            const state: PersistedCompactionMarkerState = {
                boundaryMessageId: boundary.id,
                // OpenCode 2 writes no summary message and no parts for it. The
                // columns stay in the record so every existing reader keeps its
                // shape; empty means "this host carries no marker rows".
                summaryMessageId: "",
                compactionPartId: "",
                summaryPartId: "",
                boundaryOrdinal: pending.ordinal,
                targetEndMessageId: pending.endMessageId,
            };
            setPersistedCompactionMarkerState(db as ContextDatabase, sessionId, state);
            sessionLog(
                sessionId,
                `v2 boundary recorded at ordinal ${pending.ordinal}, boundary message ${boundary.id}`,
            );
            return { kind: "applied", markerOrdinal: pending.ordinal };
        },
    };
}

/**
 * Drop everything before the recorded boundary from the array about to be sent.
 *
 * This is the trim OpenCode 1 gets for free from its compaction row. OpenCode 2
 * writes such a row only when it decides to compact, and a healthy Rust-mode
 * session folds before the host's own trigger is ever reached — so on the normal
 * path there is no host cut and this is the ONLY thing that keeps a folded
 * session from handing the module its whole history again on every later turn.
 * Measured with it removed: the array handed to the module grew from 15 to 53
 * messages over twenty post-fold turns while the boundary stood still.
 *
 * It is silent when the host HAS cut, because the boundary message is then
 * already gone from the array. An earlier pass mutated it under a fixture whose
 * mock reported a constant usage — which kept the host compacting on every turn,
 * and therefore always cutting — and concluded from the silence that it never
 * fires at all.
 *
 * Returns the number of messages removed. A boundary that is not in the array is
 * left alone: it either has not been reached yet or belongs to history the host
 * has already dropped, and guessing in either direction would change what the
 * model sees.
 */
export function trimToRecordedBoundary(
    db: ContextDatabase,
    sessionId: string,
    messages: Array<{ id?: string }>,
): number {
    const marker = getPersistedCompactionMarkerState(db, sessionId);
    const boundaryId = marker?.boundaryMessageId;
    if (!boundaryId) return 0;
    const start = messages.findIndex((message) => message.id === boundaryId);
    if (start <= 0) return 0;
    messages.splice(0, start);
    return start;
}
