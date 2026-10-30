/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getMaxTagNumberBySession,
    getPendingOps,
    getTagById,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { deriveKey, renderDropToken } from "./fpe";
import { isReleasedCarrier } from "./fpe-resolve";
import {
    applyFlushedStatuses,
    applyPendingOperations,
    type MessageLike,
    tagMessages,
} from "./transform-operations";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function padSkeletonWindow(
    db: ReturnType<typeof openDatabase> & object,
    realTagNumber: number,
): void {
    const base = Math.max(realTagNumber, getMaxTagNumberBySession(db, "ses-1"));
    for (let i = 1; i <= 20; i += 1) {
        insertTag(db, "ses-1", `call-pad-${i}`, "tool", 10, base + i);
    }
}

const sessionKey = deriveKey("ses-1");

function hasCall(messages: MessageLike[], callId: string): boolean {
    for (const message of messages) {
        for (const part of message.parts) {
            if (part === null || typeof part !== "object") continue;
            const candidate = part as Record<string, unknown>;
            if (
                (candidate.type === "tool" || candidate.type === "tool-invocation") &&
                candidate.callID === callId
            ) {
                return true;
            }
            if (candidate.type === "tool_use" && candidate.id === callId) {
                return true;
            }
            if (candidate.type === "tool_result" && candidate.tool_use_id === callId) {
                return true;
            }
        }
    }
    return false;
}

function wireBytes(messages: MessageLike[]): string {
    return JSON.stringify(messages.map((m) => m.parts.map((p) => JSON.stringify(p))));
}

/** One assistant tool pair + a later user turn so the call does not end the conversation. */
function toolFixture(
    toolName: string,
    args: Record<string, unknown>,
): { messages: MessageLike[]; callId: string } {
    const callId = "call-1";
    return {
        callId,
        messages: [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: callId, toolName, args }],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        callID: callId,
                        toolName,
                        state: { output: "result", input: args },
                    },
                ],
            },
            {
                info: { id: "m-next", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "next prompt" }],
            },
        ],
    };
}

describe("source-gated drop modes", () => {
    it("erases a stamped out-of-window bash call: absent from the wire, drop_mode=erased", () => {
        useTempDataHome("context-source-modes-stamp-bash-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("bash", { command: "ls -la" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        const didMutate = applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(didMutate).toBe(true);
        expect(hasCall(messages, "call-1")).toBe(false);
        expect(wireBytes(messages)).not.toContain(renderDropToken(toolTagId!, sessionKey));
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("erased");
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
    });

    it("erases a stamped out-of-window non-bash call too (stamps erase regardless of tool)", () => {
        useTempDataHome("context-source-modes-stamp-read-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("read", { filePath: "/tmp/x" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(false);
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("erased");
    });

    it("sweeper drops a bash call as the full carrier shape", () => {
        useTempDataHome("context-source-modes-sweep-bash-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("bash", { command: "ls -la" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        applyPendingOperations("ses-1", db, targets, new Set(), undefined, undefined, [
            { id: 0, sessionId: "ses-1", tagId: toolTagId!, operation: "drop", queuedAt: 0 },
        ]);
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(true);
        const token = renderDropToken(toolTagId!, sessionKey);
        const invocation = messages[0]?.parts[0] as Record<string, unknown>;
        // The carrier fills the first string-valued seat of the original input.
        expect(invocation.args).toEqual({ command: token });
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("full");
    });

    it("sweeper drops a non-bash call as a skeleton: real args on the wire, no token", () => {
        useTempDataHome("context-source-modes-sweep-read-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("read", { filePath: "/tmp/x" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        applyPendingOperations("ses-1", db, targets, new Set(), undefined, undefined, [
            { id: 0, sessionId: "ses-1", tagId: toolTagId!, operation: "drop", queuedAt: 0 },
        ]);
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(true);
        expect(wireBytes(messages)).not.toContain(renderDropToken(toolTagId!, sessionKey));
        const invocation = messages[0]?.parts[0] as Record<string, unknown>;
        expect(invocation.args).toEqual({ filePath: "/tmp/x" });
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("skeleton_real");
    });

    it("keeps the structural skeleton when an erased stamp would strand the conversation end", () => {
        useTempDataHome("context-source-modes-stamp-strand-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("bash", { command: "ls -la" });
        // Remove the trailing user turn: the call now ends the request, so
        // removal is structurally forbidden and the skeleton law wins.
        messages.pop();
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(true);
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).not.toBe("erased");
    });

    it("keeps the newest-window skeleton for a stamped small call (window law wins over erase)", () => {
        useTempDataHome("context-source-modes-stamp-window-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("bash", { command: "ls" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        // No padding: inside the newest-20 window.

        queuePendingOp(db, "ses-1", toolTagId!, "drop");
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(true);
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).not.toBe("erased");
    });
});

