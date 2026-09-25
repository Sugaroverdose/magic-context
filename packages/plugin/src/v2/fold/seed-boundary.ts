import type { ContextDatabase } from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { sessionLog } from "../../shared/logger";
import { hostServesRowById } from "../hooks/store";
import type { V2StoreReader } from "../store-reader";

/**
 * The most conversation a Rust-mode pass on OpenCode 2 hands the module for a session
 * that has no boundary yet.
 *
 * The module's first pass over a session is a full send, and its cost grows with the
 * message count: on a 10,000-message session it did not answer inside the cold-start
 * budget, so no pass ever completed, the delta protocol never got a base to build on,
 * and every turn fell back to the raw prompt and was refused as over the limit. A
 * thousand messages is far more than any model window the module could serve from,
 * and small enough that the first send completes.
 */
export const RUST_SEED_BOUNDARY_MESSAGES = 1_000;

/** Rows read per backward page while looking for a user turn to start from. */
const SEED_SEARCH_PAGE = 100;

export type SeedBoundaryReader = Pick<
    V2StoreReader,
    "messageCount" | "messagePage" | "rawRowsThrough" | "messageOrdinalById"
>;

/**
 * Give a long Rust-mode session that has no boundary one, so the module is handed a
 * bounded array from its first pass.
 *
 * On OpenCode 1 the host's own compaction row bounds what the module is sent, and the
 * delta protocol keeps each later pass to the new messages. OpenCode 2 hands the whole
 * session until the module records its first boundary, and a long session reopened in
 * Rust mode (converted from TypeScript mode, or started before Magic Context) never got
 * that far. This records a boundary at the user turn that starts the last
 * {@link RUST_SEED_BOUNDARY_MESSAGES} messages, in the same record the module's own
 * boundaries use, so the trim before the module and the restore after a host
 * checkpoint both start there and every later pass is a delta on a stable prefix.
 * Rows before it stay in the host's store; the module folds forward from the boundary
 * and its own later boundaries advance past this one.
 *
 * Does nothing when the session already has a boundary, when it is short enough to
 * send whole, or when no user turn the host serves by id starts a bounded tail.
 * Returns the seeded boundary's message id, or null.
 */
export function seedLongSessionBoundary(
    db: ContextDatabase,
    reader: SeedBoundaryReader,
    sessionID: string,
): string | null {
    if (getPersistedCompactionMarkerState(db, sessionID)?.boundaryMessageId) return null;
    const count = reader.messageCount(sessionID);
    if (count <= RUST_SEED_BOUNDARY_MESSAGES) return null;
    // The first message of the bounded tail, then back to the nearest user turn so the
    // array handed to the module begins where a turn begins.
    const firstKeptOrdinal = count - RUST_SEED_BOUNDARY_MESSAGES + 1;
    const first = reader.messagePage(sessionID, firstKeptOrdinal - 1, 1, count)[0];
    if (!first) return null;
    let through = first.seq;
    let boundary: { id: string } | undefined;
    for (;;) {
        const rows = reader.rawRowsThrough(sessionID, through, SEED_SEARCH_PAGE);
        boundary = rows.find((row) => row.type === "user" && hostServesRowById(row));
        const oldest = rows.at(-1);
        if (boundary || rows.length < SEED_SEARCH_PAGE || !oldest) break;
        through = oldest.seq - 1;
    }
    if (!boundary) return null;
    const ordinal = reader.messageOrdinalById(sessionID, boundary.id);
    if (ordinal === null || ordinal < 1) return null;
    setPersistedCompactionMarkerState(db, sessionID, {
        boundaryMessageId: boundary.id,
        summaryMessageId: "",
        compactionPartId: "",
        summaryPartId: "",
        // The module records the END of the history a boundary folds away; everything
        // before this turn is that history, so a boundary the module publishes later
        // inside the tail always lands past this one.
        boundaryOrdinal: ordinal - 1,
        targetEndMessageId: null,
    });
    sessionLog(
        sessionID,
        `v2 boundary seeded at ordinal ${ordinal - 1}, boundary message ${boundary.id}: ${count - ordinal + 1} of ${count} messages handed to the module for a long session with no boundary`,
    );
    return boundary.id;
}
