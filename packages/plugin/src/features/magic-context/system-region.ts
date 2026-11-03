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

/** True when stored bytes begin with the region sentinel: the row belongs to
 *  this store, not to a head-lane reader. Every lane that reads the shared
 *  column as head content must refuse such rows (cross-lane discrimination). */
export function isSystemRegionBytes(bytes: Uint8Array | null | undefined): boolean {
    if (!bytes || bytes.byteLength < SENTINEL_BYTES.length) return false;
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .subarray(0, SENTINEL_BYTES.length)
        .equals(SENTINEL_BYTES);
}

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
        sessionLog(sessionId, `system-region read declined session=${sessionId} reason=corrupt`);
        return null;
    }
    return decoded;
}

export function writeSystemRegion(db: Database, sessionId: string, region: string): boolean {
    if (typeof region !== "string" || region.length === 0) {
        // The region is never empty (placeholder-floor law, same reason as m[1]:
        // an empty head slot is a provider-structure risk and a silent no-op
        // rotation that would still capture markers and claim success).
        sessionLog(
            sessionId,
            `system-region write declined session=${sessionId} reason=empty_region`,
        );
        return false;
    }
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
    // Destructive arms leave receipts, same law as the LKG store — and only
    // for actual events: clearing an absent region is not an event.
    const result = db
        .prepare(
            "UPDATE session_meta SET cached_m0_bytes = NULL WHERE session_id = ? AND cached_m0_bytes IS NOT NULL",
        )
        .run(sessionId);
    if ((result.changes ?? 0) > 0) {
        sessionLog(sessionId, `system-region cleared reason=${reason}`);
    }
}

/**
 * Bulk clear for maintenance passes (identity merge, migrations).
 * A single statement (atomic on its own — never a SELECT-then-loop, which
 * can erase rows published between the read and the writes and undercount
 * the receipt); one receipt with the true affected count.
 */
export function clearAllSystemRegions(db: Database, reason: string): number {
    // Column-safe: pre-region schemas have nothing to clear and no column to
    // name (migration fixtures legitimately start below its introduction).
    const cols = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>;
    if (!cols.some((c) => c.name === "cached_m0_bytes")) return 0;
    const result = db
        .prepare("UPDATE session_meta SET cached_m0_bytes = NULL WHERE cached_m0_bytes IS NOT NULL")
        .run();
    const cleared = result.changes ?? 0;
    if (cleared > 0) sessionLog("", `system-region cleared reason=${reason} count=${cleared}`);
    return cleared;
}

export function clearSystemRegionsByProjectIdentity(
    db: Database,
    identities: string[],
    reason: string,
): number {
    if (identities.length === 0) return 0;
    const placeholders = identities.map(() => "?").join(", ");
    const result = db
        .prepare(
            `UPDATE session_meta SET cached_m0_bytes = NULL WHERE cached_m0_bytes IS NOT NULL AND cached_m0_project_identity IN (${placeholders})`,
        )
        .run(...identities);
    const cleared = result.changes ?? 0;
    if (cleared > 0) {
        sessionLog(
            "",
            `system-region cleared reason=${reason} count=${cleared} identities=${identities.length}`,
        );
    }
    return cleared;
}

/**
 * The marker set captured at the last rotation, mirroring the `cached_m0_*`
 * columns. Rotation eligibility is a pure comparison of the current store
 * markers against this snapshot; the comparison list is the content-trigger
 * half of the `mustMaterialize` set, and the deliberate non-triggers (compartment
 * sequence, profile version, memory watermark, docs hash) are absent by
 * construction — new history and new memories are deltas, not boundaries.
 */
export interface RegionMarkers {
    projectMemoryEpoch: number;
    maxCompartmentSeq: number;
    maxMemoryId: number;
    maxMutationId: number;
    maxMemoryMutationId: number;
    projectDocsHash: string;
    upgradeState: string;
    compartmentRenderEpoch: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
    memoryRenderEpoch: string | null;
    renderedBudgets: string | null;
    profileVersion: number;
}

