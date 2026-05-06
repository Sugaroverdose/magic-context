import { getHarness } from "../../shared/harness";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import type { TagEntry } from "./types";

const insertTagStatements = new WeakMap<Database, PreparedStatement>();
const updateTagStatusStatements = new WeakMap<Database, PreparedStatement>();
const updateTagDropModeStatements = new WeakMap<Database, PreparedStatement>();
const updateTagMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getTagNumbersByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const deleteTagsByMessageIdStatements = new WeakMap<Database, PreparedStatement>();
const getMaxTagNumberBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getTagNumberByMessageIdStatements = new WeakMap<Database, PreparedStatement>();

function getInsertTagStatement(db: Database): PreparedStatement {
    let stmt = insertTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO tags (session_id, message_id, type, byte_size, reasoning_byte_size, tag_number, tool_name, input_byte_size, harness, tool_owner_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        );
        insertTagStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagStatusStatement(db: Database): PreparedStatement {
    let stmt = updateTagStatusStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET status = ? WHERE session_id = ? AND tag_number = ?");
        updateTagStatusStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagDropModeStatement(db: Database): PreparedStatement {
    let stmt = updateTagDropModeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET drop_mode = ? WHERE session_id = ? AND tag_number = ?");
        updateTagDropModeStatements.set(db, stmt);
    }
    return stmt;
}

const updateTagByteSizeStatements = new WeakMap<Database, PreparedStatement>();
const updateTagInputByteSizeStatements = new WeakMap<Database, PreparedStatement>();

function getUpdateTagByteSizeStatement(db: Database): PreparedStatement {
    let stmt = updateTagByteSizeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET byte_size = ? WHERE session_id = ? AND tag_number = ?");
        updateTagByteSizeStatements.set(db, stmt);
    }
    return stmt;
}

function getUpdateTagInputByteSizeStatement(db: Database): PreparedStatement {
    let stmt = updateTagInputByteSizeStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "UPDATE tags SET input_byte_size = ? WHERE session_id = ? AND tag_number = ?",
        );
        updateTagInputByteSizeStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Bump a tag's byte_size when a later occurrence of the same call_id
 * carries a larger payload. Used by `tagTranscript` to record the
 * tool-result payload size after the tool-use invocation already
 * reserved the tag with the args size.
 *
 * No-op if newByteSize is not strictly larger than the stored value
 * (caller should compare in memory and only call when necessary).
 */
export function updateTagByteSize(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newByteSize: number,
): void {
    getUpdateTagByteSizeStatement(db).run(newByteSize, sessionId, tagNumber);
}

/**
 * Bump a tag's input_byte_size when a tool_use occurrence is seen
 * after the result occurrence (rare in practice; supports both
 * orderings).
 */
export function updateTagInputByteSize(
    db: Database,
    sessionId: string,
    tagNumber: number,
    newInputByteSize: number,
): void {
    getUpdateTagInputByteSizeStatement(db).run(newInputByteSize, sessionId, tagNumber);
}

function getUpdateTagMessageIdStatement(db: Database): PreparedStatement {
    let stmt = updateTagMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ? AND tag_number = ?");
        updateTagMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getTagNumbersByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getTagNumbersByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND (message_id = ? OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\') ORDER BY tag_number ASC",
        );
        getTagNumbersByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getDeleteTagsByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = deleteTagsByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "DELETE FROM tags WHERE session_id = ? AND (message_id = ? OR message_id LIKE ? ESCAPE '\\' OR message_id LIKE ? ESCAPE '\\')",
        );
        deleteTagsByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxTagNumberBySessionStatement(db: Database): PreparedStatement {
    let stmt = getMaxTagNumberBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(tag_number), 0) AS max_tag_number FROM tags WHERE session_id = ?",
        );
        getMaxTagNumberBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getTagNumberByMessageIdStatement(db: Database): PreparedStatement {
    let stmt = getTagNumberByMessageIdStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND message_id = ? ORDER BY tag_number ASC LIMIT 1",
        );
        getTagNumberByMessageIdStatements.set(db, stmt);
    }
    return stmt;
}

interface TagRow {
    id: number;
    message_id: string;
    type: string;
    status: string;
    drop_mode: string | null;
    tool_name: string | null;
    input_byte_size: number | null;
    byte_size: number;
    reasoning_byte_size: number;
    session_id: string;
    tag_number: number;
    caveman_depth: number | null;
    tool_owner_message_id: string | null;
}

