/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

/**
 * v89 adds the per-project embedding high-water mark.
 *
 * It exists because embeddings are host-computed, not trigger-maintained: a memory row
 * written by the Rust module arrives without one and nothing would ask. The mark is what
 * asks. It is a separate table rather than a column on `memories` on purpose — a column
 * would make a module-written row distinguishable from a host-written one, and the whole
 * point of the single-store work is that they are not.
 */

function tableExists(db: Database, table: string): boolean {
    return (
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !=
        null
    );
}

function columnNames(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
    );
}

function openAtV88(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    db.exec("DROP TABLE IF EXISTS memory_embedding_watermarks");
    db.prepare("DELETE FROM schema_migrations WHERE version = 89").run();
    return db;
}

describe("migration v89: module-written memory embedding watermark", () => {
    test("a fresh database carries the table and the fence matches the ledger", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            expect(LATEST_SUPPORTED_VERSION).toBe(89);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(
                db
                    .prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 89")
                    .get(),
            ).toEqual({ count: 1 });
            expect(tableExists(db, "memory_embedding_watermarks")).toBe(true);
            expect(columnNames(db, "memory_embedding_watermarks")).toEqual([
                "project_path",
                "written_memory_id",
                "embedded_memory_id",
                "updated_at",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("stepping v88 -> v89 adds the table and leaves the memories table alone", () => {
        const db = openAtV88();
        try {
            db.prepare(
                `INSERT INTO memories
                    (project_path, category, content, normalized_hash, first_seen_at,
                     created_at, updated_at, last_seen_at)
                 VALUES ('git:p', 'ARCHITECTURE', 'kept', 'hash', 1, 1, 1, 1)`,
            ).run();
            const columnsBefore = columnNames(db, "memories");
            expect(tableExists(db, "memory_embedding_watermarks")).toBe(false);

            runMigrations(db);

            expect(tableExists(db, "memory_embedding_watermarks")).toBe(true);
            // A memory row written before the migration must be indistinguishable from
            // one written after it; the mark lives outside this table for that reason.
            expect(columnNames(db, "memories")).toEqual(columnsBefore);
            expect(
                db.prepare("SELECT content FROM memories WHERE project_path = 'git:p'").all(),
            ).toEqual([{ content: "kept" }]);
        } finally {
            closeQuietly(db);
        }
    });

    test("re-running v89 preserves the marks already recorded", () => {
        const db = openAtV88();
        try {
            runMigrations(db);
            db.prepare(
                `INSERT INTO memory_embedding_watermarks
                    (project_path, written_memory_id, embedded_memory_id, updated_at)
                 VALUES ('git:p', 41, 12, 900)`,
            ).run();

            db.prepare("DELETE FROM schema_migrations WHERE version = 89").run();
            runMigrations(db);

            expect(
                db
                    .prepare(
                        "SELECT written_memory_id, embedded_memory_id FROM memory_embedding_watermarks WHERE project_path = 'git:p'",
                    )
                    .get(),
            ).toEqual({ written_memory_id: 41, embedded_memory_id: 12 });
        } finally {
            closeQuietly(db);
        }
    });
});
