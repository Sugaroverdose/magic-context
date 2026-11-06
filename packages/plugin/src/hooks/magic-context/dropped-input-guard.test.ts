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
    ["legacy five-character truncation", { command: "which...[truncated]" }],
    ["new dropped marker object", { dropped: "[dropped §431§]" }],
];

// Drop-shape doctrine restore (2026-11-06, owner ruling "ONLY m[0,1] placement
// was allowed to drift"; the five-character `...[truncated]` arm re-joined
// blockedInputs above): the Unit 4 split-item-D premise that "no v2 code path
// mints those shapes" is falsified for the truncation copy — edit-marker.ts is
// byte-identical to 9c1520810 and LIVE: tag-transcript.ts editMarker() →
// applyEditMarkerToInput renders `${clamp}...[truncated]` into model-visible
// tool-input bytes on the edit_marker drop mode, exactly as base does, so a
// model copy of it is a copy of a live minted shape and must be refused.
// The two arms that stay dead are genuinely never minted by base OR v2 (no v1
// production site renders "[object]" or "[N items]" — rg-verified; they were
// pre-upgrade wire archaeology): census "Dead tag-strip family removal
// (#2812)" + Unit 4 addendum.
const notBlockedInputs: Array<[string, unknown]> = [
    ["array-summary-shaped string (no base or v2 minter)", { files: "[3 items]" }],
    ["object-summary-shaped string (no base or v2 minter)", { metadata: "[object]" }],
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
        ).toBe(true);
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
// form) — narrowed 2026-11-06 by the drop-shape doctrine restore: the
// five-character `...[truncated]` matcher rejoined production (edit-marker.ts
// live-mints that exact shape into model-visible edit_marker tool input, base
// behavior; see the blockedInputs note above), leaving only the two arms that
// NEITHER base nor v2 ever mints. The census laws match the arm texts against
// the production source string directly — that is the bite: a re-added arm
// reddens its law on the real tree. The witness loop verifies each law's
// needle by re-injecting the arm text into an in-memory clone of the source
// and requiring the same containment check to fire — it proves the needle can
// observe the arm (a needle matching nothing is not a census), not a separate
// detector run.
describe("dropped-input-guard dead-arm census", () => {
    const source = readFileSync(new URL("./dropped-input-guard.ts", import.meta.url), "utf8");

    const deadArms: Array<[string, string, string]> = [
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

    it("the restored five-character truncation matcher survives", () => {
        // Drop-shape doctrine restore (2026-11-06): edit_marker mints the
        // shape via edit-marker.ts TRUNCATION_SENTINEL on both trees, so the
        // recognizer arm must live in production — this is the base form
        // (9c1520810 dropped-input-guard.ts:8, :22).
        expect(source.includes("LEGACY_TRUNCATED_VALUE.test(value)")).toBe(true);
    });
});
