import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import {
    ReplayDocumentError,
    readReplayEnvelope,
    updateReplayDocument,
} from "./storage-replay-document";

/**
 * Which caveman rule set a session's compressed text tags are served with,
 * stored as its own namespace in the per-session replay document, so no schema
 * change is needed.
 *
 * Replay recomputes compressed text from the original on every pass, so the
 * rule set has to be persisted. A session that has never recorded one was
 * compressed by the original rules and keeps replaying them, byte for byte,
 * until caveman cleanup runs on a pass that already rebuilds the provider
 * cache. That pass records the current rules and rewrites every compressed tag
 * with them, and every later pass replays the current rules.
 *
 * `legacyReasoningTags` lists the tags compressed before that switch. The
 * original rules also took the reasoning of each compressed message off the
 * wire; those messages keep that, since putting the reasoning back would
 * change bytes the provider already cached. Tags compressed after the switch
 * keep their reasoning.
 */
const NAMESPACE = "caveman";
const CURRENT_RULES_VERSION = 2;

export interface CavemanReplayState {
    currentRules: boolean;
    legacyReasoningTags: ReadonlySet<number>;
}

const ORIGINAL_RULES: CavemanReplayState = { currentRules: false, legacyReasoningTags: new Set() };

function parseState(lane: unknown): CavemanReplayState {
    if (!isRecord(lane) || lane.rules !== CURRENT_RULES_VERSION) return ORIGINAL_RULES;
    const tags = Array.isArray(lane.legacyReasoningTags) ? lane.legacyReasoningTags : [];
    return {
        currentRules: true,
        legacyReasoningTags: new Set(
            tags.filter((tag): tag is number => Number.isSafeInteger(tag) && tag > 0),
        ),
    };
}

/**
 * The session's caveman replay state. A document that cannot be read answers
 * with the original rules, which is what the session served before it recorded
 * anything.
 */
export function getCavemanReplayState(db: Database, sessionId: string): CavemanReplayState {
    try {
        return parseState(readReplayEnvelope(db, sessionId)[NAMESPACE]);
    } catch (error) {
        if (error instanceof ReplayDocumentError) return ORIGINAL_RULES;
        throw error;
    }
}

/**
 * Record that the session's compressed text now uses the current rules, with
 * the tags compressed before the switch. Returns the persisted state, which is
 * the earlier one when the switch was already recorded, or null when the
 * document could not be written; the caller must then keep the original rules.
 */
export function markCavemanCurrentRules(
    db: Database,
    sessionId: string,
    legacyReasoningTags: Iterable<number>,
): CavemanReplayState | null {
    const tags = [...new Set(legacyReasoningTags)].sort((a, b) => a - b);
    const persisted = updateReplayDocument(db, sessionId, (doc) => {
        if (parseState(doc[NAMESPACE]).currentRules) return false;
        doc.version = 2;
        doc[NAMESPACE] = { rules: CURRENT_RULES_VERSION, legacyReasoningTags: tags };
        return true;
    });
    if (!persisted) return null;
    const state = getCavemanReplayState(db, sessionId);
    return state.currentRules ? state : null;
}
