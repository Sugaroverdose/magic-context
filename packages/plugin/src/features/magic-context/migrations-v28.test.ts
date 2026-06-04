import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{
            name: string;
        }>
    ).map((index) => index.name);
}

describe("migration v28 — git sweep coordinator", () => {
    test("adds the project-scoped lease/cooldown table idempotently", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    description TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                );
                INSERT INTO schema_migrations (version, description, applied_at)
                VALUES (27, 'legacy v27', 1);
            `);

            runMigrations(db);
            runMigrations(db);

            expect(columnNames(db, "git_sweep_coordinator")).toEqual([
                "project_path",
                "lease_holder",
                "lease_expires_at",
                "last_swept_at",
            ]);
            expect(indexNames(db)).toEqual(
                expect.arrayContaining([
                    "sqlite_autoindex_git_sweep_coordinator_1",
                    "idx_git_sweep_coordinator_lease_expires",
                    "idx_git_sweep_coordinator_last_swept",
                ]),
            );
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: 28 });
        } finally {
            closeQuietly(db);
        }
    });
});
