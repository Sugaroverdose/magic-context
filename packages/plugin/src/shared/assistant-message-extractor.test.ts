import { describe, expect, test } from "bun:test";
import { hasLengthCappedOutput } from "./assistant-message-extractor";

describe("hasLengthCappedOutput", () => {
    test("detects OpenCode assistant info.finish", () => {
        expect(hasLengthCappedOutput([{ info: { role: "assistant", finish: "length" } }])).toBe(
            true,
        );
    });

    test("detects OpenCode step-finish reason", () => {
        expect(
            hasLengthCappedOutput([{ parts: [{ type: "step-finish", reason: "length" }] }]),
        ).toBe(true);
        expect(hasLengthCappedOutput({ type: "text", reason: "length" })).toBe(false);
    });

    test("detects Pi stopReason length", () => {
        expect(hasLengthCappedOutput({ role: "assistant", stopReason: "length" })).toBe(true);
    });
});
