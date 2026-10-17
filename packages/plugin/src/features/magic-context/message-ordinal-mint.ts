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
        return { ordinalByMessageId };
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
