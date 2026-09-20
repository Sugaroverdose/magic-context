import {
    addMergedReasoningStrippedIds,
    getMergedReasoningStrippedIds,
} from "../../features/magic-context/storage-meta-persisted";
import type { Database } from "../../shared/sqlite";

// This reserved non-message ID shares the session-owned reasoning replay ledger.
// Older readers ignore unknown entries, so no schema migration is necessary.
export const TOOL_SWEEP_SCOPED_MARKER = "@tool-sweep-scoped";

/** Restore unrelated reasoning-only messages only when a cache-busting pass permits byte changes. */
export function useScopedToolSweep(db: Database, sessionId: string, canAdopt: boolean): boolean {
    if (getMergedReasoningStrippedIds(db, sessionId).has(TOOL_SWEEP_SCOPED_MARKER)) return true;
    if (!canAdopt) return false;
    return addMergedReasoningStrippedIds(db, sessionId, [TOOL_SWEEP_SCOPED_MARKER]);
}
