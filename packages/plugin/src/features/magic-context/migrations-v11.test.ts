/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    clearPersistedTodoBlock,
    getOrCreateSessionMeta,
    getPersistedTodoBlock,
    setPersistedTodoBlock,
    updateSessionMeta,
} from "./storage-meta";

const TODO_COLUMNS = ["last_todo_state", "todo_sticky_text", "todo_sticky_message_id"];

function tableColumns(db: Database): Map<string, { type: string; dflt_value: string | null }> {
    const rows = db.prepare("PRAGMA table_info(session_meta)").all() as Array<{
        name: string;
        type: string;
        dflt_value: string | null;
    }>;
    return new Map(rows.map((row) => [row.name, row]));
}

describe("schema migration v11", () => {
    test("fresh database has todo state synthesis columns", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        const columns = tableColumns(db);
        for (const name of TODO_COLUMNS) {
            const column = columns.get(name);
            expect(column).toBeDefined();
            expect(column?.type).toBe("TEXT");
            expect(column?.dflt_value).toBe("''");
        }

        closeQuietly(db);
    });

    test("v10 to v11 upgrade adds columns with empty-string defaults", () => {
        const db = new Database(":memory:");
        db.exec(`
            CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                description TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            );
            CREATE TABLE session_meta (
                session_id TEXT PRIMARY KEY
            );
            INSERT INTO session_meta (session_id) VALUES ('ses-upgrade');
        `);
        for (let v = 1; v <= 10; v++) {
            db.prepare(
                "INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
            ).run(v, `pre-v11 baseline v${v}`, Date.now());
        }

        runMigrations(db);

        const columns = tableColumns(db);
        for (const name of TODO_COLUMNS) {
            expect(columns.get(name)).toBeDefined();
        }
        const row = db
            .prepare(
                "SELECT last_todo_state, todo_sticky_text, todo_sticky_message_id FROM session_meta WHERE session_id = ?",
            )
            .get("ses-upgrade") as {
            last_todo_state: string;
            todo_sticky_text: string;
            todo_sticky_message_id: string;
        };
        expect(row).toEqual({
            last_todo_state: "",
            todo_sticky_text: "",
            todo_sticky_message_id: "",
        });

        closeQuietly(db);
    });

    test("migration rerun is idempotent", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const version = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
            v: number;
        };

        runMigrations(db);

        const after = db.prepare("SELECT MAX(version) as v FROM schema_migrations").get() as {
            v: number;
        };
        expect(after.v).toBe(version.v);

        closeQuietly(db);
    });

    test("session meta reads and writes lastTodoState", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        expect(getOrCreateSessionMeta(db, "ses-todo").lastTodoState).toBe("");
        updateSessionMeta(db, "ses-todo", { lastTodoState: "[]" });
        expect(getOrCreateSessionMeta(db, "ses-todo").lastTodoState).toBe("[]");

        closeQuietly(db);
    });

    test("persisted todo block helpers round trip and clear", () => {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);

        expect(getPersistedTodoBlock(db, "ses-sticky")).toBeNull();
        setPersistedTodoBlock(db, "ses-sticky", "\n\n<current-todos>todo</current-todos>", "msg-1");
        expect(getPersistedTodoBlock(db, "ses-sticky")).toEqual({
            text: "\n\n<current-todos>todo</current-todos>",
            messageId: "msg-1",
        });
        clearPersistedTodoBlock(db, "ses-sticky");
        expect(getPersistedTodoBlock(db, "ses-sticky")).toBeNull();

        closeQuietly(db);
    });
});
