/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    insertTag,
    openDatabase,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { deriveKey, renderDropToken } from "./fpe";
import { createToolExecuteBeforeHook } from "./fpe-resolve";
import {
    createToolDropTarget,
    extractToolCallObservation,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";
import { applyFlushedStatuses, type MessageLike } from "./transform-operations";

const session = "ses-release-shapes";
const sessionKey = deriveKey(session);

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return { info: { id, role, sessionID: session }, parts };
}

// A released call mid-conversation: its result does not end the request, so
// the drop takes the `full` shape.
function fixture(): MessageLike[] {
    return [
        message("m-inv", "assistant", [
            {
                type: "tool-invocation",
                tool: "bash",
                callID: "call-shape",
                args: { command: "ls -la /tmp", limit: 5 },
            },
        ]),
        message("m-tool", "assistant", [
            {
                type: "tool",
                tool: "bash",
                callID: "call-shape",
                state: {
                    status: "completed",
                    input: { command: "ls -la /tmp", limit: 5 },
                    output: "line one\nline two\nmany lines of output",
                    attachments: [{ type: "file", mime: "text/plain", url: "data:,note" }],
                },
            },
        ]),
        message("m-next", "user", [{ type: "text", text: "next prompt" }]),
    ] as unknown as MessageLike[];
}

function buildIndex(messages: MessageLike[]): ToolCallIndex {
    const index: ToolCallIndex = new Map();
    for (const msg of messages) {
        for (const part of msg.parts) {
            const observation = extractToolCallObservation(part);
            if (observation) {
                const entry = index.get(observation.callId) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message: msg, part, kind: observation.kind });
                if (observation.kind === "result" && partHasCompletedResult(part))
                    entry.hasResult = true;
                index.set(observation.callId, entry);
            }
        }
    }
    return index;
}

describe("tool release shape table", () => {
    let root: string;
    let originalData: string | undefined;
    let originalStorage: string | undefined;

    beforeEach(() => {
        originalData = process.env.XDG_DATA_HOME;
        originalStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
        root = createTestTempDirFromPath(join(tmpdir(), "release-shapes-"));
        process.env.XDG_DATA_HOME = root;
        process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
    });
    afterEach(() => {
        closeDatabase();
        if (originalData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalData;
        if (originalStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
        else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorage;
        rmSync(root, { recursive: true, force: true });
    });

    it("#given a full-mode drop #when the pair is released #then carrier args, `...`, no attachments, pair present", () => {
        const db = openDatabase()!;
        insertTag(db, session, "call-shape", "tool", 1000, 1, 0, "bash");
        const messages = fixture();
        const target = createToolDropTarget(
            "call-shape",
            [],
            buildIndex(messages),
            new ToolMutationBatch(messages),
            1,
            sessionKey,
        );

        expect(target.drop()).toBe("removed");

        const token = renderDropToken(1, sessionKey);
        // The carrier seat is the FIRST string-valued input key ("command"),
        // not a fresh key name; non-string values are dropped from the carrier.
        const toolPart = messages[1]!.parts[0] as { state: Record<string, unknown> };
        expect(toolPart.state).toEqual({
            status: "completed",
            input: { command: token },
            output: "",
            attachments: [],
        });
        const invocation = messages[0]!.parts[0] as Record<string, unknown>;
        expect(invocation.args).toEqual({ command: token });
        // The pair always survives: nothing is spliced out of the array.
        expect(messages).toHaveLength(3);
        expect(messages.map((m) => m.info.id)).toEqual(["m-inv", "m-tool", "m-next"]);
    });

    it("replays the same drop through the persisted-mode path byte-identically", () => {
        const db = openDatabase()!;
        insertTag(db, session, "call-shape", "tool", 1000, 1, 0, "bash");

        const messages = fixture();
        const batch = new ToolMutationBatch(messages);
        const targets = new Map([
            [1, createToolDropTarget("call-shape", [], buildIndex(messages), batch, 1, sessionKey)],
        ]);
        expect(targets.get(1)!.drop!()).toBe("removed");
        batch.finalize();
        const firstBytes = JSON.stringify(messages);

        updateTagStatus(db, session, 1, "dropped");
        updateTagDropMode(db, session, 1, "full");

        const clone = fixture();
        const cloneBatch = new ToolMutationBatch(clone);
        const cloneTargets = new Map([
            [
                1,
                createToolDropTarget(
                    "call-shape",
                    [],
                    buildIndex(clone),
                    cloneBatch,
                    1,
                    sessionKey,
                ),
            ],
        ]);
        expect(applyFlushedStatuses(session, db, cloneTargets)).toBe(true);
        cloneBatch.finalize();

        // Same tag under the same session key: the token recomputes to the
        // exact bytes the fresh drop rendered.
        expect(JSON.stringify(clone)).toBe(firstBytes);
        expect(JSON.stringify(clone)).toContain(
            JSON.stringify({ command: renderDropToken(1, sessionKey) }),
        );
    });

    it("replaces re-emitted carrier args with the original tool call input", async () => {
        // The `.before` contract: a token inside the args means the issued
        // call IS the released one — the whole args become the original input.
        const hook = createToolExecuteBeforeHook({
            fpeResolve: {
                lookupOriginal: (sessionId, tagNumber) =>
                    sessionId === session && tagNumber === 1
                        ? { command: "ls -la /tmp", limit: 5 }
                        : undefined,
                maxTag: () => 20_000,
            },
        });
        const output = { args: { command: renderDropToken(1, sessionKey) } };

        await hook({ tool: "bash", sessionID: session, callID: "call-reemitted" }, output);

        expect(output.args).toEqual({ command: "ls -la /tmp", limit: 5 });
    });

    it("passes a token-shaped string whose lookup resolves to nothing through unresolved", async () => {
        const hook = createToolExecuteBeforeHook({
            fpeResolve: {
                lookupOriginal: () => undefined,
                maxTag: () => 20_000,
            },
        });
        const orphan = renderDropToken(9001, sessionKey);
        const output = { args: { query: orphan } };

        await expect(
            hook({ tool: "grep", sessionID: session, callID: "call-orphan" }, output),
        ).resolves.toBeUndefined();
        expect(output.args).toEqual({ query: orphan });
    });
});
