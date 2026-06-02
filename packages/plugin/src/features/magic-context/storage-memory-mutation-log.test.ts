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

    // Audit finding #12: render coalescing is "newest mutation-log id per target",
    // with no terminal-state precedence. If a memory rendered in m[0] is archived
    // and then later updated (update does NOT gate on status), the update row has
    // the higher id and WINS — the m[1] <memory-updates> delta shows the memory as
    // present/updated even though the canonical table state is archived. This
    // characterization test documents the CURRENT behavior so we can decide
    // whether archive/delete should take precedence over a later update before
    // changing it.
    test("CURRENT BEHAVIOR: a later update outranks an earlier archive (no terminal precedence)", () => {
        const database = makeDb();
        queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "archive",
            targetMemoryId: 10,
            queuedAt: 100,
        });
        const update = queueMemoryMutation(database, {
            projectPath: "/repo/a",
            mutationType: "update",
            targetMemoryId: 10,
            category: "PROJECT_RULES",
            newContent: "resurrected content",
            queuedAt: 200,
        });

        // Memory 10 was rendered in m[0] (active at materialization), then archived,
        // then updated. Newest-by-id wins → the render shows the UPDATE, not the archive.
        const rows = getMemoryMutationsForRender(database, "/repo/a", 0, [10]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual(update);
        expect(rows[0]?.mutationType).toBe("update"); // archive is masked
    });
});
