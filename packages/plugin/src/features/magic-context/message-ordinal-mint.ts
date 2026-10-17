import { openOpenCodeDb } from "./dreamer/open-opencode-db";
import type { OrdinalMint } from "./reduce-resolver";

/**
 * The message-ordinal mint: positions of the session's messages in the
 * canonical raw-message ordinal space — host `message` rows ordered by
 * (time_created, id), 1-based. This is the same seek ctx_expand(message=N)
 * reads from (read-session-raw), so a minted ordinal is consumable by the
 * vanilla expansion route by construction.
 *
 * The mirror's stored message_ordinal is deliberately NOT used: ordinals are
 * positional and the mirror stores them at index time, so a mid-history
 * insert leaves the stored values stale for the tail; the mint recomputes
 * from the host table, the current truth. Read-only over the host store —
 * no schema, no writes, same property as the call-id bridge.
 *
 * Production key domains (verified against the live stores): registry
 * message rows carry the suffixed content key `base:pK`, registry tool rows
 * carry the WIRE callID (host part data `$.callID` — not part.id), and the
 * FTS mirror carries bare message ids. The mint therefore maps ALL domains
 * the resolver can hold: bare message ids, wire call ids (to their owner
 * message's ordinal), and the newest user-message boundary for the bulk lane.
 */
export function createHostOrdinalMint(sessionId: string): OrdinalMint | undefined {
    const hostDb = openOpenCodeDb();
    if (!hostDb) return undefined;
    try {
        const rows = hostDb
            .prepare(
                `SELECT id, ROW_NUMBER() OVER (ORDER BY time_created ASC, id ASC) AS ordinal
                   FROM message
                  WHERE session_id = ?`,
            )
            .all(sessionId) as unknown as { id: string; ordinal: number }[];
        const ordinalByMessageId = new Map<string, number>();
        for (const row of rows) {
            ordinalByMessageId.set(row.id, row.ordinal);
        }
        // Wire callID -> owner message ordinal. The host stores the provider
        // call id inside the part's data JSON (part.id is a prt_* row id).
        const ordinalByCallId = new Map<string, number>();
        const partRows = hostDb
            .prepare(
                `SELECT json_extract(p.data, '$.callID') AS call_id, m.ordinal
                   FROM part p
                   JOIN (
                     SELECT id, ROW_NUMBER() OVER (ORDER BY time_created ASC, id ASC) AS ordinal
                       FROM message WHERE session_id = ?
                   ) m ON m.id = p.message_id
                  WHERE p.session_id = ?
                    AND json_extract(p.data, '$.type') = 'tool'`,
            )
            .all(sessionId, sessionId) as unknown as { call_id: string | null; ordinal: number }[];
        for (const row of partRows) {
            if (row.call_id) ordinalByCallId.set(row.call_id, row.ordinal);
        }
        let latestUserOrdinal: number | undefined;
        const userRows = hostDb
            .prepare(
                `SELECT id FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user'`,
            )
            .all(sessionId) as unknown as { id: string }[];
        for (const row of userRows) {
            const ordinal = ordinalByMessageId.get(row.id);
            if (typeof ordinal === "number" && (latestUserOrdinal === undefined || ordinal > latestUserOrdinal)) {
                latestUserOrdinal = ordinal;
            }
        }
        return { ordinalByMessageId, ordinalByCallId, latestUserOrdinal };
    } catch {
        return undefined;
    } finally {
        try {
            hostDb.close();
        } catch {
            // closed best-effort
        }
    }
}
