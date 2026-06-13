import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function indexNames(db: Database): string[] {
    return (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{
            name: string;
        }>
    ).map((row) => row.name);
}

describe("migration v36 — session project ownership", () => {
    test("fresh DB schema includes session project ownership and schema fence version", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(tableColumns(db, "session_projects")).toEqual(
                expect.arrayContaining(["session_id", "harness", "project_path", "updated_at"]),
            );
            expect(indexNames(db)).toContain("idx_session_projects_project");
            expect(LATEST_SUPPORTED_VERSION).toBe(36);
            expect(LATEST_MIGRATION_VERSION).toBe(36);
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: 36 });
        } finally {
            closeQuietly(db);
        }
    });

    test("upgrades a v35 database with the session ownership table", () => {
        const db = new Database(":memory:");
        try {
            db.exec(`
                CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at INTEGER NOT NULL);
                INSERT INTO schema_migrations (version, description, applied_at) VALUES (35, 'pre-v36 fixture', 1);
            `);

            runMigrations(db);

            expect(tableColumns(db, "session_projects")).toEqual(
                expect.arrayContaining(["session_id", "harness", "project_path", "updated_at"]),
            );
            expect(
                db
                    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
                    .get(),
            ).toEqual({ version: 36 });
        } finally {
            closeQuietly(db);
        }
    });
});
