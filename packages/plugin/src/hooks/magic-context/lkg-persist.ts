import { createHash } from "node:crypto";

import { assembleLkgPrefix, layoutLkgPrefix } from "../../features/magic-context/lkg-prefix-chunks";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { LkgPersistenceBackend, LkgSlot } from "./lkg-slot";

/**
 * Durable persistence for last-known-good (LKG) transform snapshots.
 *
 * The in-memory slot map in lkg-slot.ts dies with the process. When the plugin
 * restarts while the Rust module is reconnecting, the recovery ladder used to
 * have nothing to replay and the turn fell all the way down to the raw-fallback
 * size gate. Persisting the slot an applied pass captured lets a fresh process
 * serve the same replay — subject to exactly the same validity fences a live
 * process applies (hydration only restores the slot; replay validation is
 * unchanged).
 *
 * Write discipline follows the single-stringify precedent: `jsonPrefix` is the
 * exact string captured by the applied pass and is stored as-is — never
 * re-serialized here. Only the small metadata arrays are serialized.
 *
 * The prefix lives in `lkg_slot_chunks` as fixed-position slices
 * (lkg-prefix-chunks.ts); `lkg_slots` keeps the metadata plus the slice count,
 * total length and hash that a load checks before anything is replayed.
 */

interface LkgSlotRow {
    session_id?: unknown;
    /** Assembled from `lkg_slot_chunks` by the loader; not a stored column. */
    json_prefix?: unknown;
    input_id_seq?: unknown;
    input_content_digests?: unknown;
    input_content_signatures?: unknown;
    last_input_message_id?: unknown;
    model_key?: unknown;
    provider_key?: unknown;
    captured_at?: unknown;
    row_version?: unknown;
    capture_sequence?: unknown;
}

function parseStringArray(value: unknown): string[] | null {
    if (typeof value !== "string") return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (!Array.isArray(parsed)) return null;
    const result: string[] = [];
    for (const entry of parsed) {
        if (typeof entry !== "string" || entry.length === 0) return null;
        result.push(entry);
    }
    return result;
}

function parseNullableString(value: unknown): string | null | undefined {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : undefined;
}

