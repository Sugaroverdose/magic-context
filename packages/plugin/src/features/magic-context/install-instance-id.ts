import type { Database } from "bun:sqlite";

/**
 * The identity one installation of this host presents when it claims work.
 *
 * Why it is persisted rather than derived:
 *
 *  - A file-derived id (the store's own uuid, the database path) is the SAME for
 *    two processes opening the same file, so two hosts serving one project would
 *    both present it and a claim CAS keyed on identity would admit both.
 *  - A process-random id is different for the same install after a restart, so a
 *    host could not recognise work it had claimed moments earlier.
 *
 * Minted once, on demand, and never rotated. It is not a secret and not a
 * credential: it identifies which installation took a piece of work, which is
 * only ever used for diagnosis. What actually authorises a report is the
 * attempt-scoped token the module mints at claim time, so an id that leaks
 * grants nothing.
 */
const INSTALL_INSTANCE_ID_KEY = "install_instance_id";

/** Shape of the single-column read used by both helpers. */
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
 * Read the install's instance id without minting one.
 *
 * Returns null on an install that has never claimed anything. Callers that need
 * an id should use {@link ensureInstallInstanceId} instead; this exists for
 * diagnostics that must not create state as a side effect of being looked at.
 */
export function readInstallInstanceId(db: Database): string | null {
    return readRaw(db);
}

/**
 * Return this install's instance id, minting and persisting one on first use.
 *
 * Safe against two processes reaching it at once: the insert ignores a row that
 * is already there and the value is re-read afterwards, so both callers end up
 * returning the id that actually landed rather than the one they generated.
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
