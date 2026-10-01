import type { Database } from "../../shared/sqlite";

/** Let Rust coordinate validation detect changes without rereading historical summary text. */
export function installCompartmentHistoryVersions(db: Database): void {
    db.transaction(() => {
        const hasPrivilegeTable = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='context_privilege_state'").get());
        // The module writer sets enabled=1 inside its transaction. Its controlled
        // publications/hints retain the existing rendering and mutation-log policy.
        // Other connections edit with enabled=0 and can bypass m0_mutation_log.
        const externalUpdate = hasPrivilegeTable
            ? "CASE WHEN COALESCE((SELECT enabled FROM context_privilege_state WHERE id=1),0)=0 THEN 1 ELSE 0 END"
            : "1";
        db.exec(`
        CREATE TABLE IF NOT EXISTS compartment_history_versions (
            session_id TEXT PRIMARY KEY NOT NULL,
            generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
            version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
            rewrite_version INTEGER NOT NULL DEFAULT 0 CHECK (rewrite_version >= 0),
            seeded INTEGER NOT NULL DEFAULT 0 CHECK (seeded IN (0, 1))
        );
        INSERT OR IGNORE INTO compartment_history_versions(session_id, seeded)
            SELECT DISTINCT session_id, 1 FROM compartments;
        DROP TRIGGER IF EXISTS compartment_history_ai;
        DROP TRIGGER IF EXISTS compartment_history_ad;
        DROP TRIGGER IF EXISTS compartment_history_au;
        CREATE TRIGGER compartment_history_ai AFTER INSERT ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version) VALUES (NEW.session_id, 1)
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1;
        END;
        CREATE TRIGGER compartment_history_ad AFTER DELETE ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version) VALUES (OLD.session_id, 1)
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1;
        END;
        CREATE TRIGGER compartment_history_au AFTER UPDATE ON compartments BEGIN
            INSERT INTO compartment_history_versions(session_id, version, rewrite_version) VALUES (OLD.session_id, 1, ${externalUpdate})
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1, rewrite_version = rewrite_version + ${externalUpdate};
            INSERT INTO compartment_history_versions(session_id, version, rewrite_version)
                SELECT NEW.session_id, 1, ${externalUpdate} WHERE NEW.session_id != OLD.session_id
            ON CONFLICT(session_id) DO UPDATE SET version = version + 1, rewrite_version = rewrite_version + ${externalUpdate};
        END;
        `);
    }).immediate();
}
