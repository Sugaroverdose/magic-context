import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AsyncProcessInspection } from "@magic-context/core/shared/rpc-utils";
import { Database } from "@magic-context/core/shared/sqlite";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import {
    assertHiddenChildStoresClosed,
    cleanupRetiredHiddenChildren,
} from "./doctor-hidden-children";

/**
 * OpenCode 1's own session tables, as OpenCode 2 leaves them behind after converting an
 * OpenCode 1 store in place (it copies their rows into `session_v2` and `session_message`).
 */
const OPENCODE1_TABLES = `CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES message(id) ON DELETE CASCADE, session_id TEXT NOT NULL, data TEXT NOT NULL);
    INSERT INTO session (id, directory) VALUES ('v1-session', '/fixture');
    INSERT INTO message (id, session_id, data) VALUES ('v1-message', 'v1-session', '{}');
    INSERT INTO part (id, message_id, session_id, data) VALUES ('v1-part', 'v1-message', 'v1-session', '{}');`;

function fixture(options: { upgradedFromOpenCode1?: boolean } = {}) {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-hidden-"));
    const hostDbPath = join(dir, "opencode2.db");
    const contextDbPath = join(dir, "context.db");
    const host = new Database(hostDbPath);
    const context = new Database(contextDbPath);
    if (options.upgradedFromOpenCode1) host.exec(OPENCODE1_TABLES);
    host.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, metadata TEXT);
        CREATE TABLE instruction_entry (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE instruction_state (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE session_inbox (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE session_message (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);
        CREATE TABLE session_pending (session_id TEXT REFERENCES session_v2(id) ON DELETE CASCADE);`);
    context.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const [id, metadata] of [
        ["listed-hidden", '{"magic_context":"hidden-run"}'],
        ["listed-user", "{}"],
        ["unlisted-hidden", '{"magic_context":"hidden-run"}'],
    ]) {
        host.prepare(
            "INSERT INTO session_v2 (id, directory, metadata) VALUES (?, '/fixture', ?)",
        ).run(id, metadata);
        host.prepare("INSERT INTO session_message (session_id) VALUES (?)").run(id);
    }
    context.prepare("INSERT INTO schema_migrations_meta (key, value) VALUES (?, ?)").run(
        "opencode2_hidden_children:/fixture",
        JSON.stringify({
            version: 1,
            active: {},
            retired_children: [
                { id: "listed-hidden", reason: "failed" },
                { id: "listed-user", reason: "failed" },
            ],
        }),
    );
    host.close();
    context.close();
    return {
        hostDbPath,
        contextDbPath,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}

test("doctor only deletes marked sessions listed as retired, with a backup and cascaded messages", async () => {
    const files = fixture();
    const options = { ...files, inspectHolders: () => {}, fix: true };
    const reports: string[] = [];
    try {
        expect(
            await cleanupRetiredHiddenChildren({
                ...options,
                fix: false,
                report: (line) => reports.push(line),
            }),
        ).toMatchObject({
            waiting: 2,
            deleted: 0,
        });
        expect(reports).toEqual([
            expect.stringContaining("2 retired hidden sessions are waiting for deletion"),
        ]);
        // The cleanup is for older hosts only, and the report says so.
        expect(reports[0]).toContain(
            "newer hosts that let plugins remove sessions clean up hidden runs on their own",
        );
        const result = await cleanupRetiredHiddenChildren(options);
        expect(result).toMatchObject({ waiting: 2, deleted: 1 });
        expect(existsSync(result.backup!)).toBe(true);
        const host = new Database(files.hostDbPath, { readonly: true });
        const context = new Database(files.contextDbPath, { readonly: true });
        try {
            expect(
                (
                    host.prepare("SELECT id FROM session_v2 ORDER BY id").all() as Array<{
                        id: string;
                    }>
                ).map((row) => row.id),
            ).toEqual(["listed-user", "unlisted-hidden"]);
            expect(
                (
                    host
                        .prepare("SELECT session_id FROM session_message ORDER BY session_id")
                        .all() as Array<{ session_id: string }>
                ).map((row) => row.session_id),
            ).toEqual(["listed-user", "unlisted-hidden"]);
            const state = JSON.parse(
                (
                    context.prepare("SELECT value FROM schema_migrations_meta").get() as {
                        value: string;
                    }
                ).value,
            );
            expect(state.retired_children.map((row: { id: string }) => row.id)).toEqual([
                "listed-user",
            ]);
        } finally {
            host.close();
            context.close();
        }
    } finally {
        files.cleanup();
    }
});

test("doctor cleans up a store OpenCode 2 converted from OpenCode 1 in place, leaving the old tables alone", async () => {
    const files = fixture({ upgradedFromOpenCode1: true });
    try {
        const result = await cleanupRetiredHiddenChildren({
            ...files,
            fix: true,
            inspectHolders: () => {},
        });
        expect(result).toMatchObject({ waiting: 2, deleted: 1 });
        const host = new Database(files.hostDbPath, { readonly: true });
        try {
            expect(
                (
                    host.prepare("SELECT id FROM session_v2 ORDER BY id").all() as Array<{
                        id: string;
                    }>
                ).map((row) => row.id),
            ).toEqual(["listed-user", "unlisted-hidden"]);
            for (const table of ["session", "message", "part"]) {
                expect(host.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
                    count: 1,
                });
            }
        } finally {
            host.close();
        }
    } finally {
        files.cleanup();
    }
});

test("doctor still refuses an OpenCode 1 store that has no session_v2 schema", async () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-doctor-hidden-v1-"));
    const hostDbPath = join(dir, "opencode.db");
    const contextDbPath = join(dir, "context.db");
    const host = new Database(hostDbPath);
    host.exec(OPENCODE1_TABLES);
    host.close();
    const context = new Database(contextDbPath);
    context.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    context.close();
    try {
        await expect(
            cleanupRetiredHiddenChildren({ hostDbPath, contextDbPath, inspectHolders: () => {} }),
        ).rejects.toThrow("OpenCode store is not the verified OpenCode 2 session_v2 schema");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("doctor refuses a live holder before backup or any mutation", async () => {
    const files = fixture();
    try {
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                inspectHolders: () => {
                    throw new Error("holder is present");
                },
            }),
        ).rejects.toThrow("holder is present");
        const host = new Database(files.hostDbPath, { readonly: true });
        try {
            expect(host.prepare("SELECT COUNT(*) AS count FROM session_v2").get()).toEqual({
                count: 3,
            });
        } finally {
            host.close();
        }
    } finally {
        files.cleanup();
    }
});

test("the default holder inspection refuses an open fixture database", async () => {
    const files = fixture();
    const held = new Database(files.hostDbPath);
    try {
        await expect(
            assertHiddenChildStoresClosed(files.contextDbPath, files.hostDbPath),
        ).rejects.toThrow("database holder");
    } finally {
        held.close();
        files.cleanup();
    }
}, 30_000);

test("doctor refuses an unknown cascade schema", async () => {
    const files = fixture();
    try {
        const host = new Database(files.hostDbPath);
        host.exec("DROP TABLE session_pending");
        host.close();
        await expect(
            cleanupRetiredHiddenChildren({ ...files, fix: true, inspectHolders: () => {} }),
        ).rejects.toThrow("cascade schema differs");
    } finally {
        files.cleanup();
    }
});

function windowsProbe(
    facts: Array<{ pid: number; imageName: string | null; commandLine: string | null }> = [],
): Promise<AsyncProcessInspection> {
    return Promise.resolve({
        pi: { state: "known", processIds: [] },
        processSnapshot: { source: "cim", facts },
        evidence: () => ({ startTime: null, commandLine: null }),
        liveness: () => "dead",
    });
}

test("Windows doctor refuses a running OpenCode process before backup", async () => {
    const files = fixture();
    try {
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: () =>
                    windowsProbe([
                        { pid: 1234, imageName: "opencode.exe", commandLine: "opencode serve" },
                    ]),
            }),
        ).rejects.toThrow("PID 1234");
        expect(existsSync(`${files.hostDbPath}.hidden-child-backup`)).toBe(false);
    } finally {
        files.cleanup();
    }
});

test("Windows doctor refuses an unreadable or image-only process snapshot", async () => {
    const files = fixture();
    try {
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: async () => ({
                    ...(await windowsProbe()),
                    processSnapshot: { source: "tasklist", facts: [] },
                }),
            }),
        ).rejects.toThrow("could not rule out");
        await expect(
            cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: async () => {
                    throw new Error("CIM denied");
                },
            }),
        ).rejects.toThrow("CIM denied");
    } finally {
        files.cleanup();
    }
});

test("Windows doctor refuses either held database lock and repairs once both are clear", async () => {
    const files = fixture();
    let held: Database | undefined;
    try {
        for (const path of [files.hostDbPath, files.contextDbPath]) {
            let scans = 0;
            await expect(
                cleanupRetiredHiddenChildren({
                    ...files,
                    fix: true,
                    platform: "win32",
                    processProbe: () => {
                        if (++scans === 2) {
                            held = new Database(path);
                            held.exec("BEGIN EXCLUSIVE");
                        }
                        return windowsProbe();
                    },
                }),
            ).rejects.toThrow("Cannot acquire exclusive locks");
            held?.exec("ROLLBACK");
            held?.close();
            held = undefined;
            // Backup names use millisecond timestamps; separate successive repair attempts.
            await Bun.sleep(2);
            const host = new Database(files.hostDbPath, { readonly: true });
            try {
                expect(host.prepare("SELECT COUNT(*) AS count FROM session_v2").get()).toEqual({
                    count: 3,
                });
            } finally {
                host.close();
            }
        }
        expect(
            await cleanupRetiredHiddenChildren({
                ...files,
                fix: true,
                platform: "win32",
                processProbe: windowsProbe,
            }),
        ).toMatchObject({ waiting: 2, deleted: 1 });
    } finally {
        if (held) {
            held.exec("ROLLBACK");
            held.close();
        }
        files.cleanup();
    }
});
