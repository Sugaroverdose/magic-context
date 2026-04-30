import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../shared/sqlite";
import {
    migrateOpenCodeSessionToPi,
    parseMigrateArgs,
    projectPathToPiDirSlug,
    runMigrateCli,
} from "./migrate";

const tempDirs: string[] = [];
const databases: Array<{ close(): void }> = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-migrate-test-"));
    tempDirs.push(dir);
    return dir;
}

function makeDb() {
    const db = new Database(":memory:");
    databases.push(db);
    db.exec(`
        CREATE TABLE session (
            id text PRIMARY KEY,
            title text NOT NULL,
            directory text NOT NULL,
            path text,
            time_created integer NOT NULL
        );
        CREATE TABLE message (
            id text PRIMARY KEY,
            session_id text NOT NULL,
            time_created integer NOT NULL,
            data text NOT NULL
        );
        CREATE TABLE part (
            id text PRIMARY KEY,
            message_id text NOT NULL,
            session_id text NOT NULL,
            time_created integer NOT NULL,
            data text NOT NULL
        );
    `);
    return db;
}

function insertSyntheticSession(db: ReturnType<typeof makeDb>) {
    const sessionId = "ses_test";
    const cwd = "/tmp/migrate-project";
    db.prepare(
        "INSERT INTO session (id, title, directory, path, time_created) VALUES (?, ?, ?, ?, ?)",
    ).run(sessionId, "Test", cwd, null, 1000);

    const insertMessage = db.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    const insertPart = db.prepare(
        "INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)",
    );

    insertMessage.run(
        "msg_1",
        sessionId,
        1000,
        JSON.stringify({
            role: "user",
            model: { providerID: "anthropic", modelID: "claude-opus" },
        }),
    );
    insertPart.run(
        "prt_1",
        "msg_1",
        sessionId,
        1000,
        JSON.stringify({ type: "text", text: "hello" }),
    );
    insertPart.run("prt_2", "msg_1", sessionId, 1001, JSON.stringify({ type: "step-start" }));
    insertPart.run(
        "prt_3",
        "msg_1",
        sessionId,
        1002,
        JSON.stringify({ type: "file", filename: "image.png", url: "data:image/png;base64,abc" }),
    );
    insertPart.run("prt_4", "msg_1", sessionId, 1003, JSON.stringify({ type: "step-finish" }));

    insertMessage.run(
        "msg_2",
        sessionId,
        2000,
        JSON.stringify({ role: "assistant", providerID: "anthropic", modelID: "claude-opus" }),
    );
    insertPart.run(
        "prt_5",
        "msg_2",
        sessionId,
        2000,
        JSON.stringify({
            type: "reasoning",
            text: "thinking text",
            metadata: { anthropic: { signature: "signed-thinking" } },
        }),
    );
    insertPart.run(
        "prt_6",
        "msg_2",
        sessionId,
        2001,
        JSON.stringify({ type: "text", text: "assistant answer" }),
    );
    insertPart.run(
        "prt_7",
        "msg_2",
        sessionId,
        2002,
        JSON.stringify({
            type: "tool",
            tool: "bash",
            callID: "call_1",
            state: { input: { command: "echo hi" }, output: "hi\n" },
        }),
    );

    insertMessage.run("msg_3", sessionId, 3000, JSON.stringify({ role: "user" }));
    insertPart.run(
        "prt_8",
        "msg_3",
        sessionId,
        3000,
        JSON.stringify({ type: "text", text: "next" }),
    );

    return { sessionId, cwd };
}

