/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { deriveKey, renderDropToken } from "./fpe";
import { type MessageLike, tagMessages } from "./transform-operations";

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

describe("tool input preservation", () => {
    it("releases the dropped tool call atomically in the full shape", () => {
        useTempDataHome("context-tool-input-preserve-drop-");
        const db = openDatabase();
        const tagger = createTagger();

        const messages: MessageLike[] = [
            {
                info: { id: "m-assistant", role: "assistant", sessionID: "ses-1" },
                parts: [{ type: "tool-invocation", callID: "call-1" }],
            },
            {
                info: { id: "m-tool", role: "tool", sessionID: "ses-1" },
                parts: [
                    {
                        type: "tool",
                        callID: "call-1",
                        state: {
                            output: "tool output",
                            input: { path: "src/index.ts", replaceAll: true },
                        },
                    },
                ],
            },
            // A later prompt, so this call does not end the conversation (drop()
            // keeps that one as a skeleton instead of removing it).
            {
                info: { id: "m-next", role: "user", sessionID: "ses-1" },
                parts: [{ type: "text", text: "next prompt" }],
            },
        ];

        const { targets, batch } = tagMessages("ses-1", messages, tagger, db);
        const toolTagId = tagger.getToolTag("ses-1", "call-1", "m-assistant");
        expect(toolTagId).toBeDefined();

        const dropResult = targets.get(toolTagId!)?.drop?.();
        expect(dropResult).toBe("removed");
        batch.finalize();
        // The pair is never removed: every message survives in the full shape.
        expect(messages.map((message) => message.info.id)).toEqual([
            "m-assistant",
            "m-tool",
            "m-next",
        ]);
        const token = renderDropToken(toolTagId!, deriveKey("ses-1"));
        const invocation = messages[0]?.parts[0] as Record<string, unknown>;
        expect(invocation.args).toEqual({ d: token });
        const toolPart = messages[1]?.parts[0] as { state: Record<string, unknown> };
        expect(toolPart.state).toEqual({
            output: "",
            attachments: [],
            input: { path: token },
        });
    });
});
