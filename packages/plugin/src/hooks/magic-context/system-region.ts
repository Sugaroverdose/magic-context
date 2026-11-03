import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";

/**
 * Durable store for the frozen system region (§3, frozen-system-region-residency
 * design). The region reuses `session_meta.cached_m0_bytes` — same payload,
 * different placement (owner ruling); the persistence layer is untouched.
 *
 * The reader contract is the real contract (R11): a row is served as region
 * bytes ONLY when it carries the sentinel this writer prepends. Anything else —
 * the head lane's m[0] baseline, a NULL, an absent row — reads as first-render
 * (null), never as content. The sentinel is storage metadata: stripped on read,
 * never part of the served bytes, and the serve path hands the model the
 * stored payload verbatim.
 */

export const SYSTEM_REGION_SENTINEL = "<!-- mc:system-region v1 -->";

const SENTINEL_BYTES = Buffer.from(SYSTEM_REGION_SENTINEL, "utf8");

function isCorruptUtf8(bytes: Buffer): boolean {
    const decoded = bytes.toString("utf8");
    if (!decoded.includes("\uFFFD")) return false;
    // A replacement char alone is not proof (it can be legitimate text); prove
    // corruption by requiring the re-encode to differ from the stored bytes.
    return !Buffer.from(decoded, "utf8").equals(bytes);
}

export function encodeSystemRegionRow(region: string): Buffer {
    return Buffer.concat([SENTINEL_BYTES, Buffer.from(region, "utf8")]);
}

/**
 * Decode a stored column value to the served region payload, or null when the
 * row is not a region (legacy/absent) or is a corrupt region. This is exactly
 * strip-the-sentinel: no trim, no newline fixups, no re-derivation — anything
 * beyond the strip is a byte change on the serve path and forbidden.
 */
export function decodeSystemRegionRow(
    value: Buffer | Uint8Array | string | null | undefined,
): string | null {
    if (value === null || value === undefined) return null;
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array | string);
    if (bytes.length === 0) return null;
    const startsWithSentinel =
        bytes.length >= SENTINEL_BYTES.length &&
        bytes.subarray(0, SENTINEL_BYTES.length).equals(SENTINEL_BYTES);
    if (!startsWithSentinel) {
        if (isCorruptUtf8(bytes)) return CORRUPT;
        return null;
    }
    const payload = bytes.subarray(SENTINEL_BYTES.length);
    if (payload.length === 0 || isCorruptUtf8(Buffer.from(payload))) return CORRUPT;
    return payload.toString("utf8");
}

// Internal marker: decode returns this for rows that can only have been
// written here yet cannot be served; callers must not confuse it with a
// legacy null. Exported nowhere; readSystemRegion maps it to a logged null.
const CORRUPT = Symbol("system-region corrupt") as unknown as string;

export function readSystemRegion(db: Database, sessionId: string): string | null {
    const row = db
        .prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { cached_m0_bytes: Buffer | Uint8Array | string | null } | undefined;
    if (!row) return null;
    const decoded = decodeSystemRegionRow(row.cached_m0_bytes);
    if (decoded === CORRUPT) {
        // Honest store: a region the reader cannot serve is named, not
        // silently treated as absent (the LKG wipe lesson).
        sessionLog(
            sessionId,
            "system-region read declined session=" + sessionId + " reason=corrupt",
        );
        return null;
    }
    return decoded;
}

export function writeSystemRegion(db: Database, sessionId: string, region: string): boolean {
    if (region.startsWith(SYSTEM_REGION_SENTINEL)) {
        // A payload that forges the sentinel would decode one layer short on
        // the serve path. The assembler emits panel-tagged content, so this is
        // a structural refusal, not a policy one.
        sessionLog(
            sessionId,
            `system-region write declined session=${sessionId} reason=sentinel_collision`,
        );
        return false;
    }
    db.prepare(
        "INSERT INTO session_meta (session_id, cached_m0_bytes) VALUES (?, ?) " +
            "ON CONFLICT(session_id) DO UPDATE SET cached_m0_bytes = excluded.cached_m0_bytes",
    ).run(sessionId, encodeSystemRegionRow(region));
    return true;
}

export function clearSystemRegion(db: Database, sessionId: string, reason: string): void {
    // Destructive arms leave receipts, same law as the LKG store.
    sessionLog(sessionId, `system-region cleared reason=${reason}`);
    db.prepare("UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ?").run(
        sessionId,
    );
}
