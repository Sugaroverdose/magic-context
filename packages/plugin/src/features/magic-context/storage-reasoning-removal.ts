import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import {
    type ReplayDocument,
    readReplayDocument,
    updateReplayDocument,
} from "./storage-replay-document";

/**
 * Persisted state of the reasoning-removal lanes, stored as its own namespace
 * in the per-session replay document, next to `piNative`, so no schema change
 * is needed.
 *
 * - `messageIds`: assistant messages whose old reasoning parts are removed.
 *   The set only grows. It is first written on a pass that already rebuilds
 *   the provider cache and is replayed verbatim on every later pass, so a
 *   removed reasoning block never comes back and a defer pass never removes a
 *   new one.
 * - `dropLeavesReasoning`: set on the session's first rebuilding pass after
 *   upgrade. Until then, drops replay the bytes they served before (reasoning
 *   with `[cleared]` text) on routes other than canonical Anthropic, so the
 *   change in what a drop does to reasoning first lands on a rebuilding pass.
 */
const NAMESPACE = "reasoningRemoval";

export interface ReasoningRemovalState {
    messageIds: Set<string>;
    dropLeavesReasoning: boolean;
}

function invalidState(sessionId: string): Error {
    return new Error(`invalid persisted reasoning removal state for session ${sessionId}`);
}

function parseState(doc: ReplayDocument, sessionId: string): ReasoningRemovalState {
    const lane = doc[NAMESPACE];
    if (lane === undefined) return { messageIds: new Set(), dropLeavesReasoning: false };
    if (!isRecord(lane) || !Array.isArray(lane.messageIds)) throw invalidState(sessionId);
    const ids = new Set<string>();
    for (const id of lane.messageIds) {
        if (typeof id !== "string" || id.length === 0) throw invalidState(sessionId);
        ids.add(id);
    }
    if (lane.dropLeavesReasoning !== undefined && typeof lane.dropLeavesReasoning !== "boolean") {
        throw invalidState(sessionId);
    }
    return { messageIds: ids, dropLeavesReasoning: lane.dropLeavesReasoning === true };
}

function writeState(doc: ReplayDocument, state: ReasoningRemovalState): void {
    doc.version = 2;
    doc[NAMESPACE] = {
        messageIds: [...state.messageIds],
        ...(state.dropLeavesReasoning ? { dropLeavesReasoning: true } : {}),
    };
}

/**
 * Return the persisted state. A document without the namespace is empty; a
 * malformed namespace throws so the caller can refuse to select new removals
 * and fall back to its last good copy instead of silently starting empty.
 */
export function getReasoningRemovalState(db: Database, sessionId: string): ReasoningRemovalState {
    return parseState(readReplayDocument(db, sessionId), sessionId);
}

export function getRemovedReasoningIds(db: Database, sessionId: string): Set<string> {
    return getReasoningRemovalState(db, sessionId).messageIds;
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
        const current = parseState(doc, sessionId);
        let changed = false;
        for (const id of requested) {
            if (current.messageIds.has(id)) continue;
            current.messageIds.add(id);
            changed = true;
        }
        if (!changed) return false;
        writeState(doc, current);
        return true;
    });
}

/** Record that drops now leave reasoning to the age lane. False when not written. */
export function markDropLeavesReasoning(db: Database, sessionId: string): boolean {
    return updateReplayDocument(db, sessionId, (doc) => {
        const current = parseState(doc, sessionId);
        if (current.dropLeavesReasoning) return false;
        current.dropLeavesReasoning = true;
        writeState(doc, current);
        return true;
    });
}
