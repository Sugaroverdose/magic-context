/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    getTagsBySession,
    openDatabase,
    updateSessionMeta,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { getDatabasePath } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { createMessagesTransformHandler } from "../../plugin/messages-transform";
import type { PluginContext } from "../../plugin/types";
import { Database } from "../../shared/sqlite";
import { DegradedPassRefusalError } from "./degraded-pass-refusal";
import { dropSlot, getSlot, resetLkgSlotsForTest } from "./lkg-slot";
import { STORAGE_BUSY_MESSAGE } from "./storage-busy-refusal";
import { createTransform } from "./transform";
import * as transformOperations from "./transform-operations";

type Message = { info: Record<string, unknown>; parts: Array<Record<string, unknown>> };
type Output = Parameters<ReturnType<typeof createMessagesTransformHandler>>[1];

const BULKY = "BULKY-TOOL-OUTPUT const value = compute(input, options); // line\n".repeat(600);

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
let heldLock: Database | null = null;

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function releaseLock(): void {
    if (!heldLock) return;
    try {
        heldLock.exec("ROLLBACK");
    } finally {
        heldLock.close();
        heldLock = null;
    }
}

afterEach(() => {
    releaseLock();
    resetLkgSlotsForTest();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function history(sessionId: string): Message[] {
    return [
        {
            info: { id: "u1", time: { created: 1 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "read the file" }],
        },
        {
            info: {
                id: "a1",
                time: { created: 2 },
                role: "assistant",
                sessionID: sessionId,
                finish: "tool-calls",
            },
            parts: [
                {
                    type: "tool",
                    callID: "call-1",
                    tool: "read",
                    state: { status: "completed", input: { path: "a.ts" }, output: BULKY },
                },
            ],
        },
        {
            info: { id: "u2", time: { created: 3 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "thanks" }],
        },
        {
            info: {
                id: "a2",
                time: { created: 4 },
                role: "assistant",
                sessionID: sessionId,
                finish: "stop",
            },
            parts: [{ type: "text", text: "done" }],
        },
        {
            info: { id: "u3", time: { created: 5 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "next question" }],
        },
    ];
}

function nextTurn(sessionId: string): Message[] {
    return [
        ...history(sessionId),
        {
            info: {
                id: "a3",
                time: { created: 6 },
                role: "assistant",
                sessionID: sessionId,
                finish: "stop",
            },
            parts: [{ type: "text", text: "answer" }],
        },
        {
            info: { id: "u4", time: { created: 7 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "follow-up" }],
        },
    ];
}

/**
 * A real database session whose tool output is a persisted drop, served once
 * healthy so the last-good request exists. `lockDuringTagging` makes the next
 * tagging step find the writer lock held by a second connection, released when
 * the transform resets the tagger, i.e. exactly across the tagging step.
 */
async function sessionWithPersistedDrop(sessionId: string) {
    useTempDataHome("mc-degraded-pass-");
    const db = openDatabase();
    let lockDuringTagging = false;
    const baseTagger = createTagger();
    const tagger = {
        ...baseTagger,
        initFromDb: (...args: Parameters<typeof baseTagger.initFromDb>) => {
            if (lockDuringTagging) {
                lockDuringTagging = false;
                const path = getDatabasePath(db);
                if (!path) throw new Error("test database has no file path");
                heldLock = new Database(path);
                heldLock.exec("BEGIN IMMEDIATE");
            }
            return baseTagger.initFromDb(...args);
        },
        cleanup: (id: string) => {
            releaseLock();
            baseTagger.cleanup(id);
        },
    };
    const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
    const transform = createTransform({
        tagger,
        scheduler,
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
            [sessionId, { usage: { percentage: 40, inputTokens: 80_000 }, updatedAt: Date.now() }],
        ]),
        db,
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTokens: 0,
        historianRunnable: false,
    });
    const handler = createMessagesTransformHandler({
        magicContext: { "experimental.chat.messages.transform": transform },
    });
    const serve = async (messages: Message[]) => {
        const output = { messages } as unknown as Output;
        await handler({}, output);
        return output.messages as unknown as Message[];
    };

    // First pass tags the conversation; the tool output is then dropped the
    // way a flushed ctx_reduce leaves it.
    await serve(history(sessionId));
    const toolTag = getTagsBySession(db, sessionId).find((tag) => tag.type === "tool");
    if (!toolTag) throw new Error("the first pass did not tag the tool output");
    updateTagStatus(db, sessionId, toolTag.tagNumber, "dropped");

    // A healthy defer pass replays the drop; it is the last good request.
    const managed = JSON.stringify(await serve(history(sessionId)));
    expect(managed).not.toContain("BULKY-TOOL-OUTPUT");
    expect(getSlot(sessionId)).toBeDefined();

    return {
        db,
        managed,
        serve,
        armLockDuringTagging: () => {
            lockDuringTagging = true;
        },
    };
}

