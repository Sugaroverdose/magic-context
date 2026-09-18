import { describe, expect, test } from "bun:test";
import { insertMemory } from "../features/magic-context/memory/storage-memory";
import { runMigrations } from "../features/magic-context/migrations";
import { initializeDatabase } from "../features/magic-context/storage-db";
import { Database } from "../shared/sqlite";
import {
    translateHostMemoryIds,
    translateModuleMemoryMutationReply,
    unmappedMemoryIdMessage,
} from "./memory-id-translation";

function db(): Database {
    const value = new Database(":memory:");
    initializeDatabase(value);
    runMigrations(value);
    return value;
}

describe("host/module memory id translation", () => {
    test("an overlap id resolves through the host identity and never the same-numbered module row", () => {
        const database = db();
        const hostTarget = insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "host target",
        });
        const differentHostMemory = insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "different host memory",
        });
        expect([hostTarget.id, differentHostMemory.id]).toEqual([1, 2]);
        database
            .prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', ?, ?)",
            )
            .run(2, hostTarget.id);
        database
            .prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', ?, ?)",
            )
            .run(1, differentHostMemory.id);

        expect(translateHostMemoryIds(database, [1])).toEqual({ moduleIds: [2] });
        expect(translateHostMemoryIds(database, [3])).toEqual({
            error: unmappedMemoryIdMessage(3),
        });
    });

    test("a module write reply returns the mirrored host id and never leaks its module id", () => {
        const database = db();
        insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "existing one",
        });
        insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "existing two",
        });
        const mirrored = insertMemory(database, {
            projectPath: "/repo",
            category: "CONSTRAINTS",
            content: "fresh Rust write",
        });
        database
            .prepare(
                "INSERT INTO mirror_identity(domain, module_project, module_row_id, context_row_id) VALUES ('memories', '/repo', 9003, ?)",
            )
            .run(mirrored.id);
        const response = {
            result: {
                content: [{ type: "text", text: "module text must not escape" }],
                memory_operation: {
                    action: "write",
                    module_id: 9003,
                    category: "CONSTRAINTS",
                },
            },
        };

        const reply = translateModuleMemoryMutationReply({
            db: database,
            moduleProject: "/repo",
            response,
            requestedHostIds: [],
            requestedCategory: "CONSTRAINTS",
        });
        expect(reply).toBe(`Saved memory [ID: ${mirrored.id}] in CONSTRAINTS.`);
        expect(reply).not.toContain("9003");
        expect(
            database.prepare("SELECT id FROM memories WHERE content = ?").get("fresh Rust write"),
        ).toEqual({ id: mirrored.id });
    });

    test("an unmirrored write reports success without exposing a module id", () => {
        const database = db();
        const reply = translateModuleMemoryMutationReply({
            db: database,
            moduleProject: "/repo",
            response: {
                memory_operation: {
                    action: "write",
                    module_id: 42,
                    category: "CONSTRAINTS",
                },
            },
            requestedHostIds: [],
            requestedCategory: "CONSTRAINTS",
        });
        expect(reply).toBe(
            "Saved memory in CONSTRAINTS. Its id will appear in <project-memory> on the next pass.",
        );
        expect(reply).not.toContain("42");
    });
});
