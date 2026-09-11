import { describe, expect, test } from "bun:test";

import { runMigrations } from "../src/features/magic-context/migrations";
import { initializeDatabase } from "../src/features/magic-context/storage-db";
import { Database } from "../src/shared/sqlite";
import {
    CREATED_AT_READER_AUDIT,
    formatMirrorCreatedAtRepairReport,
    repairMirrorCreatedAt,
} from "./repair-mirror-created-at";

function contextDatabase(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function moduleDatabase(): Database {
    const database = new Database(":memory:");
    database.exec(`
        CREATE TABLE mc_memories (
            id INTEGER PRIMARY KEY,
            project_path TEXT NOT NULL,
            normalized_hash TEXT NOT NULL,
            first_seen_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL,
            classified_at INTEGER,
            verified_at INTEGER
        )
    `);
    return database;
}

function insertMirroredContextRow(
    database: Database,
    values: { id: number; normalizedHash: string; updatedAt?: number },
): void {
    database
        .prepare(
            `INSERT INTO memories(
                id, project_path, category, content, normalized_hash, first_seen_at, created_at,
                updated_at, last_seen_at, classified_at, verified_at
             ) VALUES (?, '/repo', 'CONSTRAINTS', 'mirrored', ?, 0, 0, ?, 0, NULL, NULL)`,
        )
        .run(values.id, values.normalizedHash, values.updatedAt ?? 0);
    database
        .prepare(
            `INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id)
             VALUES ('memories', '/repo', ?, ?)`,
        )
        .run(values.id + 1_000, values.id);
}

function insertModuleRow(
    database: Database,
    values: { id: number; normalizedHash: string; createdAt: number },
): void {
    database
        .prepare(
            `INSERT INTO mc_memories(
                id, project_path, normalized_hash, first_seen_at, created_at, updated_at,
                last_seen_at, classified_at, verified_at
             ) VALUES (?, '/repo', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            values.id,
            values.normalizedHash,
            values.createdAt - 1_000,
            values.createdAt,
            values.createdAt + 1_000,
            values.createdAt + 2_000,
            values.createdAt + 3_000,
            values.createdAt + 4_000,
        );
}

describe("repair mirror created_at", () => {
    test("dry-run prints the exact hash/project match without writing", () => {
        const context = contextDatabase();
        const module = moduleDatabase();
        insertMirroredContextRow(context, { id: 7, normalizedHash: "exact-hash" });
        insertModuleRow(module, { id: 70, normalizedHash: "exact-hash", createdAt: 12_345 });

        const report = repairMirrorCreatedAt(context, module, { apply: false });

        expect(report).toEqual({
            apply: false,
            candidates: [
                {
                    contextId: 7,
                    projectPath: "/repo",
                    normalizedHash: "exact-hash",
                    contextCreatedAt: 0,
                    moduleRowIds: [70],
                    moduleCreatedAt: 12_345,
                    disposition: "repairable",
                },
            ],
            repaired: 0,
        });
        expect(
            (context.prepare("SELECT created_at FROM memories WHERE id = 7").get() as {
                created_at: number;
            }).created_at,
        ).toBe(0);
        const output = formatMirrorCreatedAtRepairReport(report);
        expect(output).toContain(CREATED_AT_READER_AUDIT);
        expect(output).toContain("7 | /repo | exact-hash | 70 | 12345 | repairable");
        expect(output).toContain("no writes performed");
    });

    test("apply restores module timestamps without replacing a newer host timestamp", () => {
        const context = contextDatabase();
        const module = moduleDatabase();
        insertMirroredContextRow(context, {
            id: 8,
            normalizedHash: "apply-hash",
            updatedAt: 99_999,
        });
        insertModuleRow(module, { id: 80, normalizedHash: "apply-hash", createdAt: 20_000 });

        const report = repairMirrorCreatedAt(context, module, { apply: true });

        expect(report.repaired).toBe(1);
        expect(
            context
                .prepare(
                    `SELECT first_seen_at, created_at, updated_at, last_seen_at, classified_at,
                            verified_at FROM memories WHERE id = 8`,
                )
                .get(),
        ).toEqual({
            first_seen_at: 19_000,
            created_at: 20_000,
            updated_at: 99_999,
            last_seen_at: 22_000,
            classified_at: 23_000,
            verified_at: 24_000,
        });
    });

    test("apply refuses ambiguous hash/project matches", () => {
        const context = contextDatabase();
        const module = moduleDatabase();
        insertMirroredContextRow(context, { id: 9, normalizedHash: "ambiguous-hash" });
        insertModuleRow(module, { id: 90, normalizedHash: "ambiguous-hash", createdAt: 30_000 });
        insertModuleRow(module, { id: 91, normalizedHash: "ambiguous-hash", createdAt: 31_000 });

        const report = repairMirrorCreatedAt(context, module, { apply: true });

        expect(report.repaired).toBe(0);
        expect(report.candidates[0]).toMatchObject({
            moduleRowIds: [90, 91],
            disposition: "ambiguous-module-rows",
        });
        expect(
            (context.prepare("SELECT created_at FROM memories WHERE id = 9").get() as {
                created_at: number;
            }).created_at,
        ).toBe(0);
    });
});
