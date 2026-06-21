import { existsSync } from "node:fs";
import { getErrorMessage } from "../../../shared/error-message";
import { log } from "../../../shared/logger";
import { Database } from "../../../shared/sqlite";
import { getOpenCodeDbPath } from "../compaction-marker";

/**
 * Open OpenCode's DB read-only (used by the key-files task's read-history scan).
 * Returns null when absent or unopenable — callers degrade gracefully.
 */
export function openOpenCodeDb(): Database | null {
    const dbPath = getOpenCodeDbPath();
    if (!existsSync(dbPath)) {
        log(`[key-files] OpenCode DB not found at ${dbPath} — skipping`);
        return null;
    }
    try {
        const db = new Database(dbPath, { readonly: true });
        db.exec("PRAGMA busy_timeout = 5000");
        return db;
    } catch (error) {
        log(`[key-files] failed to open OpenCode DB at ${dbPath}: ${getErrorMessage(error)}`);
        return null;
    }
}