interface TagNumberRow {
    tag_number: number;
}

interface MaxTagNumberRow {
    max_tag_number: number;
}

function isTagRow(row: unknown): row is TagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.message_id === "string" &&
        typeof r.type === "string" &&
        typeof r.status === "string" &&
        typeof r.byte_size === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_number === "number"
    );
    // reasoning_byte_size may be missing on old rows (ensureColumn adds DEFAULT 0)
}

function toTagEntry(row: TagRow): TagEntry {
    const type = row.type === "tool" ? "tool" : row.type === "file" ? "file" : "message";
    const status = row.status === "dropped" || row.status === "compacted" ? row.status : "active";

    return {
        tagNumber: row.tag_number,
        messageId: row.message_id,
        type,
        status,
        dropMode: row.drop_mode === "truncated" ? "truncated" : "full",
        toolName: row.tool_name ?? null,
        inputByteSize: row.input_byte_size ?? 0,
        byteSize: row.byte_size,
        reasoningByteSize: row.reasoning_byte_size ?? 0,
        sessionId: row.session_id,
        // ensureColumn adds DEFAULT 0 but SQLite leaves NULL on pre-existing
        // rows. Coerce to 0 so downstream callers never see NaN arithmetic.
        cavemanDepth:
            typeof row.caveman_depth === "number" && Number.isFinite(row.caveman_depth)
                ? row.caveman_depth
                : 0,
        // tool_owner_message_id is the third axis of tool-tag identity.
        // NULL is the legitimate value for non-tool tags AND for legacy
        // tool tags written before plugin v0.16.x. Lazy adoption +
        // backfill populate this column at runtime; see plan v3.3.1.
        toolOwnerMessageId:
            typeof row.tool_owner_message_id === "string" ? row.tool_owner_message_id : null,
    };
}

function isTagNumberRow(row: unknown): row is TagNumberRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.tag_number === "number";
}

function isMaxTagNumberRow(row: unknown): row is MaxTagNumberRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.max_tag_number === "number";
}

function escapeLikePattern(value: string): string {
    return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export function insertTag(
    db: Database,
    sessionId: string,
    messageId: string,
    type: TagEntry["type"],
    byteSize: number,
    tagNumber: number,
    reasoningByteSize: number = 0,
    toolName: string | null = null,
    inputByteSize: number = 0,
    toolOwnerMessageId: string | null = null,
): number {
    getInsertTagStatement(db).run(
        sessionId,
        messageId,
        type,
        byteSize,
        reasoningByteSize,
        tagNumber,
        toolName,
        inputByteSize,
        getHarness(),
        toolOwnerMessageId,
    );

    return tagNumber;
}

export function updateTagStatus(
    db: Database,
    sessionId: string,
    tagId: number,
    status: TagEntry["status"],
): void {
    getUpdateTagStatusStatement(db).run(status, sessionId, tagId);
}

export function updateTagDropMode(
    db: Database,
    sessionId: string,
    tagNumber: number,
    dropMode: TagEntry["dropMode"],
): void {
    getUpdateTagDropModeStatement(db).run(dropMode, sessionId, tagNumber);
}

/**
 * Set the caveman compression depth for a tag.
 *
 * Only message tags are expected to receive non-zero depth; callers enforce
 * that. Persisted so later transform passes and restarts can resume without
 * re-compressing text that already matches its target age-tier depth.
 */
export function updateCavemanDepth(
    db: Database,
    sessionId: string,
    tagNumber: number,
    depth: number,
): void {
    db.prepare("UPDATE tags SET caveman_depth = ? WHERE session_id = ? AND tag_number = ?").run(
        depth,
        sessionId,
        tagNumber,
    );
}

export function updateTagMessageId(
    db: Database,
    sessionId: string,
    tagId: number,
    messageId: string,
): void {
    getUpdateTagMessageIdStatement(db).run(messageId, sessionId, tagId);
}

/**
 * Delete every tag whose source content lives on `messageId`. This is
 * the `message.removed` event handler's primary cleanup path.
 *
 * What gets deleted:
 *   - Message tags: `messageId == <removed-msg-id>` (text parts).
 *   - File tags: `messageId LIKE <removed-msg-id>:p%` /
 *     `<removed-msg-id>:file%`.
 *   - Tool tags owned by the removed message:
 *     `tool_owner_message_id == <removed-msg-id>` (v3.3.1 Layer C).
 *
 * Pre-v10 semantics: tool tags used `messageId = callId`, so a removed
 * assistant message would not match any tool tag's `messageId` field
 * (the message id was never written there for tool tags). The fix:
 * include tool tags by composite-owner identity so an assistant
 * message removal correctly cascades to the tool tags it hosted.
 *
 * Returns the tag numbers that were deleted (used by the event handler
 * to re-anchor reasoning watermarks and audit logs).
 */
export function deleteTagsByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number[] {
    const escapedMessageId = escapeLikePattern(messageId);
    const textPartPattern = `${escapedMessageId}:p%`;
    const filePartPattern = `${escapedMessageId}:file%`;
    const messageScopedTags = getTagNumbersByMessageIdStatement(db)
        .all(sessionId, messageId, textPartPattern, filePartPattern)
        .filter(isTagNumberRow)
        .map((row) => row.tag_number);

    // Tool tags owned by the removed message — `tool_owner_message_id`
    // can match independent of `messageId` (which is the callId). Pull
    // these tag numbers BEFORE running the delete so the caller sees
    // the union.
    const ownerScopedTagNumbers = getOwnerScopedToolTagNumbers(db, sessionId, messageId);

    if (messageScopedTags.length === 0 && ownerScopedTagNumbers.length === 0) {
        return [];
    }

    if (messageScopedTags.length > 0) {
        getDeleteTagsByMessageIdStatement(db).run(
            sessionId,
            messageId,
            textPartPattern,
            filePartPattern,
        );
    }
    if (ownerScopedTagNumbers.length > 0) {
        deleteToolTagsByOwner(db, sessionId, messageId);
    }

    // De-duplicate — a tag could in theory match both predicates.
    const merged = new Set<number>([...messageScopedTags, ...ownerScopedTagNumbers]);
    return Array.from(merged).sort((a, b) => a - b);
}

const getOwnerScopedToolTagNumbersStatements = new WeakMap<Database, PreparedStatement>();
function getOwnerScopedToolTagNumbers(
    db: Database,
    sessionId: string,
    ownerMsgId: string,
): number[] {
    let stmt = getOwnerScopedToolTagNumbersStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' AND tool_owner_message_id = ? ORDER BY tag_number ASC",
        );
        getOwnerScopedToolTagNumbersStatements.set(db, stmt);
    }
    return stmt
        .all(sessionId, ownerMsgId)
        .filter(isTagNumberRow)
        .map((row) => row.tag_number);
}