function parseNullableInteger(value: unknown): number | undefined {
    if (value === null || value === undefined) return undefined;
    return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

/** Parse a stored row into a slot; returns undefined (and reasons to delete) on any malformation. */
export function parsePersistedLkgSlot(row: unknown): LkgSlot | undefined {
    if (!row || typeof row !== "object") return undefined;
    const record = row as LkgSlotRow;
    const jsonPrefix = record.json_prefix;
    const lastInputMessageId = record.last_input_message_id;
    const capturedAt = record.captured_at;
    // Legacy and OpenCode rows keep the plain ID array. Pi adds versioned
    // output ownership so a hydrated slot can prove a head-contraction splice.
    let inputIdsRaw = record.input_id_seq;
    let piOutputEntryIds: (string | null)[] | undefined;
    if (typeof inputIdsRaw === "string") {
        try {
            const metadata = JSON.parse(inputIdsRaw);
            if (
                metadata &&
                !Array.isArray(metadata) &&
                metadata.version === 1 &&
                Array.isArray(metadata.piOutputEntryIds)
            ) {
                if (
                    !metadata.piOutputEntryIds.every(
                        (id: unknown) => id === null || (typeof id === "string" && id.length > 0),
                    )
                )
                    return undefined;
                piOutputEntryIds = metadata.piOutputEntryIds;
                inputIdsRaw = JSON.stringify(metadata.inputIds);
            }
        } catch {
            return undefined;
        }
    }
    const inputIdSeq = parseStringArray(inputIdsRaw);
    const inputContentDigests = parseStringArray(record.input_content_digests);
    const modelKey = parseNullableString(record.model_key);
    const providerKey = parseNullableString(record.provider_key);
    if (
        typeof jsonPrefix !== "string" ||
        typeof lastInputMessageId !== "string" ||
        lastInputMessageId.length === 0 ||
        typeof capturedAt !== "number" ||
        !Number.isFinite(capturedAt) ||
        inputIdSeq === null ||
        inputContentDigests === null ||
        inputContentDigests.length !== inputIdSeq.length ||
        modelKey === undefined ||
        providerKey === undefined
    ) {
        return undefined;
    }
    if (piOutputEntryIds) {
        try {
            const output = JSON.parse(jsonPrefix);
            const inputs = new Set(inputIdSeq);
            if (
                !Array.isArray(output) ||
                output.length !== piOutputEntryIds.length ||
                piOutputEntryIds.some((id) => id !== null && !inputs.has(id))
            )
                return undefined;
        } catch {
            return undefined;
        }
    }
    let inputContentSignatures: string[] | undefined;
    if (record.input_content_signatures !== null && record.input_content_signatures !== undefined) {
        const parsed = parseStringArray(record.input_content_signatures);
        if (parsed === null || parsed.length !== inputIdSeq.length) return undefined;
        inputContentSignatures = parsed;
    }
    const slot: LkgSlot = {
        jsonPrefix,
        inputIdSeq,
        inputContentDigests,
        lastInputMessageId,
        modelKey,
        providerKey,
        capturedAt,
    };
    if (inputContentSignatures) slot.inputContentSignatures = inputContentSignatures;
    if (piOutputEntryIds) slot.piOutputEntryIds = piOutputEntryIds;
    const rowVersion = parseNullableInteger(record.row_version);
    if (rowVersion !== undefined) slot.rowVersion = rowVersion;
    const captureSequence = parseNullableInteger(record.capture_sequence);
    if (captureSequence !== undefined) slot.captureSequence = captureSequence;
    return slot;
}

/**
 * What this process last knows to be stored for a session: the fingerprint of
 * the slot it saved (empty when the state came from a load, so the next save
 * still refreshes the metadata row), the prefix hash recorded in the row, and
 * the hash of each stored slice.
 */
interface PersistedLkgState {
    fingerprint: string;
    prefixHash: string;
    chunkHashes: string[];
}

const persistedStates = new WeakMap<Database, Map<string, PersistedLkgState>>();
const PERSISTED_STATE_MAX_SESSIONS = 1000;

function rememberPersistedState(db: Database, sessionId: string, state: PersistedLkgState): void {
    let states = persistedStates.get(db);
    if (!states) {
        states = new Map();
        persistedStates.set(db, states);
    }
    states.delete(sessionId);
    if (states.size >= PERSISTED_STATE_MAX_SESSIONS) {
        const oldest = states.keys().next().value;
        if (oldest !== undefined) states.delete(oldest);
    }
    states.set(sessionId, state);
}

function slotFingerprint(slot: LkgSlot): string {
    // capturedAt is the time of this capture, not part of the served request.
    // Keep all replay fences and metadata in the fingerprint so a changed slot
    // always replaces the durable one. Hash without reading the existing row.
    return createHash("sha256")
        .update(
            JSON.stringify([
                slot.jsonPrefix,
                slot.inputIdSeq,
                slot.inputContentDigests,
                slot.inputContentSignatures,
                slot.piOutputEntryIds,
                slot.lastInputMessageId,
                slot.modelKey,
                slot.providerKey,
                slot.rowVersion,
                slot.captureSequence,
            ]),
        )
        .digest("hex");
}

/**
 * Persist a slot for the session, replacing any prior row. Best-effort: callers
 * treat a failure as "this process still has the in-memory slot" and log.
 *
 * Only the prefix slices whose hash changed are written. The slices, the removal
 * of slices past the new count, and the metadata row (with the count, length and
 * hash a load verifies) commit in one transaction.
 */
export function saveLkgSlotToDb(db: Database, sessionId: string, slot: LkgSlot): boolean {
    const fingerprint = slotFingerprint(slot);
    const previous = persistedStates.get(db)?.get(sessionId);
    if (previous?.fingerprint === fingerprint) return true;
    const layout = layoutLkgPrefix(slot.jsonPrefix);
    try {
        db.transaction(() => {
            // Slice hashes remembered by this process describe the stored slices
            // only while the row still carries the prefix hash this process wrote
            // or loaded. Another connection may have saved the slot since; then
            // every slice is rewritten.
            const stored = db
                .prepare("SELECT json_prefix_hash FROM lkg_slots WHERE session_id = ?")
                .get(sessionId) as { json_prefix_hash?: unknown } | undefined;
            const knownHashes =
                previous !== undefined && stored?.json_prefix_hash === previous.prefixHash
                    ? previous.chunkHashes
                    : [];
            const upsertChunk = db.prepare(
                `INSERT INTO lkg_slot_chunks (session_id, chunk, body) VALUES (?, ?, ?)
                ON CONFLICT(session_id, chunk) DO UPDATE SET body = excluded.body`,
            );
            for (let index = 0; index < layout.chunks.length; index += 1) {
                if (knownHashes[index] === layout.chunkHashes[index]) continue;
                upsertChunk.run(sessionId, index, layout.chunks[index]);
            }
            db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = ? AND chunk >= ?").run(
                sessionId,
                layout.chunks.length,
            );
            db.prepare(
                `INSERT INTO lkg_slots (
                    session_id, json_prefix_chars, json_prefix_chunks, json_prefix_hash,
                    input_id_seq, input_content_digests, input_content_signatures,
                    last_input_message_id, model_key, provider_key,
                    captured_at, row_version, capture_sequence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    json_prefix_chars = excluded.json_prefix_chars,
                    json_prefix_chunks = excluded.json_prefix_chunks,
                    json_prefix_hash = excluded.json_prefix_hash,
                    input_id_seq = excluded.input_id_seq,
                    input_content_digests = excluded.input_content_digests,
                    input_content_signatures = excluded.input_content_signatures,
                    last_input_message_id = excluded.last_input_message_id,
                    model_key = excluded.model_key,
                    provider_key = excluded.provider_key,
                    captured_at = excluded.captured_at,
                    row_version = excluded.row_version,
                    capture_sequence = excluded.capture_sequence`,
            ).run(
                sessionId,
                layout.chars,
                layout.chunks.length,
                layout.hash,
                JSON.stringify(
                    slot.piOutputEntryIds
                        ? {
                              version: 1,
                              inputIds: slot.inputIdSeq,
                              piOutputEntryIds: slot.piOutputEntryIds,
                          }
                        : slot.inputIdSeq,
                ),
                JSON.stringify(slot.inputContentDigests),
                slot.inputContentSignatures ? JSON.stringify(slot.inputContentSignatures) : null,
                slot.lastInputMessageId,
                slot.modelKey,
                slot.providerKey,
                slot.capturedAt,
                slot.rowVersion ?? null,
                slot.captureSequence ?? null,
            );
        }).immediate();
        rememberPersistedState(db, sessionId, {
            fingerprint,
            prefixHash: layout.hash,
            chunkHashes: layout.chunkHashes,
        });
        return true;
    } catch (error) {
        // The transaction rolled back, so the remembered state (if any) may no
        // longer match what is stored; the next save rewrites every slice.
        persistedStates.get(db)?.delete(sessionId);
        sessionLog(sessionId, "LKG snapshot persistence failed (in-memory slot retained):", error);
        return false;
    }
}

