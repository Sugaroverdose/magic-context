/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import {
    drainSingleStoreEmbeddingWatermarks,
    getPendingEmbeddingWatermarks,
} from "./single-store-embedding-drain";

function openDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function seedWatermark(db: Database, projectPath: string, written: number, embedded: number): void {
    db.prepare(
        `INSERT INTO memory_embedding_watermarks
            (project_path, written_memory_id, embedded_memory_id, updated_at)
         VALUES (?, ?, ?, 0)`,
    ).run(projectPath, written, embedded);
}

describe("single-store embedding drain", () => {
    test("a project with nothing written past the embedded mark is not pending", () => {
        const db = openDb();
        try {
            seedWatermark(db, "git:caught-up", 40, 40);
            seedWatermark(db, "git:behind", 40, 12);

            expect(getPendingEmbeddingWatermarks(db).map((row) => row.project_path)).toEqual([
                "git:behind",
            ]);
        } finally {
            closeQuietly(db);
        }
    });

    test("a database without the watermark table has nothing to drain", async () => {
        const db = openDb();
        try {
            db.exec("DROP TABLE memory_embedding_watermarks");
            // An older database predates the module writer too, so an absent table means
            // "no module-written rows", not a failure to report.
            expect(getPendingEmbeddingWatermarks(db)).toEqual([]);
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });

    test("the drain advances past a project whose rows cannot be embedded", async () => {
        const db = openDb();
        try {
            // No embedding provider is registered for this project, so the embedder
            // embeds nothing. Without advancing, the same range would be rescanned on
            // every pass for the lifetime of the install.
            seedWatermark(db, "git:no-provider", 7, 0);

            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);

            expect(getPendingEmbeddingWatermarks(db)).toEqual([]);
            expect(
                db
                    .prepare(
                        "SELECT embedded_memory_id FROM memory_embedding_watermarks WHERE project_path = 'git:no-provider'",
                    )
                    .get(),
            ).toEqual({ embedded_memory_id: 7 });
        } finally {
            closeQuietly(db);
        }
    });

    test("draining an empty watermark table does no work", async () => {
        const db = openDb();
        try {
            expect(await drainSingleStoreEmbeddingWatermarks(db)).toBe(0);
        } finally {
            closeQuietly(db);
        }
    });
});
