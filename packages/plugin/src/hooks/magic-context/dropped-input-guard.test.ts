/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
    containsDroppedInputPlaceholder,
    createDroppedInputGuard,
    createDroppedInputToolExecuteBeforeHook,
    droppedInputRefusalMessage,
    recordToolParameters,
    toolParameterNames,
} from "./dropped-input-guard";

const blockedInputs: Array<[string, unknown]> = [
    ["tagged drop sentinel", { command: "[dropped §431§]" }],
    ["new dropped marker object", { dropped: "[dropped §431§]" }],
];

// Unit 4 (coordinator split item D): the three legacy arms — five-character
// "...[truncated]" copies, "[3 items]", "[object]" — died with the pre-upgrade
// session class. v2 is clean-room: no v2 code path mints those shapes into
// model-copyable transcript bytes (the same sentinel string in
// module-state-sync's edit-marker SEED payload is internal canonical JSON,
// never a rendered part; pi's "…[truncated]" uses a Unicode ellipsis and
// stderr bytes), so recognizing them only refuses legitimate content.
const notBlockedInputs: Array<[string, unknown]> = [
    ["five-character truncation copy (no v2 minter)", { command: "which...[truncated]" }],
    ["array-summary-shaped string (no v2 minter)", { files: "[3 items]" }],
    ["object-summary-shaped string (no v2 minter)", { metadata: "[object]" }],
];

const bashSchema = {
    type: "object",
    properties: {
        timeout: { type: "number" },
        command: { type: "string" },
        workdir: { type: "string" },
    },
    required: ["command"],
};

describe("dropped input execution guard", () => {
    for (const [label, input] of blockedInputs) {
        it(`detects the ${label}`, () => {
            expect(containsDroppedInputPlaceholder(input)).toBe(true);
        });
    }

    for (const [label, input] of notBlockedInputs) {
        it(`executes a ${label}`, () => {
            expect(containsDroppedInputPlaceholder(input)).toBe(false);
        });
    }

    it("walks nested input without mistaking explanatory prose for a placeholder", () => {
        expect(
            containsDroppedInputPlaceholder({ nested: [{ value: "abcde...[truncated]" }] }),
        ).toBe(false);
        expect(
            containsDroppedInputPlaceholder({
                content: "The log used ...[truncated] before the final retry.",
            }),
        ).toBe(false);
        // A real value that ends with the sentinel text is longer than any copied
        // placeholder (five characters plus the sentinel) and must stay executable.
        expect(
            containsDroppedInputPlaceholder({
                content: "expected output line 1\nexpected output line 2\n...[truncated]",
            }),
        ).toBe(false);
    });

    it("rejects through the OpenCode tool.execute.before hook", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();

        // Canonical-shape probe: the legacy "...[truncated]" probe died with
        // the arm (Unit 4 item D); the refusal routing under test is the
        // same path for the one recognized placeholder shape.
        await expect(
            hook(
                { tool: "write", sessionID: "ses-431", callID: "call-431" },
                { args: { filePath: "[dropped §431§]", content: "payload" } },
            ),
        ).rejects.toThrow("placeholder Magic Context shows");
    });

    it("allows ordinary executable arguments", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();
        await expect(
            hook(
                { tool: "bash", sessionID: "ses-clean", callID: "call-clean" },
                { args: { command: "which docker" } },
            ),
        ).resolves.toBeUndefined();
    });
});

describe("dropped input refusal text", () => {
    it("names the copied dropped marker, says it is a placeholder, and lists schema parameters", () => {
        const message = droppedInputRefusalMessage({
            toolName: "bash",
            input: { dropped: "[dropped §768§]" },
            parameters: bashSchema,
            consecutive: 1,
        });

        expect(message).toContain('your arguments to `bash` were {"dropped":"[dropped §768§]"}');
        expect(message).toContain(
            "the placeholder Magic Context shows in place of an earlier call's arguments",
        );
        expect(message).toContain("not a value to send");
        expect(message).toContain("Nothing is wrong with the session or the tool");
        // Required parameters come first, then the rest in schema order.
        expect(message).toContain(
            "Call `bash` again with real values for its parameters: command (required), timeout, workdir.",
        );
        expect(message).toContain(
            "Only if you need the original arguments of an earlier dropped call",
        );
        expect(message).toContain("ctx_expand");
        expect(message).not.toContain("in a row");
        expect(message.split("\n").length).toBeLessThanOrEqual(4);
    });

    it("quotes the legacy truncated shape as received", () => {
        const message = droppedInputRefusalMessage({
            toolName: "bash",
            input: { command: "which...[truncated]" },
            parameters: bashSchema,
            consecutive: 1,
        });

        expect(message).toContain('were {"command":"which...[truncated]"}');
        expect(message).toContain("command (required), timeout, workdir");
    });

    it("quotes a nested placeholder and shortens long arguments", () => {
        const message = droppedInputRefusalMessage({
            toolName: "edit",
            input: {
                filePath: "/repo/src/app.ts",
                edits: [{ oldString: "[dropped §12§]", newString: "x".repeat(400) }],
            },
            parameters: undefined,
            consecutive: 1,
        });

        expect(message).toContain('were {"filePath":"/repo/src/app.ts","edits":[{"oldString"');
        expect(message).not.toContain("x".repeat(300));
        expect(message).toContain("…");
        // Without a visible schema, the text must not invent parameter names.
        expect(message).toContain(
            "Call `edit` again with real values for the tool's own parameters.",
        );
    });

    it("reads parameter names from a zod object schema the way OpenCode hands them over", () => {
        const names = toolParameterNames(
            z.object({
                pattern: z.string(),
                path: z.string().optional(),
                include: z.string().optional(),
            }),
        );

        expect(names).toEqual({ required: ["pattern"], optional: ["path", "include"] });
    });

    it("uses the recorded tool schema when the guard is not handed one", () => {
        recordToolParameters("dropped-guard-test-search", {
            type: "object",
            properties: { query: { type: "string" }, topK: { type: "number" } },
            required: ["query"],
        });
        const guard = createDroppedInputGuard();

        const message = guard.check({
            sessionID: "ses-schema",
            toolName: "dropped-guard-test-search",
            input: { dropped: "[dropped §770§]" },
        });

        expect(message).toContain("its parameters: query (required), topK.");
    });
});

