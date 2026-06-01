import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { initializeDatabase } from "./storage-db";
import {
    getMaxMemoryMutationId,
    getMemoryMutationsForRender,
    queueMemoryMutation,
} from "./storage-memory-mutation-log";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
});

describe("storage-memory-mutation-log", () => {
    test("queues project-scoped memory mutations and reports max id", () => {
        const database = makeDb();
        const first = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 10,
            queuedAt: 100,
        });
        const second = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 11,
            category: "PROJECT_RULES",
            newContent: "Updated content",
            queuedAt: 200,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/b",
            mutationType: "delete",
            targetMemoryId: 10,
            queuedAt: 300,
        });

        expect(first.projectPath).toBe("/repo/a");
        expect(second.newContent).toBe("Updated content");
        expect(getMaxMemoryMutationId(database, "/repo/a")).toBe(second.id);
        expect(getMaxMemoryMutationId(database, "/repo/missing")).toBeNull();
    });

    test("returns newest mutation per rendered target memory", () => {
        const database = makeDb();
        const older = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "older",
            queuedAt: 100,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 99,
            queuedAt: 150,
        });
        const newer = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "delete",
            targetMemoryId: 10,
            queuedAt: 200,
        });
        const superseded = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "superseded",
            targetMemoryId: 11,
            supersededById: 12,
            queuedAt: 300,
        });

        const rows = getMemoryMutationsForRender(database, "/repo/a", older.id - 1, [10, 11]);

        expect(rows).toEqual([newer, superseded]);
    });

    test("filters by cursor, project, and rendered ids", () => {
        const database = makeDb();
        const first = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 10,
            queuedAt: 100,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "delete",
            targetMemoryId: 11,
            queuedAt: 200,
        });
        queueMemoryMutation(database, {
            projectPath: "/repo/b",
            mutationType: "update",
            targetMemoryId: 10,
            newContent: "other project",
            queuedAt: 300,
        });

        expect(getMemoryMutationsForRender(database, "/repo/a", first.id, [10])).toEqual([]);
        expect(getMemoryMutationsForRender(database, "/repo/a", 0, [])).toEqual([]);
    });
});