const CONTENT_TRIGGER_FIELDS: ReadonlyArray<readonly [keyof RegionMarkers, string]> = [
    ["projectMemoryEpoch", "project_memory_epoch"],
    ["maxMutationId", "max_mutation_id"],
    ["maxMemoryMutationId", "max_memory_mutation_id"],
    ["upgradeState", "upgrade_state"],
    ["compartmentRenderEpoch", "compartment_render_epoch"],
    ["muralEnabled", "mural_enabled"],
    ["renderBudgetIdentity", "render_budget_identity"],
    ["memoryRenderEpoch", "memory_render_epoch"],
    ["renderedBudgets", "rendered_budgets"],
];

/**
 * The head-lane m[1]-delta fields. They are deliberate non-triggers of the
 * m[0] HARD fold because they used to re-render m[1] on every cache-busting
 * pass; region mode has no m[1], so that role transfers to a rotation trigger
 * gated on the bust permission — they surface on exactly the passes where
 * m[1] used to refresh, and never originate a bust of their own.
 */
const DELTA_TRIGGER_FIELDS: ReadonlyArray<readonly [keyof RegionMarkers, string]> = [
    ["maxMemoryId", "max_memory_id"],
    ["maxCompartmentSeq", "max_compartment_seq"],
    ["profileVersion", "profile_version"],
    ["projectDocsHash", "project_docs_hash"],
];

export interface SystemRegionRotationDecision {
    rotate: boolean;
    reason: string;
}

export interface SystemRegionRotationInput {
    storedRegion: string | null;
    capturedMarkers: RegionMarkers | null;
    currentMarkers: RegionMarkers;
    /** The single per-pass bust permission (R12 `systemReclaimAllowed` shape). */
    bustPermission: boolean;
    forceBand?: boolean;
    pendingBytes?: number;
    pendingBytesCap?: number;
    pendingBytesMinFloor?: number;
}

export function decideSystemRegionRotation(
    args: SystemRegionRotationInput,
): SystemRegionRotationDecision {
    if (args.storedRegion === null) return { rotate: true, reason: "first_render" };
    if (args.capturedMarkers === null) return { rotate: true, reason: "missing_markers" };
    for (const [field, reason] of CONTENT_TRIGGER_FIELDS) {
        if (args.capturedMarkers[field] !== args.currentMarkers[field]) {
            return { rotate: true, reason };
        }
    }
    // Pressure arms and the m[1]-delta triggers are ride-only: they fire only
    // on a pass that is already busting (invariant 4 — automatic reclaim never
    // originates a bust).
    if (args.bustPermission) {
        for (const [field, reason] of DELTA_TRIGGER_FIELDS) {
            if (args.capturedMarkers[field] !== args.currentMarkers[field]) {
                return { rotate: true, reason };
            }
        }
        if (args.forceBand) return { rotate: true, reason: "force_band" };
        if (
            args.pendingBytes !== undefined &&
            args.pendingBytesCap !== undefined &&
            args.pendingBytes > args.pendingBytesCap &&
            (args.pendingBytesMinFloor === undefined ||
                args.pendingBytes >= args.pendingBytesMinFloor)
        ) {
            return { rotate: true, reason: "pending_growth" };
        }
    }
    return { rotate: false, reason: "none" };
}

/**
 * Install a freshly assembled region and print the rotation receipt beside the
 * fold line. Refusals are loud too: `executed=false` on the same line shape,
 * so a rotation that decided but did not land can never pass as silent success.
 */
export function executeSystemRegionRotation(
    db: Database,
    sessionId: string,
    reason: string,
    region: string,
    capturedMarkers: RegionMarkers,
    persist?: (regionBlob: Buffer, markers: RegionMarkers) => void,
): boolean {
    // Same admission as the store's own writer: empty and sentinel-forging
    // payloads are refused on every path, persist-callback included.
    const valid =
        typeof region === "string" &&
        region.length > 0 &&
        !region.startsWith(SYSTEM_REGION_SENTINEL);
    let ok = false;
    if (valid) {
        if (persist) {
            persist(encodeSystemRegionRow(region), capturedMarkers);
            ok = true;
        } else {
            ok = writeSystemRegion(db, sessionId, region);
        }
    }
    sessionLog(
        sessionId,
        `system-region rotation: reason=${reason} executed=${ok ? "true" : "false"} bytes=${valid ? Buffer.byteLength(region) : -1}`,
    );
    return ok;
}
