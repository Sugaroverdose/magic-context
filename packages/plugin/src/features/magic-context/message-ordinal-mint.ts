import type { Database } from "../../shared/sqlite";
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
export function createHostOrdinalMint(mcDb: Database, sessionId: string): OrdinalMint | undefined {
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
        // Wire callID -> owner message ordinal, from the registry: tool rows
// key on the wire call id and carry `tool_owner_message_id`, covered by
// idx_tags_tool_composite — an index range read. The host part scan
// (json_extract over every session part, ~1.6 s at 64K parts) is not
// needed: the resolver only ever asks for call ids it resolved through
// the registry, and every registered call is here.
        const ordinalByCallId = new Map<string, number>();
        const toolRows = mcDb
            .prepare(
                `SELECT message_id, tool_owner_message_id
                   FROM tags
                  WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id IS NOT NULL`,
            )
            .all(sessionId) as unknown as { message_id: string; tool_owner_message_id: string }[];
        for (const row of toolRows) {
            const ordinal = ordinalByMessageId.get(row.tool_owner_message_id);
            if (ordinal !== undefined) ordinalByCallId.set(row.message_id, ordinal);
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
