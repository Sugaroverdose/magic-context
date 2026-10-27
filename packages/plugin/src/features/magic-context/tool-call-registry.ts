import type { Database } from "../../shared/sqlite";

export interface CallIdTagRow {
    tag_number: number;
    message_id: string;
    status: string;
    type: string;
    /**
     * The row names more than one visible occurrence of this id. Not
     * observed on this install (census 2026-10-27: 0 duplicate (session,
     * call-id) pairs across 55,512 opencode tool tags; Pi's 152 duplicate
     * pairs are same-call re-mints and resolve through the Pi resolver's
     * live-preference path). Kept as defensive law: a loose OpenAI-compatible
     * serve that mints turn-local ids would otherwise resolve silently to the
     * wrong occurrence.
     */
    ambiguous?: boolean;
}

export interface CallIdTagResolver {
    /**
     * Map each input call id to its registry row, or `undefined` for ids
     * that name no call in this session (foreign ids, pruned parts).
     */
    resolve(callIds: readonly string[]): Map<string, CallIdTagRow | undefined>;
}

/**
 * Wire call id -> registry tag: tool rows key themselves by the wire call id
 * in `message_id` (`idx_tags_session_message_id`), so the pairing is one
 * indexed equality per id — no host-store access. A call id reused across
 * turns is never resolved by preference: with more than one occurrence still
 * visible (not `compacted`) the row is flagged `ambiguous` and the pointing
 * lane refuses; a closed (compacted) twin leaves the visible one resolved.
 */
export function createRegistryCallIdResolver(db: Database, sessionId: string): CallIdTagResolver {
    return {
        resolve(callIds) {
            const map = new Map<string, CallIdTagRow | undefined>();
            const statement = db.prepare(
                `SELECT tag_number, message_id, status, type
                   FROM tags
                  WHERE session_id = ? AND message_id = ? AND type = 'tool'
                  ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, tag_number DESC
                  LIMIT 2`,
            );
            for (const callId of callIds) {
                if (map.has(callId)) continue;
                const rows = statement.all(sessionId, callId) as CallIdTagRow[];
                if (rows.length === 0) {
                    map.set(callId, undefined);
                    continue;
                }
                const visible = rows.filter((row) => row.status !== "compacted");
                if (visible.length > 1) {
                    map.set(callId, { ...visible[0], ambiguous: true });
                    continue;
                }
                map.set(callId, visible[0] ?? rows[0]);
            }
            return map;
        },
    };
}

/**
 * Attach a copyable wire call id to each reclaim hint. Tool rows' `message_id`
 * IS the wire call id, so enrichment is a column read — the hint never
 * invents an identifier the registry does not carry.
 */
export function enrichReclaimHintsWithCallIds<
    T extends { tagNumber: number; callId?: string | null },
>(db: Database, sessionId: string, hints: readonly T[]): T[] {
    if (hints.length === 0) return [];
    const statement = db.prepare(
        `SELECT message_id FROM tags WHERE session_id = ? AND tag_number = ? AND type = 'tool'`,
    );
    return hints.map((hint) => {
        if (hint.callId) return hint;
        const row = statement.get(sessionId, hint.tagNumber) as { message_id: string } | undefined;
        return row ? { ...hint, callId: row.message_id } : hint;
    });
}
