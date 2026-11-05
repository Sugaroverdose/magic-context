import { log, sessionLog } from "../../shared/logger";
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
    // H3 write-site property: installing a region retires the head-era
    // baseline boundary — no Pi path may derive trim decisions from a
    // boundary that no longer describes the served bytes. Column-safe: the
    // store writer must work on minimal pre-boundary schemas (R11 fixtures).
    const hasBoundary = (
        db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>
    ).some((c) => c.name === "cached_m0_last_baseline_end_message_id");
    db.prepare(
        "INSERT INTO session_meta (session_id, cached_m0_bytes) VALUES (?, ?) " +
            "ON CONFLICT(session_id) DO UPDATE SET cached_m0_bytes = excluded.cached_m0_bytes" +
            (hasBoundary ? ", cached_m0_last_baseline_end_message_id = NULL" : ""),
    ).run(sessionId, encodeSystemRegionRow(region));
    return true;
}

/**
 * Mint-site sanitizer for store-derived receipt operands (H1). Reasons that
 * interpolate stored text (render_config:budget(<stored>→<current>)) must
 * arrive at the funnel already receipt-safe: the funnel no longer fatals on
 * spelling (K1 — see sanitizeReasonToken), but a violation receipt per pass
 * would flood the log, so composites sanitize at the mint. Whitespace
 * collapses to "_", backticks
 * (template-delimiter hazards) to "'", each operand clamps to `maxLen` with
 * a trailing "~" so truncation is visible in the receipt.
 */
export function sanitizeReceiptOperand(value: string, maxLen = 40): string {
    const flat = value.replace(/\s+/g, "_").replace(/`/g, "'");
    return flat.length > maxLen ? `${flat.slice(0, maxLen - 1)}~` : flat;
}

// Stem law + optional non-whitespace detail (render_config:budget(...)-style
// composite receipts keep their exact operands, L7 precedent). Whitespace in
// a reason would break the key=value shape of the receipt line.
const REASON_TOKEN = /^[a-z][a-z0-9_]{2,47}(?::[^\s]{1,120})?$/;

/**
 * K1 ruling (round 8): the floor is non-fatal. A reason is receipt text,
 * not policy — wedging the fold lane to enforce a spelling is
 * mechanism-broken, because a throw inside the materialization transaction
 * re-mints and re-throws every pass: the fold that would rewrite the row is
 * what throws. No mint census can be exhaustive (return-position templates,
 * concat assembly, third-file helpers all evade), so the class must be
 * unreachable at the funnel: violations collapse to the legal grammar shape
 * and the RAW token is preserved verbatim (JSON-quoted) in a loud
 * receipt-violation line. Programmer typos stay caught by the test-time
 * grammar laws and the mint census; production never wedges on spelling.
 */
export function sanitizeReasonToken(fn: string, sessionId: string | null, reason: string): string {
    if (REASON_TOKEN.test(reason)) return reason;
    const flat = reason.replace(/\s+/g, "_").replace(/`/g, "'");
    const stemMatch = /^[a-z][a-z0-9_]{2,47}/.exec(flat);
    const stem = stemMatch ? stemMatch[0] : "malformed";
    const rest = (stemMatch ? flat.slice(stemMatch[0].length) : flat)
        .replace(/^:/, "")
        .slice(0, 120);
    const sanitized = rest ? `${stem}:${rest}` : stem;
    const line = `system-region receipt-violation: fn=${fn} raw=${JSON.stringify(reason)} sanitized=${sanitized}`;
    if (sessionId) sessionLog(sessionId, line);
    else log(line);
    return sanitized;
}

export function clearSystemRegion(db: Database, sessionId: string, reason: string): void {
    reason = sanitizeReasonToken("clearSystemRegion", sessionId, reason);
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
    reason = sanitizeReasonToken("clearAllSystemRegions", null, reason);
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
    reason = sanitizeReasonToken("clearSystemRegionsByProjectIdentity", null, reason);
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
 * half of the `mustMaterialize` set. The delta-class fields (compartment
 * sequence, profile version, memory watermark, docs hash) are NOT compared
 * members: they ride the volatile segment and are absorbed on folds
 * (DELTA_TRIGGER_FIELDS, empty by owner ruling).
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
    /** Render template of the `<user-profile>` block: a content trigger because
     *  the template bytes themselves change (a shipped template change adopts
     *  once per session at a bust-gated boundary). */
    profileRenderEpoch: string;
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
    ["profileRenderEpoch", "profile_render_epoch"],
];

/**
 * The delta-class fields — EMPTY by owner ruling (region-only Task 3).
 * Cheapness came from placement behind the cached prefix, not from boundary
 * timing: delta-class content (new memories, published compartments, profile
 * promotions, docs edits) rides the volatile segment (region-volatile.ts)
 * and is absorbed on folds. These fields are retained in RegionMarkers as
 * the fence anchor: re-adding an entry here must go red on the per-field
 * production-composition demotion laws (system-region-wiring.test.ts) —
 * they bump the live store through real writers and pin the promotion call
 * site's composition, so a re-added trigger cannot survive a CI pass
 * unnoticed. The only bust deciders are the window manager (scheduler
 * folds) and the harness (system hash); everything else schedules changes
 * onto the volatile segment.
 */
const DELTA_TRIGGER_FIELDS: ReadonlyArray<readonly [keyof RegionMarkers, string]> = [];

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
    // No pending-size fields: the pending-growth arm was deleted (§25.3) —
    // the four DELTA markers above already measure every pending growth
    // axis with its own reason token, and the region is the m[0] analogue
    // (a baseline, never a volatile delta to cap). The head-lane pressure
    // precedent (inject-compartments.ts:4272-4305) caps m[1] DELTA tokens,
    // never m[0] size. Re-adding a size arm requires a real delta measure.
}

export function decideSystemRegionRotation(
    args: SystemRegionRotationInput,
): SystemRegionRotationDecision {
    // Every arm is bust-gated (A3 / L4): a rotation rewrites served bytes, so
    // it is itself a bust and requires the single per-pass permission. No
    // caller may treat a rotate=true verdict as licensed work on a pass that
    // is not already busting — install (first_render / missing_markers) is
    // the fold lane's job (mustMaterialize region_first_install), which is
    // itself a boundary. The promotion caller passes true only after its
    // boundaryPermission check upstream (transform-postprocess-phase).
    if (!args.bustPermission) return { rotate: false, reason: "none" };
    if (args.storedRegion === null) return { rotate: true, reason: "first_render" };
    if (args.capturedMarkers === null) return { rotate: true, reason: "missing_markers" };
    for (const [field, reason] of CONTENT_TRIGGER_FIELDS) {
        if (args.capturedMarkers[field] !== args.currentMarkers[field]) {
            return { rotate: true, reason };
        }
    }
    for (const [field, reason] of DELTA_TRIGGER_FIELDS) {
        if (args.capturedMarkers[field] !== args.currentMarkers[field]) {
            return { rotate: true, reason };
        }
    }
    if (args.forceBand) return { rotate: true, reason: "force_band" };
    // The pending-growth arm is deleted (§25.3): it received the absolute
    // stored-region size as if it were an un-folded delta, storming every
    // large-region session on every boundary pass. Since Unit 2 the delta
    // class is carried by the volatile segment (region-volatile.ts) and
    // growth is a fold REQUEST queued onto the named boundary (Task 1
    // Step 4b) — never a rotation decided here; DELTA_TRIGGER_FIELDS is
    // empty by owner ruling, its loop above stays only as the extension
    // point shape.
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
    reason = sanitizeReasonToken("executeSystemRegionRotation", sessionId, reason);
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
