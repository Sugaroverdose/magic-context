/// <reference types="bun-types" />

import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { appendCompartments } from "../compartment-storage";
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

describe("createDreamTaskExecutor — classify-memories", () => {
    test("loads active pool and last 30 trajectory compartments without verification gate", async () => {
        db = freshDb();
        const project = "/repo/project";
        const memory = insertMemory(db, {
            projectPath: project,
            category: "CONSTRAINTS",
            content: "External API requests must include x-trace-id for auditability.",
        });
        recordMemoryVerifications(db, memory.id, ["src/api.ts"], Date.now());
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, 'opencode', ?, ?)",
        ).run("session-a", project, Date.now());
        appendCompartments(
            db,
            "session-a",
            Array.from({ length: 35 }, (_, i) => ({
                sequence: i + 1,
                startMessage: i * 2,
                endMessage: i * 2 + 1,
                startMessageId: `m${i}-a`,
                endMessageId: `m${i}-b`,
                title: `compartment ${i + 1}`,
                content: `trajectory content ${i + 1}`,
                p1: `trajectory p1 ${i + 1}`,
            })),
        );

        let capturedPrompt = "";
        const client = {
            session: {
                list: mock(async () => ({ data: [] })),
                create: mock(async () => ({ data: { id: "dream-child" } })),
                prompt: mock(async (args: { body?: { parts?: Array<{ text?: string }> } }) => {
                    capturedPrompt = args.body?.parts?.[0]?.text ?? "";
                    return {};
                }),
                messages: mock(async () => ({
                    data: assistantMessages("classification complete"),
                })),
                delete: mock(async () => ({})),
            },
        };
        const executor = createDreamTaskExecutor({
            client: client as never,
            sessionDirectory: project,
            openOpenCodeDb: () => null,
        });

        const result = await executor(
            { task: "classify-memories", schedule: "0 6 * * *", timeoutMinutes: 20 },
            {
                db,
                projectIdentity: project,
                holderId: "holder-classify",
                leaseKey: leaseKeyFor("classify-memories", project),
            },
        );

        expect(result).toEqual({ status: "completed", schedulePatch: undefined });
        expect(capturedPrompt).toContain("## Task: Classify Project Memories");
        expect(capturedPrompt).toContain(memory.content);
        expect(capturedPrompt).toContain("importance=50 scope=project shareable=false");
        expect(capturedPrompt).toContain('ctx_memory(action="classify"');
        expect(capturedPrompt).not.toContain("Mapped files: src/api.ts");
        expect(capturedPrompt).not.toContain("git log");
        expect(capturedPrompt).toContain("compartment 35");
        expect(capturedPrompt).toContain("trajectory p1 35");
        expect(capturedPrompt).toContain("compartment 6");
        expect(capturedPrompt).not.toContain("compartment 5");
    });
});
