/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { LATEST_MIGRATION_VERSION, runMigrations } from "./migrations";
import { initializeDatabase, LATEST_SUPPORTED_VERSION } from "./storage-db";

function seedAppliedVersion(db: Database, version: number): void {
    db.exec(`
        CREATE TABLE schema_migrations (
            version INTEGER PRIMARY KEY,
            description TEXT NOT NULL,
            applied_at INTEGER NOT NULL
        );
    `);
    const insert = db.prepare(
        "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
    );
    for (let current = 1; current <= version; current += 1) {
        insert.run(current, `seed v${current}`, Date.now());
    }
}

function tagsVersion(db: Database, sessionId: string): number {
    return (
        db.prepare("SELECT tags_version FROM session_meta WHERE session_id = ?").get(sessionId) as {
            tags_version: number;
        }
    ).tags_version;
}

describe("migration v86: session-local tag versions", () => {
    test("upgrades v85 and advances only the session whose tag identity changed", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            db.exec(`
                DROP TRIGGER tags_version_ai;
                DROP TRIGGER tags_version_ad;
                DROP TRIGGER tags_version_au;
                ALTER TABLE session_meta DROP COLUMN tags_version;
            `);
            seedAppliedVersion(db, 85);
            db.prepare("INSERT INTO session_meta(session_id, counter) VALUES(?, 0)").run("ses-a");
            db.prepare("INSERT INTO session_meta(session_id, counter) VALUES(?, 0)").run("ses-b");

            runMigrations(db);
            expect(LATEST_SUPPORTED_VERSION).toBe(86);
            expect(LATEST_SUPPORTED_VERSION).toBe(LATEST_MIGRATION_VERSION);
            expect(tagsVersion(db, "ses-a")).toBe(0);
            expect(tagsVersion(db, "ses-b")).toBe(0);

            db.prepare(
                "INSERT INTO tags(session_id, message_id, type, byte_size, tag_number, harness) VALUES(?, ?, 'message', 1, 1, 'opencode')",
            ).run("ses-a", "msg-a:p0");
            expect(tagsVersion(db, "ses-a")).toBe(1);
            expect(tagsVersion(db, "ses-b")).toBe(0);

            db.prepare("UPDATE tags SET message_id = ? WHERE session_id = ?").run(
                "msg-a:p1",
                "ses-a",
            );
            expect(tagsVersion(db, "ses-a")).toBe(2);
        } finally {
            closeQuietly(db);
        }
    });
});
