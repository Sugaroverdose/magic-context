import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { recordMessageFtsRowid } from "./message-fts-rowid-map";
import { drainOrphanedOpenCodeMessageIndexes } from "./message-index";
import { runMigrations } from "./migrations";
import { prepareSessionCleanupBatch } from "./session-cleanup-batch";
import { initializeDatabase } from "./storage-db";
import {
    clearSessionBatch,
    drainPendingSessionCleanups,
    markSessionCleanupPending,
    retryPendingSessionCleanups,
} from "./storage-meta-session";

function fixture() {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

test("pending cleanup caps a transaction at 25 rows even for an oversized session request", async () => {
    const db = fixture();
    try {
        const insert = db.prepare(
            "INSERT INTO tags(session_id,tag_number,harness) VALUES('large-cleanup',?,'opencode')",
        );
        for (let i = 0; i < 150; i++) insert.run(i);
        markSessionCleanupPending(db, "large-cleanup");
        let admissions = 0;
        const exec = db.exec.bind(db);
        db.exec = (sql) => {
            if (sql === "BEGIN IMMEDIATE") admissions++;
            return exec(sql);
        };
        expect(retryPendingSessionCleanups(db, 200)).toEqual({
            attempted: 1,
            cleared: 0,
            failedSessionIds: [],
        });
        expect(admissions).toBe(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 125 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_session_cleanup").get()).toEqual({
            n: 1,
        });
        expect((await drainPendingSessionCleanups(db)).cleared).toBe(1);
        expect(admissions).toBeGreaterThan(1);
        expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 0 });
    } finally {
        db.close();
    }
});

test("cleanup removes each bounded FTS slice and its locator map atomically", async () => {
    const db = fixture();
    try {
        for (let i = 0; i < 60; i++) {
            const result = db
                .prepare(
                    "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('fts-cleanup',?,?,'user','bytes')",
                )
                .run(i, `m-${i}`);
            recordMessageFtsRowid(db, "fts-cleanup", i, result.lastInsertRowid);
        }
        markSessionCleanupPending(db, "fts-cleanup");
        expect(clearSessionBatch(db, "fts-cleanup").rowsDeleted).toBe(25);
        expect(db.prepare("SELECT COUNT(*) AS n FROM message_history_fts").get()).toEqual({
            n: 35,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM message_fts_rowid_map").get()).toEqual({
            n: 35,
        });
        expect(
            db
                .prepare(
                    "SELECT COUNT(*) AS n FROM message_history_fts WHERE rowid NOT IN (SELECT fts_rowid FROM message_fts_rowid_map)",
                )
                .get(),
        ).toEqual({ n: 0 });
        expect((await drainPendingSessionCleanups(db)).cleared).toBe(1);
    } finally {
        db.close();
    }
});

test("Rust cleanup commits its final project coordinate and retry marker together", () => {
    const db = fixture();
    try {
        db.prepare(
            "INSERT INTO session_projects VALUES('rust-final','opencode','git:project',0)",
        ).run();
        markSessionCleanupPending(db, "rust-final", true);
        expect(clearSessionBatch(db, "rust-final")).toMatchObject({
            blocked: true,
            completed: false,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM session_projects").get()).toEqual({ n: 1 });
        expect(clearSessionBatch(db, "rust-final", true).completed).toBe(true);
        expect(db.prepare("SELECT COUNT(*) AS n FROM session_projects").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_session_cleanup").get()).toEqual({
            n: 0,
        });
    } finally {
        db.close();
    }
});

test("scoped cleanup preserves another harness's rows and project coordinates", async () => {
    const db = fixture();
    try {
        db.prepare(
            "INSERT INTO pending_session_cleanup VALUES('shared','opencode:orphan',0,NULL)",
        ).run();
        for (const harness of ["opencode", "pi"]) {
            db.prepare("INSERT INTO tags(session_id,tag_number,harness) VALUES('shared',?,?)").run(
                harness === "pi" ? 2 : 1,
                harness,
            );
            db.prepare("INSERT INTO session_projects VALUES('shared',?,'git:project',0)").run(
                harness,
            );
        }
        expect(
            (
                await drainOrphanedOpenCodeMessageIndexes(db, () => {
                    const source = new Database(":memory:");
                    source.exec("CREATE TABLE session(id TEXT PRIMARY KEY)");
                    return source;
                })
            ).deleted,
        ).toBe(1);
        expect(db.prepare("SELECT harness FROM tags").all()).toEqual([{ harness: "pi" }]);
        expect(db.prepare("SELECT harness FROM session_projects").all()).toEqual([
            { harness: "pi" },
        ]);
    } finally {
        db.close();
    }
});

test("cleanup rollback retains both the FTS row and locator when the paired delete fails", () => {
    const db = fixture();
    try {
        const result = db
            .prepare(
                "INSERT INTO message_history_fts(session_id,message_ordinal,message_id,role,content) VALUES('rollback',1,'m1','user','bytes')",
            )
            .run();
        recordMessageFtsRowid(db, "rollback", 1, result.lastInsertRowid);
        db.exec(
            "CREATE TRIGGER reject_locator_delete BEFORE DELETE ON message_fts_rowid_map BEGIN SELECT RAISE(ABORT,'locator failure'); END",
        );
        const commit = prepareSessionCleanupBatch(db, "rollback");
        expect(() => db.transaction(commit).immediate()).toThrow("locator failure");
        expect(db.prepare("SELECT COUNT(*) AS n FROM message_history_fts").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM message_fts_rowid_map").get()).toEqual({
            n: 1,
        });
    } finally {
        db.close();
    }
});

