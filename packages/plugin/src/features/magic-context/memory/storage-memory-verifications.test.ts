/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { insertMemory, updateMemoryVerification } from "./storage-memory";
import {
    clearMemoryVerifications,
    getMemoryVerifications,
    recordMemoryVerifications,
} from "./storage-memory-verifications";

function freshDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("memory verification side-table helpers", () => {
    test("record/get/clear side-table rows without mutating memories", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "CONFIG_VALUES",
                content: "Config lives in src/config.ts.",
                sourceSessionId: "ses",
            });
            const before = db
                .prepare(
                    "SELECT verification_status, verified_at, updated_at FROM memories WHERE id=?",
                )
                .get(memory.id);

            expect(recordMemoryVerifications(db, memory.id, ["src/config.ts"], 1234)).toBe(1);
            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual(["src/config.ts"]);
            expect(state?.hasSentinel).toBe(false);
            expect(state?.verifiedAt).toBe(1234);

            const after = db
                .prepare(
                    "SELECT verification_status, verified_at, updated_at FROM memories WHERE id=?",
                )
                .get(memory.id);
            expect(after).toEqual(before);

            clearMemoryVerifications(db, memory.id);
            expect(getMemoryVerifications(db, [memory.id]).has(memory.id)).toBe(false);
        } finally {
            closeQuietly(db);
        }
    });

    test("empty files write the no-file sentinel and do not call row verification mutation", () => {
        const db = freshDb();
        try {
            const memory = insertMemory(db, {
                projectPath: "git:test",
                category: "PROJECT_RULES",
                content: "Prefer narrow tests.",
                sourceSessionId: "ses",
            });
            recordMemoryVerifications(db, memory.id, [], 2000);

            const state = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(state?.files).toEqual([]);
            expect(state?.hasSentinel).toBe(true);
            expect(state?.verifiedAt).toBe(2000);

            updateMemoryVerification(db, memory.id, "verified", 3000);
            const stillSideTable = getMemoryVerifications(db, [memory.id]).get(memory.id);
            expect(stillSideTable?.verifiedAt).toBe(2000);
        } finally {
            closeQuietly(db);
        }
    });
});
