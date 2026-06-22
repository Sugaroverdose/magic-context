import { describe, expect, test } from "bun:test";

import type { SmartNoteCapabilityApi } from "./capabilities";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";

const fakeCap: SmartNoteCapabilityApi = {
    readFile: async (path) => (path === "ready.txt" ? "ready" : null),
    gitHeadSha: async () => "abc123",
    gitTag: async () => "v1.2.3",
    gitLog: async () => [{ sha: "abc", subject: "initial", authorDate: "2026-01-01T00:00:00Z" }],
    httpGet: async () => ({ status: 200, body: "ok" }),
};

describe("compiled smart-note QuickJS runner", () => {
    test("runs a check with injected capabilities", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check(cap) { return { met: cap.readFile("ready.txt") === "ready" }; }`,
            capabilities: fakeCap,
        });
        expect(result).toEqual({ ok: true, result: { met: true } });
    });

    test("rejects malformed return values", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { return { reason: "nope" }; }`,
            capabilities: fakeCap,
        });
        expect(result.ok).toBe(false);
    });

    test("interrupts infinite loops", async () => {
        const result = await runCompiledSmartNoteCheck({
            compiledCheck: `function check() { while (true) {} }`,
            capabilities: fakeCap,
            timeoutMs: 50,
        });
        expect(result.ok).toBe(false);
    });
});
