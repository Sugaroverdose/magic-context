/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import {
    closeDatabase,
    getPersistedTodoBlock,
    openDatabase,
    setPersistedTodoBlock,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import { stripTagPrefix } from "./tag-content-primitives";
import { createNudgePlacementStore, createTransform } from "./transform";

type TestMessage = {
    info: { id: string; role: string; sessionID?: string };
    parts: Array<{ type: "text"; text: string }>;
};

const TODO_BLOCK =
    "\n\n<current-todos>\n- [in_progress] Implement todo synthesis\n- [pending] Review tests\n</current-todos>";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function firstText(message: TestMessage): string {
    return stripTagPrefix(message.parts[0]?.text ?? "");
}

function makeMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "user prompt" }],
        },
        {
            info: { id: "m-assistant", role: "assistant" },
            parts: [{ type: "text", text: "assistant response" }],
        },
    ];
}

function makeTwoTurnMessages(): TestMessage[] {
    return [
        {
            info: { id: "m-user-1", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "first user prompt" }],
        },
        {
            info: { id: "m-assistant-1", role: "assistant" },
            parts: [{ type: "text", text: "assistant response" }],
        },
        {
            info: { id: "m-user-2", role: "user", sessionID: "ses-1" },
            parts: [{ type: "text", text: "second user prompt" }],
        },
    ];
}

function createTodoTransform(scheduler: Scheduler) {
    const db = openDatabase();
    const transform = createTransform({
        tagger: createTagger(),
        scheduler,
        contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
            ["ses-1", { usage: { percentage: 41, inputTokens: 80_000 }, updatedAt: Date.now() }],
        ]),
        nudger: () => null,
        db,
        nudgePlacements: createNudgePlacementStore(db),
        historyRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        clearReasoningAge: 50,
        protectedTags: 0,
        autoDropToolAge: 1000,
    });
    return { db, transform };
}

describe("todo state synthesis transform", () => {
    it("appends rendered todo block on cache-busting execute pass", async () => {
        useTempDataHome("context-transform-todo-execute-");
        const { db, transform } = createTodoTransform({ shouldExecute: mock(() => "execute") });
        updateSessionMeta(db, "ses-1", {
            lastTodoState: JSON.stringify([
                { content: "Implement todo synthesis", status: "in_progress", priority: "high" },
                { content: "Review tests", status: "pending", priority: "medium" },
            ]),
        });
        const messages = makeMessages();

        await transform({}, { messages });

        expect(firstText(messages[0]!)).toBe(`user prompt${TODO_BLOCK}`);
        expect(getPersistedTodoBlock(db, "ses-1")).toEqual({
            text: TODO_BLOCK,
            messageId: "m-user",
        });
    });

    it("replays persisted todo block byte-identically on defer pass", async () => {
        useTempDataHome("context-transform-todo-defer-");
        const { db, transform } = createTodoTransform({ shouldExecute: mock(() => "defer") });
        setPersistedTodoBlock(db, "ses-1", TODO_BLOCK, "m-user");
        const messages = makeMessages();

        await transform({}, { messages });

        expect(firstText(messages[0]!)).toBe(`user prompt${TODO_BLOCK}`);
        expect(getPersistedTodoBlock(db, "ses-1")).toEqual({
            text: TODO_BLOCK,
            messageId: "m-user",
        });
    });

    it("re-renders and re-anchors when todo state changes on execute pass", async () => {
        useTempDataHome("context-transform-todo-state-change-");
        const { db, transform } = createTodoTransform({ shouldExecute: mock(() => "execute") });
        setPersistedTodoBlock(
            db,
            "ses-1",
            "\n\n<current-todos>\n- [pending] Old\n</current-todos>",
            "m-user-1",
        );
        updateSessionMeta(db, "ses-1", {
            lastTodoState: JSON.stringify([
                { content: "New", status: "pending", priority: "high" },
            ]),
        });
        const messages = makeTwoTurnMessages();

        await transform({}, { messages });

        expect(firstText(messages[0]!)).not.toContain("<current-todos>");
        expect(firstText(messages[2]!)).toBe(
            "second user prompt\n\n<current-todos>\n- [pending] New\n</current-todos>",
        );
        expect(getPersistedTodoBlock(db, "ses-1")?.messageId).toBe("m-user-2");
    });

    it("keeps unchanged todo block anchored to the original user message", async () => {
        useTempDataHome("context-transform-todo-anchor-stable-");
        const { db, transform } = createTodoTransform({ shouldExecute: mock(() => "execute") });
        setPersistedTodoBlock(db, "ses-1", TODO_BLOCK, "m-user-1");
        updateSessionMeta(db, "ses-1", {
            lastTodoState: JSON.stringify([
                { content: "Implement todo synthesis", status: "in_progress", priority: "high" },
                { content: "Review tests", status: "pending", priority: "medium" },
            ]),
        });
        const messages = makeTwoTurnMessages();

        await transform({}, { messages });

        expect(firstText(messages[0]!)).toBe(`first user prompt${TODO_BLOCK}`);
        expect(firstText(messages[2]!)).toBe("second user prompt");
        expect(getPersistedTodoBlock(db, "ses-1")).toEqual({
            text: TODO_BLOCK,
            messageId: "m-user-1",
        });
    });

    it("clears sticky todo block when current state is empty", async () => {
        useTempDataHome("context-transform-todo-clear-");
        const { db, transform } = createTodoTransform({ shouldExecute: mock(() => "execute") });
        setPersistedTodoBlock(db, "ses-1", TODO_BLOCK, "m-user");
        updateSessionMeta(db, "ses-1", {
            lastTodoState: JSON.stringify([
                { content: "Done", status: "completed", priority: "high" },
            ]),
        });
        const messages = makeMessages();

        await transform({}, { messages });

        expect(firstText(messages[0]!)).toBe("user prompt");
        expect(getPersistedTodoBlock(db, "ses-1")).toBeNull();
    });

    it("skips todo synthesis for subagent sessions", async () => {
        useTempDataHome("context-transform-todo-subagent-");
        const { db, transform } = createTodoTransform({ shouldExecute: mock(() => "execute") });
        updateSessionMeta(db, "ses-1", {
            isSubagent: true,
            lastTodoState: JSON.stringify([
                { content: "Subagent work", status: "pending", priority: "high" },
            ]),
        });
        const messages = makeMessages();

        await transform({}, { messages });

        expect(firstText(messages[0]!)).toBe("user prompt");
        expect(getPersistedTodoBlock(db, "ses-1")).toBeNull();
    });
});