describe("carrier accept surface", () => {
    it("resolves full carriers only: erased and skeleton tags are refused by the lookup", () => {
        useTempDataHome("context-source-modes-accept-");
        const db = openDatabase();
        for (const [tagNumber, mode] of [
            [11, "full"],
            [12, "erased"],
            [13, "skeleton_real"],
        ] as const) {
            insertTag(db, "ses-1", `call-accept-${tagNumber}`, "tool", 10, tagNumber, 0, "bash");
            db.prepare(
                "UPDATE tags SET status = 'dropped' WHERE session_id = 'ses-1' AND tag_number = ?",
            ).run(tagNumber);
            db.prepare(
                "UPDATE tags SET drop_mode = ? WHERE session_id = 'ses-1' AND tag_number = ?",
            ).run(mode, tagNumber);
        }

        expect(isReleasedCarrier(db, "ses-1", 11)).toBe(true);
        expect(isReleasedCarrier(db, "ses-1", 12)).toBe(false);
        expect(isReleasedCarrier(db, "ses-1", 13)).toBe(false);
        // A token minted for a live (never dropped) tag resolves to nothing.
        insertTag(db, "ses-1", "call-accept-live", "tool", 10, 14, 0, "bash");
        expect(isReleasedCarrier(db, "ses-1", 14)).toBe(false);
    });
});

describe("compartment-originated queue rows (operation=auto_drop)", () => {
    function rawQueueCount(db: ReturnType<typeof openDatabase> & object): number {
        const row = (db.query as (sql: string) => { get?: (p: unknown) => unknown }[])(
            "SELECT COUNT(*) AS n FROM pending_ops",
        ).get?.(undefined) as { n: number } | undefined;
        return row?.n ?? -1;
    }

    it("queues as sweeper shape: auto_drop bash call becomes the full carrier, not erased", () => {
        useTempDataHome("context-source-modes-autodrop-bash-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("bash", { command: "ls -la" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "auto_drop");
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(true);
        const invocation = messages[0]?.parts[0] as Record<string, unknown>;
        expect(invocation.args).toEqual({ command: renderDropToken(toolTagId!, sessionKey) });
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("full");
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
    });

    it("queues as sweeper shape: auto_drop non-bash call becomes skeleton_real, not erased", () => {
        useTempDataHome("context-source-modes-autodrop-read-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("read", { filePath: "/tmp/x" });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "auto_drop");
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(hasCall(messages, "call-1")).toBe(true);
        const invocation = messages[0]?.parts[0] as Record<string, unknown>;
        expect(invocation.args).toEqual({ filePath: "/tmp/x" });
        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("dropped");
        expect(getTagById(db, "ses-1", toolTagId!)?.dropMode).toBe("skeleton_real");
        expect(getPendingOps(db, "ses-1")).toHaveLength(0);
    });

    it("preserves ctx_reduce receipts: auto_drop on a receipt skips the drop and consumes the row", () => {
        useTempDataHome("context-source-modes-autodrop-receipt-");
        const db = openDatabase();
        const tagger = createTagger();
        const { messages } = toolFixture("ctx_reduce", { ctx_handles: ["call-9"] });
        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();
        padSkeletonWindow(db, toolTagId!);

        queuePendingOp(db, "ses-1", toolTagId!, "auto_drop");
        expect(rawQueueCount(db)).toBe(1);
        applyPendingOperations("ses-1", db, targets, new Set());
        batch.finalize();

        expect(getTagById(db, "ses-1", toolTagId!)?.status).toBe("active");
        // The receipt keeps its bytes: original args and its report output are
        // still on the wire (drop_mode stays at the column default for a
        // never-dropped tag; the wire is the discriminator).
        expect(hasCall(messages, "call-1")).toBe(true);
        const toolPart = messages[1]?.parts[0] as Record<string, unknown>;
        expect((toolPart.state as Record<string, unknown>).output).toBe("result");
        expect(rawQueueCount(db)).toBe(0);
    });
});
