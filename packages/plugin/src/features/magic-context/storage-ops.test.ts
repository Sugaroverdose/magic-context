/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    clearPendingOps,
    getPendingOps,
    getPendingOpsCount,
    purgeDormantSessionPendingOps,
    queuePendingOp,
    removePendingOp,
} from "./storage-ops";

let db: Database;

function makeMemoryDatabase(): Database {
    const d = new Database(":memory:");
    d.exec(`
    CREATE TABLE IF NOT EXISTS pending_ops (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tag_id INTEGER,
      operation TEXT,
      queued_at INTEGER,
      harness TEXT NOT NULL DEFAULT 'opencode'
    );
  `);
    return d;
}

afterEach(() => {
    if (db) closeQuietly(db);
});

describe("storage-ops", () => {
    describe("pending ops", () => {
        it("queues and returns drop ops in order", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop", 10);
            queuePendingOp(db, "ses-1", 2, "drop", 20);

            expect(getPendingOps(db, "ses-1")).toEqual([
                expect.objectContaining({ tagId: 1, operation: "drop", queuedAt: 10 }),
                expect.objectContaining({ tagId: 2, operation: "drop", queuedAt: 20 }),
            ]);
        });

        it("reports durable queue depth without loading pending-op rows", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop");
            queuePendingOp(db, "ses-1", 2, "drop");
            db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            ).run("ses-1", 3, "noop", Date.now());

            expect(getPendingOpsCount(db, "ses-1")).toBe(3);
            expect(getPendingOpsCount(db, "ses-2")).toBe(0);
        });

        it("ignores unsupported pending-op rows", () => {
            db = makeMemoryDatabase();

            db.prepare(
                "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, ?, ?)",
            ).run("ses-1", 1, "noop", Date.now());
            queuePendingOp(db, "ses-1", 2, "drop");

            const ops = getPendingOps(db, "ses-1");

            expect(ops).toHaveLength(1);
            expect(ops[0]?.tagId).toBe(2);
            expect(ops[0]?.operation).toBe("drop");
        });

        it("clears and removes pending ops by session/tag", () => {
            db = makeMemoryDatabase();

            queuePendingOp(db, "ses-1", 1, "drop");
            queuePendingOp(db, "ses-1", 2, "drop");
            queuePendingOp(db, "ses-2", 3, "drop");

            removePendingOp(db, "ses-1", 1);
            expect(getPendingOps(db, "ses-1")).toHaveLength(1);

            clearPendingOps(db, "ses-1");
            expect(getPendingOps(db, "ses-1")).toEqual([]);
            expect(getPendingOps(db, "ses-2")).toHaveLength(1);
        });
    });

    describe("dormant pending-ops GC", () => {
        const DAY = 86_400_000;

        function makeGcWorld(): Database {
            const d = makeMemoryDatabase();
            d.exec(`
    CREATE TABLE IF NOT EXISTS session_meta (
      session_id TEXT PRIMARY KEY,
      last_response_time INTEGER
    );
  `);
            return d;
        }

        it("clears queued ops of sessions dormant past the TTL; fresh sessions keep theirs", () => {
            db = makeGcWorld();
            const now = 1_761_000_000_000;
            queuePendingOp(db, "ses-dead", 3, "drop", now - 40 * DAY);
            queuePendingOp(db, "ses-live", 5, "drop", now - 5 * DAY);
            db.prepare(
                "INSERT INTO session_meta (session_id, last_response_time) VALUES (?, ?)",
            ).run("ses-dead", now - 40 * DAY);
            db.prepare(
                "INSERT INTO session_meta (session_id, last_response_time) VALUES (?, ?)",
            ).run("ses-live", now - 1 * DAY);

            expect(purgeDormantSessionPendingOps(db, now)).toBe(1);
            expect(getPendingOps(db, "ses-dead")).toEqual([]);
            expect(getPendingOps(db, "ses-live")).toHaveLength(1);
        });

        it("keeps rows of sessions with no recorded response (absence of evidence is not dormancy)", () => {
            db = makeGcWorld();
            const now = 1_761_000_000_000;
            queuePendingOp(db, "ses-unseen", 7, "drop", now - 90 * DAY);
            queuePendingOp(db, "ses-never-answered", 2, "drop", now - 90 * DAY);
            db.prepare(
                "INSERT INTO session_meta (session_id, last_response_time) VALUES (?, ?)",
            ).run("ses-never-answered", 0);

            expect(purgeDormantSessionPendingOps(db, now)).toBe(0);
            expect(getPendingOps(db, "ses-unseen")).toHaveLength(1);
            expect(getPendingOps(db, "ses-never-answered")).toHaveLength(1);
        });
    });

    describe("error propagation", () => {
        it("throws when the database layer fails", () => {
            const failingDb = {
                prepare: () => {
                    throw new Error("db-error");
                },
            } as unknown as Database;

            expect(() => queuePendingOp(failingDb, "s", 1, "drop")).toThrow("db-error");
            expect(() => getPendingOps(failingDb, "s")).toThrow("db-error");
            expect(() => clearPendingOps(failingDb, "s")).toThrow("db-error");
            expect(() => removePendingOp(failingDb, "s", 1)).toThrow("db-error");
        });
    });
});