function expectReplayOfManaged(served: Message[], managed: string, sessionId: string): void {
    const previous = JSON.parse(managed) as Message[];
    const json = JSON.stringify(served);
    expect(json).not.toContain("BULKY-TOOL-OUTPUT");
    // Byte-identical to the previous request, plus the new turn as it arrived.
    expect(JSON.stringify(served.slice(0, previous.length))).toBe(managed);
    expect(JSON.stringify(served.slice(previous.length))).toBe(
        JSON.stringify(nextTurn(sessionId).slice(history(sessionId).length)),
    );
}

describe("a degraded transform pass is never served", () => {
    it("replays the last good request when the writer lock is held across tagging", async () => {
        const sessionId = "ses-degraded-tagging-busy";
        const session = await sessionWithPersistedDrop(sessionId);

        session.armLockDuringTagging();
        const served = await session.serve(nextTurn(sessionId));

        expect(heldLock).toBeNull();
        expectReplayOfManaged(served, session.managed, sessionId);
    }, 30_000);

    it("refuses with the storage-busy refusal when the lock is held across tagging and no last good request exists", async () => {
        const sessionId = "ses-degraded-tagging-busy-refusal";
        const session = await sessionWithPersistedDrop(sessionId);
        dropSlot(sessionId);

        session.armLockDuringTagging();
        const messages = nextTurn(sessionId);
        await expect(session.serve(messages)).rejects.toThrow(STORAGE_BUSY_MESSAGE);
    }, 30_000);

    it("replays the last good request when the persisted drop replay fails", async () => {
        const sessionId = "ses-degraded-flushed";
        const session = await sessionWithPersistedDrop(sessionId);

        const replay = spyOn(transformOperations, "applyFlushedStatuses").mockImplementationOnce(
            () => {
                throw new Error("flushed status replay failed");
            },
        );
        try {
            const served = await session.serve(nextTurn(sessionId));
            expect(replay).toHaveBeenCalledTimes(1);
            expectReplayOfManaged(served, session.managed, sessionId);
        } finally {
            replay.mockRestore();
        }
    }, 30_000);

    it("refuses when the persisted drop replay fails and no last good request exists", async () => {
        const sessionId = "ses-degraded-flushed-refusal";
        const session = await sessionWithPersistedDrop(sessionId);
        dropSlot(sessionId);

        const replay = spyOn(transformOperations, "applyFlushedStatuses").mockImplementationOnce(
            () => {
                throw new Error("flushed status replay failed");
            },
        );
        try {
            await expect(session.serve(nextTurn(sessionId))).rejects.toMatchObject({
                name: "DegradedPassRefusalError",
                site: "flushed-status-failure",
            });
        } finally {
            replay.mockRestore();
        }
    }, 30_000);
});