export function clearPersistedLkgSlot(db: Database, sessionId: string): void {
    try {
        db.transaction(() => {
            db.prepare("DELETE FROM lkg_slot_chunks WHERE session_id = ?").run(sessionId);
            db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
        }).immediate();
        persistedStates.get(db)?.delete(sessionId);
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable clear failed:", error);
    }
}

export function loadPersistedLkgSlot(db: Database, sessionId: string): LkgSlot | undefined {
    type ChunkRow = { chunk?: unknown; body?: unknown };
    let row: Record<string, unknown> | undefined;
    let chunkRows: ChunkRow[];
    try {
        // One read transaction, so the row and its slices come from the same
        // snapshot even while another connection is saving this slot.
        ({ row, chunkRows } = db
            .transaction(() => {
                const slotRow = db
                    .prepare("SELECT * FROM lkg_slots WHERE session_id = ?")
                    .get(sessionId) as Record<string, unknown> | undefined;
                if (!slotRow) return { row: undefined, chunkRows: [] as ChunkRow[] };
                const slices = db
                    .prepare(
                        "SELECT chunk, body FROM lkg_slot_chunks WHERE session_id = ? ORDER BY chunk",
                    )
                    .all(sessionId) as ChunkRow[];
                return { row: slotRow, chunkRows: slices };
            })
            .deferred());
    } catch (error) {
        sessionLog(sessionId, "LKG snapshot durable load failed:", error);
        return undefined;
    }
    if (!row) return undefined;
    const prefix = assembleLkgPrefix(
        {
            chars: row.json_prefix_chars,
            chunks: row.json_prefix_chunks,
            hash: row.json_prefix_hash,
        },
        chunkRows,
    );
    const slot = prefix
        ? parsePersistedLkgSlot({ ...row, json_prefix: prefix.jsonPrefix })
        : undefined;
    if (!prefix || !slot) {
        // A malformed row, or slices that do not add up to the recorded count,
        // length and hash, can never become replayable; remove the slot so later
        // captures start clean instead of tripping the same failure.
        if (!prefix) sessionLog(sessionId, "LKG snapshot slices failed verification; slot cleared");
        clearPersistedLkgSlot(db, sessionId);
        return undefined;
    }
    // The verified slice hashes let the first save after a restart rewrite only
    // the slices that changed.
    rememberPersistedState(db, sessionId, {
        fingerprint: "",
        prefixHash: prefix.hash,
        chunkHashes: prefix.chunkHashes,
    });
    // Size admission is enforced by the slot store's own bound when the loaded
    // slot is installed; an oversized row simply declines to hydrate.
    return slot;
}

export function pruneStaleLkgSlots(db: Database, now = Date.now()): number {
    // A zero-wait write transaction lets this maintenance pass yield to active
    // writers. Sessions used within the last week retain their replay snapshots.
    const previousTimeout = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const stale = `captured_at < ? AND NOT EXISTS (
                SELECT 1 FROM session_projects sp
                WHERE sp.session_id = lkg_slots.session_id AND sp.updated_at >= ?
            )`;
    try {
        db.exec("PRAGMA busy_timeout = 0");
        const changes = db
            .transaction(() => {
                db.prepare(
                    `DELETE FROM lkg_slot_chunks WHERE session_id IN (
                    SELECT session_id FROM lkg_slots WHERE ${stale}
                )`,
                ).run(cutoff, cutoff);
                return db.prepare(`DELETE FROM lkg_slots WHERE ${stale}`).run(cutoff, cutoff)
                    .changes;
            })
            .immediate();
        if (changes) persistedStates.delete(db);
        return changes;
    } finally {
        db.exec(`PRAGMA busy_timeout = ${Number(previousTimeout.timeout) || 0}`);
    }
}

/** Backend bound to one database handle, for registration with the slot store. */
export function createDbLkgPersistence(db: Database): LkgPersistenceBackend {
    return {
        load: (sessionId) => loadPersistedLkgSlot(db, sessionId),
        clear: (sessionId) => clearPersistedLkgSlot(db, sessionId),
    };
}
