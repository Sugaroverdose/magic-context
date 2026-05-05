/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { indexSingleMessage } from "./message-index";
import { initializeDatabase } from "./storage-db";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

function indexedRows(db: Database, sessionId: string): Array<{ message_id: string }> {
    return db
        .prepare("SELECT message_id FROM message_history_fts WHERE session_id = ?")
        .all(sessionId) as Array<{ message_id: string }>;
}

describe("message-index", () => {
    let db: Database;

    beforeEach(() => {
        db = createTestDb();
    });

    afterEach(() => {
        closeQuietly(db);
    });

    it("indexSingleMessage skips already-indexed messages", () => {
        const message: RawMessage = {
            ordinal: 1,
            id: "m-1",
            role: "user",
            parts: [{ type: "text", text: "indexed once" }],
        };

        expect(indexSingleMessage(db, "ses-1", message)).toBe(true);
        expect(indexSingleMessage(db, "ses-1", message)).toBe(false);

        expect(indexedRows(db, "ses-1")).toEqual([{ message_id: "m-1" }]);
    });
});
