/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { type CloneSessionStateFilter, copySessionStateForClone } from "./storage-clone";
import { initializeDatabase } from "./storage-db";

const SOURCE = "ses_source";
const DESTINATION = "ses_destination";

const openDbs: Database[] = [];

function createDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    openDbs.push(db);
    return db;
}

afterEach(() => {
    for (const db of openDbs.splice(0)) closeQuietly(db);
});

function insertTag(
    db: Database,
    sessionId: string,
    messageId: string,
    tagNumber: number,
    type: "message" | "tool" = "message",
): number {
    const result = db
        .prepare(
            "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, ?, 'active', 1, ?, 'opencode')",
        )
        .run(sessionId, messageId, type, tagNumber);
    return Number(result.lastInsertRowid);
}

function seedSessionMeta(db: Database, sessionId: string): void {
    db.prepare(
        "INSERT INTO session_meta (session_id, harness, counter) VALUES (?, 'opencode', 0) ON CONFLICT(session_id) DO NOTHING",
    ).run(sessionId);
}

function identityFilter(overrides: Partial<CloneSessionStateFilter> = {}): CloneSessionStateFilter {
    return {
        resolveBoundaryOrdinal: () => 1,
        includeTag: () => true,
        includeMessageId: () => true,
        selectPendingPiMarker: () => null,
        ...overrides,
    };
}

describe("copySessionStateForClone", () => {
    it("keeps queued drops keyed by tag number when tag ids are remapped", () => {
        const db = createDb();
        // A row in another session makes the source tag's row id differ from its tag number.
        insertTag(db, "ses_other", "msg_other:p0", 1);
        insertTag(db, "ses_other", "msg_other:p1", 2);
        insertTag(db, SOURCE, "msg_a:p0", 1);
        insertTag(db, SOURCE, "msg_b:p0", 2);
        seedSessionMeta(db, SOURCE);
        // Production queues ctx_reduce drops by tag number (see queuePendingOp callers).
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 2, 'drop', 10, 'opencode')",
        ).run(SOURCE);

        const result = copySessionStateForClone(
            db,
            SOURCE,
            DESTINATION,
            identityFilter({ mapTagId: (_source, destination) => destination }),
        );

        expect(result.pendingOpsCopied).toBe(1);
        const queued = db
            .prepare("SELECT tag_id, operation FROM pending_ops WHERE session_id = ?")
            .all(DESTINATION);
        expect(queued).toEqual([{ tag_id: 2, operation: "drop" }]);
    });

    it("never binds more SQL variables than node:sqlite allows for a large session", () => {
        const db = createDb();
        // node:sqlite (Pi, OpenCode Desktop) is built with the SQLite default of
        // 32766 bind variables; bun:sqlite allows far more, so the limit is
        // enforced here by refusing any statement above it.
        const NODE_SQLITE_MAX_VARIABLES = 32_766;
        const tagCount = NODE_SQLITE_MAX_VARIABLES + 10;
        db.exec("BEGIN");
        const insert = db.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, byte_size, tag_number, harness) VALUES (?, ?, 'message', 'active', 1, ?, 'opencode')",
        );
        const insertSource = db.prepare(
            "INSERT INTO source_contents (tag_id, session_id, content, created_at, harness) VALUES (?, ?, 'text', 1, 'opencode')",
        );
        for (let tag = 1; tag <= tagCount; tag += 1) {
            insert.run(SOURCE, `msg_${tag}:p0`, tag);
            insertSource.run(tag, SOURCE);
        }
        db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'drop', 10, 'opencode')",
        ).run(SOURCE, tagCount);
        db.exec("COMMIT");
        seedSessionMeta(db, SOURCE);

        const prepare = db.prepare.bind(db);
        (db as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
            const variables = sql.split("?").length - 1;
            if (variables > NODE_SQLITE_MAX_VARIABLES) throw new Error("too many SQL variables");
            return prepare(sql);
        };

        const result = copySessionStateForClone(db, SOURCE, DESTINATION, identityFilter());

        expect(result.tagsCopied).toBe(tagCount);
        expect(result.pendingOpsCopied).toBe(1);
        const copiedSources = db
            .prepare("SELECT COUNT(*) AS count FROM source_contents WHERE session_id = ?")
            .get(DESTINATION) as { count: number };
        expect(copiedSources.count).toBe(tagCount);
    });
});
