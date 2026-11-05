/// <reference types="bun-types" />
import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { MIGRATIONS, runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";

describe("migration v95: volatile segment columns", () => {
    test("adds both columns idempotently to a pre-95 session_meta", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        db.exec("ALTER TABLE session_meta DROP COLUMN region_volatile_bytes");
        db.exec("ALTER TABLE session_meta DROP COLUMN region_volatile_watermark");

        const migration = MIGRATIONS.find((m) => m.version === 95);
        expect(migration).toBeDefined();
        migration!.up(db);
        // Second run must not throw (ensureColumn is idempotent).
        migration!.up(db);

        const columns = new Set(
            (db.prepare("PRAGMA table_info(session_meta)").all() as Array<{ name?: string }>).map(
                (c) => c.name,
            ),
        );
        expect(columns.has("region_volatile_bytes")).toBe(true);
        expect(columns.has("region_volatile_watermark")).toBe(true);

        db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run("ses-v95");
        const row = db
            .prepare(
                "SELECT region_volatile_bytes, region_volatile_watermark FROM session_meta WHERE session_id = ?",
            )
            .get("ses-v95") as {
            region_volatile_bytes: Buffer | null;
            region_volatile_watermark: number;
        };
        expect(row.region_volatile_bytes).toBeNull();
        expect(row.region_volatile_watermark).toBe(0);
    });

    test("runMigrations on a fresh database lands at 95 with the columns present", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const version = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as {
            v: number;
        };
        expect(version.v).toBe(95);
        const lastMigration = MIGRATIONS[MIGRATIONS.length - 1];
        expect(lastMigration?.version).toBe(95);
    });
});
