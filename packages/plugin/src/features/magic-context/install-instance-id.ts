// The shared chokepoint type, not `bun:sqlite`: the same plugin artifact runs on
// Bun and on Node/Electron, and this row is read on both.
import type { Database } from "../../shared/sqlite";

const INSTALL_INSTANCE_ID_KEY = "install_instance_id";

interface MetaValueRow {
    value: string;
}

function readRaw(db: Database): string | null {
    const row = db
        .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
        .get(INSTALL_INSTANCE_ID_KEY) as MetaValueRow | undefined;
    const value = row?.value?.trim();
    return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Read the id without minting one, returning null on an install that has never
 * claimed anything. Separate from {@link ensureInstallInstanceId} so diagnostics
 * can look without creating state as a side effect of being looked at.
 */
export function readInstallInstanceId(db: Database): string | null {
    return readRaw(db);
}

/**
 * The identity one installation of this host presents when it claims a historian
 * run, minting and persisting it on first use.
 *
 * Why it is persisted rather than derived:
 *
 *  - A file-derived id (the store's own uuid, the database path) is the SAME for
 *    two processes opening the same file, so two hosts serving one project would
 *    both present it and a claim keyed on identity would admit both.
 *  - A process-random id is different for the same install after a restart, so a
 *    host could not recognise work it had claimed moments earlier.
 *
 * Minted once and never rotated. It is not a credential: it records which
 * installation took a piece of work, for diagnosis. What authorises a report is
 * the attempt-scoped token the module mints at claim time, so an id that leaks
 * grants nothing.
 *
 * Safe against two processes reaching it at once: the insert ignores a row that
 * is already there and the value is re-read afterwards, so both callers return
 * the id that actually landed rather than the one they generated.
 */
export function ensureInstallInstanceId(db: Database): string {
    const existing = readRaw(db);
    if (existing !== null) return existing;

    const minted = crypto.randomUUID();
    db.prepare("INSERT OR IGNORE INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        INSTALL_INSTANCE_ID_KEY,
        minted,
    );
    // Re-read rather than returning `minted`: another process may have won the
    // insert, and the id this install presents has to be the persisted one.
    return readRaw(db) ?? minted;
}

export { INSTALL_INSTANCE_ID_KEY };