describe("a pass that falls back to the launch directory", () => {
    function directoryClient(resolve: () => string | undefined) {
        return {
            session: {
                get: mock(async () => {
                    const directory = resolve();
                    return { data: directory ? { directory } : {} };
                }),
                create: mock(async () => ({ data: { id: "unused" } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({ data: [] })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
    }

    function m0m1(messages: Message[]): string {
        return JSON.stringify(messages.filter((message) => message.info.syntheticHead === true));
    }

    it("replays the frozen m[0]/m[1] when it would otherwise rebuild, and a resolved pass rebuilds", async () => {
        useTempDataHome("mc-degraded-directory-");
        const sessionDirectory = mkdtempSync(join(tmpdir(), "mc-session-dir-"));
        const launchDirectory = mkdtempSync(join(tmpdir(), "mc-launch-dir-"));
        tempDirs.push(sessionDirectory, launchDirectory);
        const sessionId = "ses-directory-fallback";
        const db = openDatabase();
        let hostDirectory: string | undefined = sessionDirectory;
        const pendingMaterializationSessions = new Set<string>();
        const transform = createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 30, inputTokens: 60_000 }, updatedAt: Date.now() },
                ],
            ]),
            db,
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions,
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            client: directoryClient(() => hostDirectory),
            directory: launchDirectory,
        });
        const pass = async () => {
            const messages = history(sessionId);
            await transform({}, { messages });
            return messages;
        };

        // Resolved first render freezes an m[0]/m[1] pair for the session's
        // own directory.
        const first = await pass();
        const frozen = m0m1(first);
        expect(frozen).not.toBe("[]");
        const frozenSystemHash = getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash ?? "";

        // A system prompt change and an explicit flush both ask for a rebuild.
        updateSessionMeta(db, sessionId, { systemPromptHash: "system-after-change" });
        pendingMaterializationSessions.add(sessionId);

        // The host lookup fails: the launch directory is another project.
        hostDirectory = undefined;
        const fallback = await pass();
        expect(m0m1(fallback)).toBe(frozen);
        expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash ?? "").toBe(
            frozenSystemHash,
        );
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);

        // The next resolved pass does the rebuild it was due.
        hostDirectory = sessionDirectory;
        await pass();
        expect(getOrCreateSessionMeta(db, sessionId).cachedM0SystemHash).toBe(
            "system-after-change",
        );
        expect(pendingMaterializationSessions.has(sessionId)).toBe(false);
    }, 30_000);
});

describe("the served-request size guard", () => {
    // 1,000 input tokens at 50% puts the window at 2,000 tokens; the user
    // message alone is far larger.
    const oversized = (sessionId: string): Message[] => [
        {
            info: { id: "u1", time: { created: 1 }, role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: BULKY }],
        },
    ];

    function smallWindowTransform(sessionId: string, client?: PluginContext["client"]) {
        useTempDataHome("mc-degraded-size-guard-");
        return createTransform({
            tagger: createTagger(),
            scheduler: { shouldExecute: mock(() => "defer" as const) },
            contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                [
                    sessionId,
                    { usage: { percentage: 50, inputTokens: 1_000 }, updatedAt: Date.now() },
                ],
            ]),
            db: openDatabase(),
            historyRefreshSessions: new Set<string>(),
            pendingMaterializationSessions: new Set<string>(),
            lastHeuristicsTurnId: new Map<string, string>(),
            clearReasoningAge: 50,
            protectedTokens: 0,
            historianRunnable: false,
            ...(client ? { client } : {}),
        });
    }

    it("refuses a degraded pass whose request is over the context limit", async () => {
        const sessionId = "ses-size-guard-degraded";
        // The host returns no directory: a degradation that is served when it fits.
        const client = {
            session: { get: mock(async () => ({ data: {} })) },
        } as unknown as PluginContext["client"];
        const transform = smallWindowTransform(sessionId, client);
        await expect(transform({}, { messages: oversized(sessionId) })).rejects.toMatchObject({
            name: "DegradedPassRefusalError",
            site: "served-request-over-limit",
            contextLimitTokens: 2_000,
        });
    }, 30_000);

    it("leaves a healthy pass of the same size to the existing emergency machinery", async () => {
        const sessionId = "ses-size-guard-healthy";
        const transform = smallWindowTransform(sessionId);
        const messages = oversized(sessionId);
        await transform({}, { messages });
        expect(JSON.stringify(messages)).toContain("BULKY-TOOL-OUTPUT");
    }, 30_000);
});

describe("DegradedPassRefusalError", () => {
    it("names its site and keeps the user-facing code", () => {
        const error = new DegradedPassRefusalError("tagging-persistence-failure");
        expect(error.site).toBe("tagging-persistence-failure");
        expect(error.message).toContain("MC-S06");
    });
});