export function getMaxTagNumberBySession(db: Database, sessionId: string): number {
    const row = getMaxTagNumberBySessionStatement(db).get(sessionId);
    return isMaxTagNumberRow(row) ? row.max_tag_number : 0;
}

/**
 * Look up the tag_number assigned to a specific (session_id, message_id).
 *
 * Used by the tagger's recovery path to bind an existing DB-assigned tag back
 * into the in-memory assignment map without bumping the counter past the DB's
 * actual max. Returns null when no tag exists for that message yet.
 */
export function getTagNumberByMessageId(
    db: Database,
    sessionId: string,
    messageId: string,
): number | null {
    const row = getTagNumberByMessageIdStatement(db).get(sessionId, messageId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

// Single source-of-truth column list for SELECTs that produce TagEntry.
// Centralizing this avoids subtle drift when columns are added (e.g.
// migration v10's tool_owner_message_id) — every TagEntry-producing
// reader must include the new column or downstream callers will see
// undefined where they expect a typed field.
const TAG_SELECT_COLUMNS =
    "id, message_id, type, status, drop_mode, tool_name, input_byte_size, byte_size, reasoning_byte_size, session_id, tag_number, caveman_depth, tool_owner_message_id";

export function getTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

// ─── Targeted helpers for the hot transform path ──────────────────────────
//
// `getTagsBySession` loads every tag for a session (often 10k–50k rows on
// long-lived sessions) on every transform pass. Most consumers only need a
// small slice — the active tags, or the rows whose tag_number is in the
// current `targets` map, or just the watermark of dropped tag_numbers.
//
// These helpers replace the single full-table load with three targeted
// queries that, combined with the partial indexes added in migration v8
// (`idx_tags_active_session_tag_number` WHERE status='active' and
// `idx_tags_dropped_session_tag_number` WHERE status='dropped'), produce
// index-only scans over the small slice each call site actually cares
// about. Benchmarked at ~110× speedup on a 49k-tag session (67ms → 0.6ms).
//
// We do NOT remove `getTagsBySession`. It remains the right call for the
// few non-hot-path consumers (compartment-trigger, ctx-reduce tool, etc.)
// where the full list is genuinely needed. Hot-path consumers (transform,
// apply-operations, heuristic-cleanup, nudger) should switch to these.

const getActiveTagsBySessionStatements = new WeakMap<Database, PreparedStatement>();
const getMaxDroppedTagNumberStatements = new WeakMap<Database, PreparedStatement>();

function getActiveTagsBySessionStatement(db: Database): PreparedStatement {
    let stmt = getActiveTagsBySessionStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY tag_number ASC, id ASC`,
        );
        getActiveTagsBySessionStatements.set(db, stmt);
    }
    return stmt;
}

function getMaxDroppedTagNumberStatement(db: Database): PreparedStatement {
    let stmt = getMaxDroppedTagNumberStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT COALESCE(MAX(tag_number), 0) AS max_tag_number FROM tags WHERE session_id = ? AND status = 'dropped'",
        );
        getMaxDroppedTagNumberStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Return only the tags whose status is 'active' for this session.
 *
 * Backed by the partial index `idx_tags_active_session_tag_number` so the
 * scan touches only active rows instead of every tag in the session.
 *
 * Use this in: heuristic cleanup, nudger, caveman replay scope, anywhere
 * that filters `tags.filter(t => t.status === "active")` on the result of
 * `getTagsBySession`.
 *
 * The returned shape matches `TagEntry` exactly so callers can swap with
 * no behavior change beyond seeing fewer (active-only) rows.
 */
export function getActiveTagsBySession(db: Database, sessionId: string): TagEntry[] {
    const rows = getActiveTagsBySessionStatement(db).all(sessionId).filter(isTagRow);
    return rows.map(toTagEntry);
}

/**
 * Return the tags whose tag_number is in `tagNumbers` for this session.
 *
 * Used by `applyFlushedStatuses` (and similar replay loops) to fetch the
 * subset of tags that match the current pass's visible target set rather
 * than scanning every tag in the session.
 *
 * The IN-list is built dynamically because SQLite caches prepared
 * statements per query string, but we still get prepared-statement reuse
 * for any given list size that happens twice in a row (which is the
 * common case during long sessions).
 *
 * Returns an empty array when `tagNumbers` is empty (avoids generating
 * `IN ()` which is an SQL syntax error).
 */
export function getTagsByNumbers(
    db: Database,
    sessionId: string,
    tagNumbers: readonly number[],
): TagEntry[] {
    if (tagNumbers.length === 0) return [];

    // SQLite parameter limit is 999 by default; chunk just in case very
    // large target sets ever appear (the common case is ~500-1000).
    if (tagNumbers.length > 900) {
        const all: TagEntry[] = [];
        for (let i = 0; i < tagNumbers.length; i += 900) {
            all.push(...getTagsByNumbers(db, sessionId, tagNumbers.slice(i, i + 900)));
        }
        return all;
    }

    const placeholders = tagNumbers.map(() => "?").join(",");
    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number IN (${placeholders}) ORDER BY tag_number ASC, id ASC`,
        )
        .all(sessionId, ...tagNumbers)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

/**
 * Return the maximum tag_number among tags whose status is 'dropped' for
 * this session, or 0 if no dropped tags exist.
 *
 * Replaces the full-array iteration `for (tag of tags) if (dropped &&
 * tag_number > max) max = tag_number` with a single SQL aggregate.
 * Backed by the partial index `idx_tags_dropped_session_tag_number` so
 * SQLite resolves the MAX with a backward index seek (O(log N)).
 */
export function getMaxDroppedTagNumber(db: Database, sessionId: string): number {
    const row = getMaxDroppedTagNumberStatement(db).get(sessionId);
    return isMaxTagNumberRow(row) ? row.max_tag_number : 0;
}

export function getTagById(db: Database, sessionId: string, tagId: number): TagEntry | null {
    const result = db
        .prepare(`SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND tag_number = ?`)
        .get(sessionId, tagId);

    if (!isTagRow(result)) {
        return null;
    }

    return toTagEntry(result);
}

export function getTopNBySize(db: Database, sessionId: string, n: number): TagEntry[] {
    if (n <= 0) {
        return [];
    }

    const rows = db
        .prepare(
            `SELECT ${TAG_SELECT_COLUMNS} FROM tags WHERE session_id = ? AND status = 'active' ORDER BY byte_size DESC, tag_number ASC LIMIT ?`,
        )
        .all(sessionId, n)
        .filter(isTagRow);

    return rows.map(toTagEntry);
}

// ─── Tool-owner composite identity helpers (migration v10) ──────────────────
//
// Pre-v10 tool tags were keyed by (session_id, callID); collisions on
// OpenCode's per-turn callID counter could replay drop status onto fresh
// content. Post-v10 the persistent identity is the triple
// (session_id, callID, tool_owner_message_id).
//
// These helpers form the DB-side surface the runtime tagger uses for the
// composite-key fast path, the lazy-adoption fallback, and the
// nearest-prior owner search for result-only windows.
//
// See plan v3.3.1 in `.alfonso/plans/tag-owner-fix-plan.md`.

const getToolTagNumberByOwnerStatements = new WeakMap<Database, PreparedStatement>();
const getNullOwnerToolTagStatements = new WeakMap<Database, PreparedStatement>();
const adoptNullOwnerToolTagStatements = new WeakMap<Database, PreparedStatement>();
const deleteToolTagsByOwnerStatements = new WeakMap<Database, PreparedStatement>();

function getGetToolTagNumberByOwnerStatement(db: Database): PreparedStatement {
    let stmt = getToolTagNumberByOwnerStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT tag_number FROM tags
             WHERE session_id = ? AND message_id = ?
               AND type = 'tool' AND tool_owner_message_id = ?
             LIMIT 1`,
        );
        getToolTagNumberByOwnerStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Look up the tag_number for a specific composite tool identity.
 *
 * Returns null when no tag exists for `(sessionId, callId, ownerMsgId)`.
 * This is the fast path for the runtime tagger after a tagger restart
 * or cache eviction.
 */
export function getToolTagNumberByOwner(
    db: Database,
    sessionId: string,
    callId: string,
    ownerMsgId: string,
): number | null {
    const row = getGetToolTagNumberByOwnerStatement(db).get(sessionId, callId, ownerMsgId);
    return isTagNumberRow(row) ? row.tag_number : null;
}

interface NullOwnerToolTagRow {
    id: number;
    tag_number: number;
}

function isNullOwnerToolTagRow(row: unknown): row is NullOwnerToolTagRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.id === "number" && typeof r.tag_number === "number";
}

function getGetNullOwnerToolTagStatement(db: Database): PreparedStatement {
    let stmt = getNullOwnerToolTagStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `SELECT id, tag_number FROM tags
             WHERE session_id = ? AND message_id = ?
               AND type = 'tool' AND tool_owner_message_id IS NULL
             ORDER BY tag_number ASC
             LIMIT 1`,
        );
        getNullOwnerToolTagStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Find a NULL-owner tool tag row for `(sessionId, callId)`.
 *
 * Used by the lazy-adoption fast path: when the runtime tagger sees a
 * tool with composite key `(ownerMsgId, callId)` that has no
 * corresponding row in `assignments`, but the underlying callId already
 * exists in DB with NULL owner (legacy pre-v10 row), we want to adopt
 * the orphan rather than allocate a fresh tag. This preserves
 * cache-stable tag numbers across the v9 → v10 upgrade.
 *
 * Returns the lowest-numbered NULL-owner row deterministically. The
 * caller is expected to follow up with `adoptNullOwnerToolTag` to
 * atomically claim ownership; if that returns false, another writer
 * adopted first and the caller must re-check the composite-key fast
 * path or allocate a fresh tag.
 */
export function getNullOwnerToolTag(
    db: Database,
    sessionId: string,
    callId: string,
): { id: number; tagNumber: number } | null {
    const row = getGetNullOwnerToolTagStatement(db).get(sessionId, callId);
    if (!isNullOwnerToolTagRow(row)) return null;
    return { id: row.id, tagNumber: row.tag_number };
}

function getAdoptNullOwnerToolTagStatement(db: Database): PreparedStatement {
    let stmt = adoptNullOwnerToolTagStatements.get(db);
    if (!stmt) {
        // NULL-guarded UPDATE: matches zero rows if another writer
        // (backfill or a concurrent runtime adoption) already populated
        // owner. Caller MUST treat changes=0 as "race lost" and
        // recover.
        stmt = db.prepare(
            `UPDATE tags
             SET tool_owner_message_id = ?
             WHERE id = ? AND tool_owner_message_id IS NULL`,
        );
        adoptNullOwnerToolTagStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Atomically adopt a NULL-owner tool tag row by setting
 * `tool_owner_message_id = ownerMsgId`. Returns true if exactly one
 * row was updated (we won the race), false if zero (someone else
 * adopted between our SELECT and UPDATE).
 *
 * The NULL guard makes this concurrent-safe with both the backfill
 * pass and concurrent runtime adoptions in other plugin processes.
 */
export function adoptNullOwnerToolTag(db: Database, rowId: number, ownerMsgId: string): boolean {
    const result = getAdoptNullOwnerToolTagStatement(db).run(ownerMsgId, rowId);
    return (result.changes ?? 0) === 1;
}

interface OwnerTextRow {
    tool_owner_message_id: string;
}

function isOwnerTextRow(row: unknown): row is OwnerTextRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return typeof r.tool_owner_message_id === "string";
}

/**
 * Find the most recent (by `time_created`) tool-tag owner whose owner
 * message precedes `currentMessageId` in the OpenCode session message
 * order. Used by the runtime tagger when a tool result is observed in
 * a window where its invocation has been compacted away — the FIFO
 * pairing pass produces no in-pass owner, so we look up which prior
 * assistant message most plausibly invoked it.
 *
 * Requires the OpenCode DB attached at the alias `oc` (the ATTACH must
 * happen before invoking this helper). The CTE looks up
 * `currentMessageId`'s `time_created` once; the JOIN narrows by
 * session_id to defend against the (already-improbable) case of
 * cross-session callID collision on UUID-shaped ids.
 *
 * Returns null if:
 *   - `currentMessageId` doesn't exist in `oc.message`
 *   - no tool tag with non-NULL owner exists for `(sessionId, callId)`
 *     whose owner's `time_created` precedes the current message
 *
 * The caller is expected to fall back to `message.info.id` (current
 * message) when this returns null.
 *
 * Cost target (plan §Layer C, Test #45): ≤0.5ms average per call on a
 * session with ≥30k tool tags. Above that, plan calls for a v11
 * migration that denormalizes `tool_owner_time_created` onto each tag
 * row to eliminate the JOIN.
 */
export function getPersistedToolOwnerNearestPrior(
    db: Database,
    sessionId: string,
    callId: string,
    currentMessageId: string,
): string | null {
    // Prepared statements would be ideal here, but SQLite ATTACH state
    // is per-connection and the alias may not be present on every DB
    // we hold a connection to. Build the query inline; better-sqlite3
    // caches the parsed plan internally.
    const row = db
        .prepare(
            `WITH current_msg AS (
                 SELECT time_created, id
                 FROM oc.message
                 WHERE session_id = :sessionId AND id = :currentMessageId
             )
             SELECT t.tool_owner_message_id
             FROM tags t
             INNER JOIN oc.message m
                 ON m.id = t.tool_owner_message_id
                AND m.session_id = t.session_id
             WHERE t.session_id = :sessionId
               AND t.message_id = :callId
               AND t.type = 'tool'
               AND t.tool_owner_message_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM current_msg)
               AND (
                   m.time_created < (SELECT time_created FROM current_msg)
                   OR (m.time_created = (SELECT time_created FROM current_msg)
                       AND m.id < (SELECT id FROM current_msg))
               )
             ORDER BY m.time_created DESC, m.id DESC
             LIMIT 1`,
        )
        .get({
            sessionId,
            callId,
            currentMessageId,
        });
    return isOwnerTextRow(row) ? row.tool_owner_message_id : null;
}

function getDeleteToolTagsByOwnerStatement(db: Database): PreparedStatement {
    let stmt = deleteToolTagsByOwnerStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            `DELETE FROM tags
             WHERE session_id = ?
               AND type = 'tool'
               AND tool_owner_message_id = ?`,
        );
        deleteToolTagsByOwnerStatements.set(db, stmt);
    }
    return stmt;
}

/**
 * Delete every tool tag owned by `ownerMsgId` in the session. Used by
 * `message.removed` cleanup to scope the deletion correctly: pre-v10
 * a removed assistant message would `deleteTagsByMessageId(messageId)`
 * which only matched `message_id = messageId` (the contentId for text
 * parts), missing tool tags whose `message_id` is the callID. Post-v10
 * the owner column gives us the right scope.
 *
 * Returns the number of rows deleted. NULL-owner legacy rows are not
 * matched by this helper — they remain reachable via `message_id`-only
 * deletion paths until adopted or backfilled.
 */
export function deleteToolTagsByOwner(db: Database, sessionId: string, ownerMsgId: string): number {
    const result = getDeleteToolTagsByOwnerStatement(db).run(sessionId, ownerMsgId);
    return result.changes ?? 0;
}