test("cleanup does not retire its durable marker after an external writer changes discovery", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-cleanup-race-"));
    const db = new Database(join(dir, "context.db"));
    initializeDatabase(db);
    runMigrations(db);
    const other = new Database(join(dir, "context.db"));
    try {
        markSessionCleanupPending(db, "raced");
        const commit = prepareSessionCleanupBatch(db, "raced");
        other
            .prepare("INSERT INTO tags(session_id,tag_number,harness) VALUES('raced',1,'opencode')")
            .run();
        expect(db.transaction(commit).immediate().completed).toBe(false);
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_session_cleanup").get()).toEqual({
            n: 1,
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 1 });
        expect((await drainPendingSessionCleanups(db)).cleared).toBe(1);
    } finally {
        other.close();
        db.close();
        rmSync(dir, { recursive: true, force: true });
    }
});

test("pending cleanup skips Rust-gated sessions and rotates partial backlogs so later sessions progress", async () => {
    const db = fixture();
    try {
        const pending = db.prepare(
            "INSERT INTO pending_session_cleanup(session_id,harness,requested_at) VALUES(?,?,0)",
        );
        pending.run("a-blocked", "opencode:rust");
        pending.run("b-large", "opencode");
        pending.run("c-ready", "opencode");
        const tag = db.prepare(
            "INSERT INTO tags(session_id,tag_number,harness) VALUES(?,?,'opencode')",
        );
        tag.run("a-blocked", 1);
        tag.run("c-ready", 1);
        for (let i = 0; i < 60; i++) tag.run("b-large", i);
        retryPendingSessionCleanups(db);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id='b-large'").get(),
        ).toEqual({ n: 35 });
        retryPendingSessionCleanups(db);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id='c-ready'").get(),
        ).toEqual({ n: 0 });
        expect((await drainPendingSessionCleanups(db)).cleared).toBe(2);
        expect(
            db.prepare("SELECT COUNT(*) AS n FROM tags WHERE session_id='a-blocked'").get(),
        ).toEqual({ n: 1 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_session_cleanup").get()).toEqual({
            n: 1,
        });
    } finally {
        db.close();
    }
});

test("resumed orphan cleanup requires its host authority and cancels deletion when the session is live again", async () => {
    const db = fixture();
    try {
        db.prepare(
            "INSERT INTO pending_session_cleanup VALUES('restored','opencode:orphan',0,NULL)",
        ).run();
        db.prepare(
            "INSERT INTO tags(session_id,tag_number,harness) VALUES('restored',1,'opencode')",
        ).run();
        expect(retryPendingSessionCleanups(db).attempted).toBe(0);
        expect((await drainOrphanedOpenCodeMessageIndexes(db, () => null)).status).toBe(
            "source_unavailable",
        );
        expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_session_cleanup").get()).toEqual({
            n: 1,
        });
        await drainOrphanedOpenCodeMessageIndexes(db, () => {
            const source = new Database(":memory:");
            source.exec(
                "CREATE TABLE session(id TEXT PRIMARY KEY); INSERT INTO session VALUES('restored')",
            );
            return source;
        });
        expect(db.prepare("SELECT COUNT(*) AS n FROM tags").get()).toEqual({ n: 1 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM pending_session_cleanup").get()).toEqual({
            n: 0,
        });
    } finally {
        db.close();
    }
});
