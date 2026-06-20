/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory, recordMemoryVerifications } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { insertUserMemory } from "../user-memory/storage-user-memory";
import { createDreamTaskExecutor } from "./task-executor";
import { leaseKeyFor } from "./task-registry";
import type { DreamTaskRuntimeConfig } from "./task-scheduler";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

function assistantMessages(text: string) {
    return [
        {
            info: { role: "assistant", time: { created: Date.now() } },
            parts: [{ type: "text", text }],
        },
    ];
}

describe("createDreamTaskExecutor — curate", () => {
    test("runs whole-pool curation without verification gate or watermark patch", async () => {
        db = freshDb();
        const project = "/repo/project";
        const first = insertMemory(db, {
            projectPath: project,
            category: "ARCHITECTURE",
            content: "First memory uses src/first.ts because it is load-bearing.",
        });
        const second = insertMemory(db, {
            projectPath: project,
            category: "PROJECT_RULES",
            content: "Second memory is a project workflow rule.",
        });
        recordMemoryVerifications(db, first.id, ["src/first.ts"], Date.now());
        insertUserMemory(db, "Prefer concise answers globally.", []);

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({ data: assistantMessages("curation complete") })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });
        const config: DreamTaskRuntimeConfig = {
            task: "curate",
            schedule: "0 4 * * 0",
            timeoutMinutes: 20,
        };

        const result = await executor(config, {
            db,
            projectIdentity: project,
            holderId: "holder-curate",
            leaseKey: leaseKeyFor("curate", project),
        });

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Curate Project Memory Pool (hygiene)");
        expect(capturedPrompt).toContain(first.content);
        expect(capturedPrompt).toContain(second.content);
        expect(capturedPrompt).toContain("Mapped files: src/first.ts");
        expect(capturedPrompt).toContain("### Global user profile (for the redundancy check)");
        expect(capturedPrompt).toContain("Prefer concise answers globally.");
        expect(capturedPrompt).not.toContain('ctx_memory(action="verified"');
        expect(capturedPrompt).not.toContain("verified_files");
    });
});