describe("consecutive dropped input refusals", () => {
    it("counts refusals per session and resets on the next accepted call", () => {
        const guard = createDroppedInputGuard({ parametersFor: () => bashSchema });
        const refused = { toolName: "bash", input: { dropped: "[dropped §768§]" } };

        const first = guard.check({ sessionID: "ses-a", ...refused });
        const second = guard.check({ sessionID: "ses-a", ...refused });
        const third = guard.check({ sessionID: "ses-a", ...refused });
        const otherSession = guard.check({ sessionID: "ses-b", ...refused });

        expect(first).not.toContain("in a row");
        expect(second).toContain("This is the 2nd call in a row with placeholder arguments.");
        expect(third).toContain("This is the 3rd call in a row with placeholder arguments.");
        expect(otherSession).not.toContain("in a row");

        expect(
            guard.check({ sessionID: "ses-a", toolName: "bash", input: { command: "ls" } }),
        ).toBeUndefined();
        expect(guard.check({ sessionID: "ses-a", ...refused })).not.toContain("in a row");
    });

    it("counts across calls through the OpenCode hook", async () => {
        const hook = createDroppedInputToolExecuteBeforeHook();
        const refusal = async () => {
            try {
                await hook(
                    { tool: "bash", sessionID: "ses-hook", callID: "call" },
                    { args: { dropped: "[dropped §769§]" } },
                );
            } catch (error) {
                return (error as Error).message;
            }
            throw new Error("placeholder call was not refused");
        };

        expect(await refusal()).not.toContain("in a row");
        expect(await refusal()).toContain("This is the 2nd call in a row");
        await hook(
            { tool: "bash", sessionID: "ses-hook", callID: "call-ok" },
            { args: { command: "ls" } },
        );
        expect(await refusal()).not.toContain("in a row");
    });
});

// Unit 4 dead-arm census (coordinator split item D, #2780 committed-rogue
// form): the pre-upgrade recognition arms stay dead in the production file.
// The census laws match the arm texts against the production source string
// directly — that is the bite: a re-added arm reddens its law on the real
// tree. The witness loop verifies each law's needle by re-injecting the arm
// text into an in-memory clone of the source and requiring the same
// containment check to fire — it proves the needle can observe the arm
// (a needle matching nothing is not a census), not a separate detector run.
describe("dropped-input-guard dead-arm census", () => {
    const source = readFileSync(new URL("./dropped-input-guard.ts", import.meta.url), "utf8");

    const deadArms: Array<[string, string, string]> = [
        [
            "five-character truncation matcher",
            "\\[truncated\\]$/",
            "const LEGACY = /^[\\s\\S]{0,5}\\.\\.\\.\\[truncated\\]$/;",
        ],
        ["object-summary arm", '=== "[object]"', 'value === "[object]" ||'],
        ["array-summary arm", "\\d+ items\\]", "/^\\[\\d+ items\\]$/.test(value) ||"],
    ];

    for (const [label, needle, rogue] of deadArms) {
        it(`keeps the ${label} out of the production source`, () => {
            expect(source.includes(needle)).toBe(false);
        });
        it(`the detector fires when the ${label} is planted back`, () => {
            const clone = `${source}\n// rogue witness\n${rogue}\n`;
            expect(clone.includes(needle)).toBe(true);
        });
    }

    it("the canonical tagged-placeholder matcher survives", () => {
        expect(source.includes('startsWith("[dropped \u00a7")')).toBe(true);
    });
});
