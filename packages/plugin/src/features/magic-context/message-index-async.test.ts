/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    __resetMessageIndexAsyncForTests,
    clearSessionTracking,
    isSessionReconciled,
    scheduleClearAndReindex,
    scheduleIncrementalIndex,
    scheduleReconciliation,
} from "./message-index-async";
import { initializeDatabase } from "./storage-db";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

function message(id: string, ordinal: number, text: string): RawMessage {
    return {
        id,
        ordinal,
        role: "user",
        parts: [{ type: "text", text }],
    };
}

function wait(ms = 0): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function countRows(db: Database, sessionId: string): number {
    const row = db
        .prepare("SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ?")
        .get(sessionId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

function countMessageRows(db: Database, sessionId: string, messageId: string): number {
    const row = db
        .prepare(
            "SELECT COUNT(*) AS count FROM message_history_fts WHERE session_id = ? AND message_id = ?",
        )
        .get(sessionId, messageId) as { count?: number } | null;
    return typeof row?.count === "number" ? row.count : 0;
}

describe("message-index-async", () => {
    let db: Database;

    beforeEach(() => {
        __resetMessageIndexAsyncForTests();
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
        __resetMessageIndexAsyncForTests();
    });

    it("dedupes concurrent reconciliation schedules for one session", async () => {
        const messages = [message("m-1", 1, "alpha")];
        let reads = 0;

        scheduleReconciliation(db, "ses-async", () => {
            reads++;
            return messages;
        });
        scheduleReconciliation(db, "ses-async", () => {
            reads++;
            return messages;
        });

        await wait(20);

        expect(reads).toBe(1);
        expect(countRows(db, "ses-async")).toBe(1);
        expect(isSessionReconciled("ses-async")).toBe(true);
    });

    it("does not double-insert when incremental indexing overlaps reconciliation", async () => {
        const messages = [message("m-1", 1, "alpha overlap")];
        scheduleReconciliation(db, "ses-overlap", () => messages);
        scheduleIncrementalIndex(db, "ses-overlap", "m-1", () => messages[0] ?? null);

        await wait(140);

        expect(countMessageRows(db, "ses-overlap", "m-1")).toBe(1);
    });

    it("clears and rebuilds after a removed message", async () => {
        const first = [message("m-1", 1, "old"), message("m-2", 2, "keep")];
        scheduleReconciliation(db, "ses-clear", () => first);
        await wait(20);

        const rebuilt = [message("m-2", 1, "keep")];
        scheduleClearAndReindex(db, "ses-clear", () => rebuilt);
        await wait(20);

        expect(countMessageRows(db, "ses-clear", "m-1")).toBe(0);
        expect(countMessageRows(db, "ses-clear", "m-2")).toBe(1);
        expect(isSessionReconciled("ses-clear")).toBe(true);
    });

    it("catches indexing errors without propagating", async () => {
        expect(() =>
            scheduleReconciliation(db, "ses-error", () => {
                throw new Error("boom");
            }),
        ).not.toThrow();

        await wait(20);
        expect(isSessionReconciled("ses-error")).toBe(false);
    });

    it("clearSessionTracking releases module state", async () => {
        scheduleReconciliation(db, "ses-track", () => [message("m-1", 1, "alpha")]);
        await wait(20);
        expect(isSessionReconciled("ses-track")).toBe(true);

        clearSessionTracking("ses-track");

        expect(isSessionReconciled("ses-track")).toBe(false);
    });
});
