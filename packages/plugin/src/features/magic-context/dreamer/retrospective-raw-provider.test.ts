/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { OpenCodeRetrospectiveRawProvider } from "./retrospective-raw-provider";

const dbs: Database[] = [];

afterEach(() => {
    for (const db of dbs.splice(0)) closeQuietly(db);
});

function memoryDb(): Database {
    const db = new Database(":memory:");
    dbs.push(db);
    return db;
}

function setupContextDb(): Database {
    const db = memoryDb();
    db.exec(`
        CREATE TABLE session_projects (
            session_id TEXT NOT NULL,
            harness TEXT NOT NULL,
            project_path TEXT NOT NULL,
            updated_at INTEGER NOT NULL
        );
    `);
    return db;
}

function setupOpenCodeDb(): Database {
    const db = memoryDb();
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
    `);
    return db;
}

function insertMessage(
    db: Database,
    args: {
        id: string;
        sessionId?: string;
        ts: number;
        role: string;
        parts: unknown[];
        data?: Record<string, unknown>;
    },
): void {
    const sessionId = args.sessionId ?? "s1";
    db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    ).run(
        args.id,
        sessionId,
        args.ts,
        args.ts,
        JSON.stringify({ role: args.role, ...(args.data ?? {}) }),
    );
    args.parts.forEach((part, index) => {
        db.prepare(
            "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
        ).run(
            `${args.id}-p${index}`,
            args.id,
            sessionId,
            args.ts + index,
            args.ts + index,
            JSON.stringify(part),
        );
    });
}

describe("OpenCodeRetrospectiveRawProvider", () => {
    it("enumerates OpenCode sessions for the project", () => {
        const contextDb = setupContextDb();
        contextDb
            .prepare(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("s1", "opencode", "project-a", 20);
        contextDb
            .prepare(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("s2", "pi", "project-a", 30);
        contextDb
            .prepare(
                "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
            )
            .run("s3", "opencode", "project-b", 40);

        const provider = new OpenCodeRetrospectiveRawProvider({
            contextDb,
            openOpenCodeDb: () => null,
        });

        expect(provider.listProjectSessions("project-a")).toEqual([
            { sessionId: "s1", updatedAt: 20 },
        ]);
    });

    it("reads messages newer than since and excludes synthetic user text", () => {
        const contextDb = setupContextDb();
        const opencodeDb = setupOpenCodeDb();
        insertMessage(opencodeDb, {
            id: "old",
            ts: 100,
            role: "user",
            parts: [{ type: "text", text: "old typed text" }],
        });
        insertMessage(opencodeDb, {
            id: "new-user",
            ts: 200,
            role: "user",
            parts: [{ type: "text", text: "Please fix the retrospective scanner." }],
        });
        insertMessage(opencodeDb, {
            id: "synthetic-user",
            ts: 210,
            role: "user",
            parts: [{ type: "text", text: "system nudge", synthetic: true }],
        });
        insertMessage(opencodeDb, {
            id: "assistant-tool",
            ts: 220,
            role: "assistant",
            parts: [
                { type: "text", text: "I will inspect it." },
                { type: "tool", tool: "bash", state: { output: "Error: nope" } },
            ],
        });

        const provider = new OpenCodeRetrospectiveRawProvider({ contextDb, opencodeDb });

        expect(provider.readUserMessagesSince("s1", 150, 10)).toEqual([
            {
                sessionId: "s1",
                ordinal: 1,
                role: "user",
                text: "Please fix the retrospective scanner.",
                ts: 200,
            },
            {
                sessionId: "s1",
                ordinal: 3,
                role: "assistant",
                text: "I will inspect it.",
                ts: 220,
            },
            {
                sessionId: "s1",
                ordinal: 3,
                role: "tool",
                text: "Error: nope",
                toolName: "bash",
                isError: true,
                ts: 220,
            },
        ]);
    });

    it("degrades gracefully when opencode.db is absent", () => {
        const contextDb = setupContextDb();
        const provider = new OpenCodeRetrospectiveRawProvider({
            contextDb,
            openOpenCodeDb: () => null,
        });

        expect(provider.readUserMessagesSince("missing", 0, 10)).toEqual([]);
    });
});