function readJsonl(path: string) {
    return readFileSync(path, "utf-8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
}

afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("migrateOpenCodeSessionToPi", () => {
    it("converts text, reasoning, tools, skips steps, and marks files", () => {
        const db = makeDb();
        const { sessionId, cwd } = insertSyntheticSession(db);
        const root = tempDir();

        const result = migrateOpenCodeSessionToPi({
            db,
            sessionId,
            piSessionsRoot: root,
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        expect(projectPathToPiDirSlug("/Users/ufukaltinok/Work/OSS/opencode-magic-context")).toBe(
            "--Users-ufukaltinok-Work-OSS-opencode-magic-context--",
        );
        expect(result.outputPath).toContain(projectPathToPiDirSlug(cwd));
        expect(result.sourceMessageCount).toBe(3);
        const entries = readJsonl(result.outputPath);
        expect(entries[0]).toMatchObject({ type: "session", version: 3, cwd });
        expect(entries[1]).toMatchObject({
            type: "model_change",
            provider: "anthropic",
            modelId: "claude-opus",
        });
        expect(entries[2].message.content[0].text).toContain(
            "migrated from OpenCode session ses_test",
        );

        const messages = entries.slice(2).map((entry) => entry.message);
        expect(messages.map((message) => message.role)).toEqual([
            "user",
            "user",
            "user",
            "assistant",
            "assistant",
            "assistant",
            "toolResult",
            "user",
        ]);
        expect(
            messages.map((message) => message.content?.[0]?.text ?? message.content?.[0]?.thinking),
        ).toContain("<file omitted: image.png>");
        const thinking = messages.find((message) => message.content?.[0]?.type === "thinking");
        expect(thinking.content[0].thinking).toBe("thinking text");
        expect(thinking.content[0].thinkingSignature).toBeNull();
        expect(JSON.stringify(entries)).not.toContain("signed-thinking");

        const toolCall = messages.find((message) => message.content?.[0]?.type === "toolCall");
        expect(toolCall.content[0]).toEqual({
            type: "toolCall",
            id: "call_1",
            name: "bash",
            arguments: { command: "echo hi" },
        });
        const toolResult = messages.find((message) => message.role === "toolResult");
        expect(toolResult.toolCallId).toBe("call_1");
        expect(toolResult.content[0].text).toBe("hi\n");
        expect(JSON.stringify(entries)).not.toContain("step-start");
        expect(JSON.stringify(entries)).not.toContain("step-finish");
    });

    it("limits to the most recent N source messages in chronological order", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const result = migrateOpenCodeSessionToPi({
            db,
            sessionId,
            piSessionsRoot: tempDir(),
            maxMessages: 2,
            now: new Date("2026-04-30T11:46:47.422Z"),
        });

        const entries = readJsonl(result.outputPath);
        const texts = entries
            .slice(2)
            .flatMap((entry) => entry.message.content ?? [])
            .map((content) => content.text ?? content.thinking)
            .filter(Boolean);
        expect(texts).not.toContain("hello");
        expect(texts).toContain("assistant answer");
        expect(texts.at(-1)).toBe("next");
    });

    it("dry-run reports bytes but writes nothing", () => {
        const db = makeDb();
        const { sessionId } = insertSyntheticSession(db);
        const root = tempDir();
        const writes: string[] = [];
        const result = migrateOpenCodeSessionToPi({
            db,
            sessionId,
            piSessionsRoot: root,
            dryRun: true,
            now: new Date("2026-04-30T11:46:47.422Z"),
            fs: {
                existsSync: () => false,
                mkdirSync: () => {
                    throw new Error("mkdir should not be called");
                },
                writeFileSync: (path) => {
                    writes.push(path);
                },
            },
        });

        expect(result.dryRun).toBe(true);
        expect(result.byteCount).toBeGreaterThan(0);
        expect(writes).toEqual([]);
    });
});

describe("migrate CLI parsing", () => {
    it("parses required flags", () => {
        expect(
            parseMigrateArgs([
                "--from",
                "opencode",
                "--to",
                "pi",
                "--session",
                "ses_x",
                "--max-messages",
                "5",
                "--dry-run",
            ]),
        ).toEqual({ from: "opencode", to: "pi", session: "ses_x", maxMessages: 5, dryRun: true });
    });

    it("rejects unsupported migration directions clearly", async () => {
        const originalError = console.error;
        const errors: string[] = [];
        console.error = (message?: unknown) => {
            errors.push(String(message));
        };
        try {
            const code = await runMigrateCli([
                "--from",
                "pi",
                "--to",
                "opencode",
                "--session",
                "ses_x",
            ]);
            expect(code).toBe(1);
            expect(errors.join("\n")).toContain("pi → opencode is not yet supported");
        } finally {
            console.error = originalError;
        }
    });
});
