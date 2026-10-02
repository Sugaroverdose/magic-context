// Destructive workload probes are restricted to a disposable database copy.
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const path = realpathSync(process.argv[2]);
assert(path.startsWith(`${realpathSync(tmpdir())}/magic-context/`), "a throwaway database copy is required");
const root = dirname(path);
process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
process.env.MAGIC_CONTEXT_LOG_PATH = join(root, "cleanup-probe.log");
process.env.XDG_DATA_HOME = root;
process.env.XDG_CACHE_HOME = root;
const { Database } = await import("../src/shared/sqlite");
const { clearSession, clearSessionBatch } = await import("../src/features/magic-context/storage-meta-session");
const { sweepOrphanedOpenCodeMessageIndexes } = await import("../src/features/magic-context/message-index");
const { deleteSessionScopedRows, SESSION_SCOPED_TABLES } = await import("../src/features/magic-context/storage-session-tables");
const db = new Database(path);
const sessions = db.prepare("SELECT session_id FROM tags GROUP BY session_id ORDER BY COUNT(*) DESC LIMIT 3").all() as Array<{ session_id: string }>;
const mode = process.argv[3];
try {
    if (mode === "after" || mode === "fts-phase") {
        if (mode === "fts-phase") {
            // On a separate copy, remove earlier stages so the real cleanup API
            // can exercise its later FTS phase without spending minutes on tags.
            // Setup is committed before the measured writer is acquired.
            db.exec("BEGIN IMMEDIATE");
            try {
                for (const { session_id } of sessions) {
                    for (const { table, extraPredicate } of SESSION_SCOPED_TABLES) {
                        if (["message_history_fts", "message_fts_rowid_map", "pending_session_cleanup", "session_projects", "lkg_slots", "lkg_slot_chunks"].includes(table)) continue;
                        db.prepare(`DELETE FROM ${table} WHERE session_id=?${extraPredicate ? ` AND (${extraPredicate})` : ""}`).run(session_id);
                    }
                }
                db.exec("COMMIT");
            } catch (error) {
                db.exec("ROLLBACK");
                throw error;
            }
        }
        let acquiredAt: number | undefined;
        const holds: number[] = [];
        const exec = db.exec.bind(db);
        db.exec = (sql: string) => {
            const result = exec(sql);
            if (sql === "BEGIN IMMEDIATE") acquiredAt = performance.now();
            if ((sql === "COMMIT" || sql === "ROLLBACK") && acquiredAt !== undefined) {
                holds.push(performance.now() - acquiredAt);
                acquiredAt = undefined;
            }
            return result;
        };
        for (const { session_id: session } of sessions) {
            if (mode === "fts-phase") {
                const count = db.prepare("SELECT COUNT(*) AS n FROM message_fts_rowid_map WHERE session_id=?").get(session) as { n: number };
                assert(count.n >= 125, "a non-empty copied FTS workload is required");
            }
            for (let batch = 0; batch < 5; batch++) {
                const ids: number[] = mode === "fts-phase" ? (db.prepare("SELECT fts_rowid AS id FROM message_fts_rowid_map WHERE session_id=? LIMIT 25").all(session) as Array<{ id: number }>).map(({ id }) => id) : [];
                const placeholders: string = ids.map(() => "?").join(",");
                const fts: { n: number; bytes: number } | undefined = ids.length ? db.prepare(`SELECT COUNT(*) AS n, SUM(length(CAST(content AS BLOB))) AS bytes FROM message_history_fts WHERE rowid IN (${placeholders}) AND session_id=?`).get(...ids, session) as { n: number; bytes: number } : undefined;
                if (fts) assert.equal(fts.n, 25, "probe must reach real copied FTS rows");
                holds.length = 0;
                const result = clearSessionBatch(db, session, true);
                if (ids.length) assert.deepEqual(db.prepare(`SELECT COUNT(*) AS n FROM message_history_fts WHERE rowid IN (${placeholders})`).get(...ids), { n: 0 });
                console.log(JSON.stringify({ workload: mode === "fts-phase" ? "bounded-fts-session-clear" : "bounded-session-clear", session, batch, ftsBytes: fts?.bytes, holdsMs: [...holds], result }));
            }
        }
        if (mode === "after") {
            const target = sessions[0].session_id;
            db.prepare("UPDATE message_history_orphan_sweep SET cursor_session_id=?, last_swept_at=NULL WHERE harness='opencode'").run(target.slice(0, -1));
            holds.length = 0;
            // An empty disposable source deliberately makes copied sessions orphaned.
            // It is a stress fixture, not a claim these sessions are absent in production.
            const result = sweepOrphanedOpenCodeMessageIndexes(db, () => {
                const source = new Database(":memory:");
                source.exec("CREATE TABLE session(id TEXT PRIMARY KEY)");
                return source;
            }, { now: Date.now() + 30 * 86400000 });
            console.log(JSON.stringify({ workload: "bounded-orphan-sweep", holdsMs: holds, result }));
        }
    } else {
        // Roll back the old whole-session workload to preserve identical data for
        // subsequent bounded measurements. The clock excludes rollback itself.
        if (mode !== "before-orphan") {
            for (const { session_id: session } of sessions) {
                db.exec("BEGIN IMMEDIATE");
                const start = performance.now();
                try {
                    clearSession(db, session, true);
                    console.log(JSON.stringify({ workload: "whole-session-clear", session, holdMs: performance.now() - start }));
                } finally {
                    db.exec("ROLLBACK");
                }
            }
        }
        db.exec("BEGIN IMMEDIATE");
        const start = performance.now();
        console.log(JSON.stringify({ workload: "orphan-session-delete-start", sessions: sessions.length, startedAtMs: Date.now() }));
        try {
            deleteSessionScopedRows(db, sessions.map(({ session_id }) => session_id));
            console.log(JSON.stringify({ workload: "orphan-session-delete", sessions: sessions.length, holdMs: performance.now() - start }));
        } finally {
            db.exec("ROLLBACK");
        }
    }
} finally {
    db.close();
}
