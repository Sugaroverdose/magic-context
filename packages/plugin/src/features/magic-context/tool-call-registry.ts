import type { Database } from "../../shared/sqlite";

export interface CallIdTagRow {
    tag_number: number;
    message_id: string;
    status: string;
    type: string;
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
 * indexed equality per id — no host-store access. The ORDER BY prefers the
 * live instance when a call id was reused across turns (the composite-
 * identity hazard) — the model points at what it can see.
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
                  LIMIT 1`,
            );
            for (const callId of callIds) {
                if (map.has(callId)) continue;
                const row = statement.get(sessionId, callId) as CallIdTagRow | null | undefined;
                map.set(callId, row ?? undefined);
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
