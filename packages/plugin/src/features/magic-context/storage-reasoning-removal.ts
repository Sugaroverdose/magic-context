import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import {
    type ReplayDocument,
    readReplayDocument,
    updateReplayDocument,
} from "./storage-replay-document";

/**
 * Frozen set of assistant message ids whose old reasoning parts are removed
 * from the served array. Stored as its own namespace in the per-session replay
 * document, next to `piNative`, so no schema change is needed.
 *
 * The set only grows. It is first written on a pass that already rebuilds the
 * provider cache and is replayed verbatim on every later pass, so a removed
 * reasoning block never comes back and a defer pass never removes a new one.
 */
const NAMESPACE = "reasoningRemoval";

function invalidState(sessionId: string): Error {
    return new Error(`invalid persisted reasoning removal state for session ${sessionId}`);
}

function parseRemovedIds(doc: ReplayDocument, sessionId: string): Set<string> {
    const lane = doc[NAMESPACE];
    if (lane === undefined) return new Set();
    if (!isRecord(lane) || !Array.isArray(lane.messageIds)) throw invalidState(sessionId);
    const ids = new Set<string>();
    for (const id of lane.messageIds) {
        if (typeof id !== "string" || id.length === 0) throw invalidState(sessionId);
        ids.add(id);
    }
    return ids;
}

/**
 * Return the persisted removal set. A document without the namespace is empty;
 * a malformed namespace throws so the caller can refuse to select new removals
 * instead of silently starting from an empty set.
 */
export function getRemovedReasoningIds(db: Database, sessionId: string): Set<string> {
    return parseRemovedIds(readReplayDocument(db, sessionId), sessionId);
}

/**
 * Atomically union new ids into the persisted set. Returns false when the
 * document could not be written; the caller must then apply nothing new.
 */
export function addRemovedReasoningIds(
    db: Database,
    sessionId: string,
    ids: Iterable<string>,
): boolean {
    const requested = [...ids].filter((id) => typeof id === "string" && id.length > 0);
    if (requested.length === 0) return true;
    return updateReplayDocument(db, sessionId, (doc) => {
        const current = parseRemovedIds(doc, sessionId);
        let changed = false;
        for (const id of requested) {
            if (current.has(id)) continue;
            current.add(id);
            changed = true;
        }
        if (!changed) return false;
        doc.version = 2;
        doc[NAMESPACE] = { messageIds: [...current] };
        return true;
    });
}
