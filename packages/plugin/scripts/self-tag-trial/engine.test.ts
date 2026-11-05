import { createTestTempDir } from "../../src/shared/test-temp-dir";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { forbiddenOpenPaths, isolate } from "./bootstrap";
import type * as Engine from "./engine";
let engine: typeof Engine;
const originalEnv = { ...process.env };
beforeAll(async () => { isolate(createTestTempDir("self-tag-engine-").dir); engine = await import("./engine"); });
afterAll(() => {
    for (const key of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "HOME", "MAGIC_CONTEXT_STORAGE_DIR", "MAGIC_CONTEXT_LOG_PATH", "OPENCODE_DB", "OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_CONFIG_DIR"]) {
        if (originalEnv[key] === undefined) delete process.env[key];
        else process.env[key] = originalEnv[key];
    }
});
describe("self-tag trial real tagging", () => {
    test("live-store fence rejects forbidden lsof entries", () => {
        const entries = "p123\nn/tmp/magic-context/self-tag-trial/context.db\nn/Users/operator/.local/share/opencode/opencode.db\nn/Users/operator/.config/cortexkit/config.json";
        expect(forbiddenOpenPaths(entries, "/Users/operator")).toEqual([
            "n/Users/operator/.local/share/opencode/opencode.db",
            "n/Users/operator/.config/cortexkit/config.json",
        ]);
        expect(forbiddenOpenPaths("n/tmp/magic-context/self-tag-trial/context.db", "/Users/operator")).toEqual([]);
    });
    test("each nonblank text part receives its own next number; reasoning receives none", () => {
        const result = engine.probe([{ type: "reasoning", text: "private" }, { type: "text", text: "one" }, { type: "text", text: "two" }]);
        expect(result.assignments).toEqual([["user:p0", 1], ["assistant:p1", 2], ["assistant:p2", 3]]);
    });
    test("parallel completed tool outputs consume numbers before later text", () => {
        const result = engine.probe([{ type: "tool", callID: "a", state: { output: "A" } }, { type: "tool", callID: "b", state: { output: "B" } }, { type: "text", text: "last" }]);
        expect(result.assignments.map(([, n]) => n)).toEqual([1, 2, 3, 4]);
        expect((result.messages[1].parts[2] as { text: string }).text).toBe("§4§ last");
    });
    test("persistence strip and next-pass retag yield exact bytes only for canonical replies", async () => {
        const t = new engine.Trial("byte-test", "B", "control");
        try {
            t.user("prompt"); await t.pass();
            const [good] = await t.accept({ texts: ["§2§ Seven fruit."], calls: [] });
            expect(good.correct).toBe(true); expect(good.byteIdentity).toBe(true);
            t.user("next"); await t.pass();
            const [wrong] = await t.accept({ texts: ["§9002§ Seven fruit. "], calls: [] });
            expect(wrong.assignedTag).toBe(4); expect(wrong.delta).toBe(8998); expect(wrong.byteIdentity).toBe(false);
            const [bad] = await t.accept({ texts: ["§5\"> Seven §12§ fruit."], calls: [] });
            expect(bad.malformed).toBe(true); expect(bad.misplaced).toBe(true); expect(bad.byteIdentity).toBe(false);
        } finally { t.close(); }
    });
    test("queued reduction releases a recent tool skeleton to an empty slot", async () => {
        const t = new engine.Trial("drop-test", "A", "control");
        try {
            t.user("fixture"); await t.accept({ texts: [], calls: [{ id: "read", name: "read", input: {} }] });
            for (let n = 0; n < 10; n++) { t.user(`turn ${n}`); await t.accept({ texts: ["seven"], calls: [] }); }
            await t.accept({ texts: [], calls: [{ id: "reduce", name: "ctx_reduce", input: { drop: "2" } }] });
            // R11 (Unit 5): a released tool skeleton is the empty slot
            // (TOOL_RELEASED_SENTINEL = ""), NOT the message-drop placeholder —
            // [dropped §N§] is the whole-MESSAGE lane only. The pair survives
            // (a tool pair is never removed from the wire); the imitable tool
            // bytes leave, the tag prefix stays (v2 retains tag prefixes — the
            // lineage's tag-prefix-free "output":"" is not the v2 wire).
            const wire = JSON.stringify(await t.pass());
            expect(wire).toContain('"output":"§2§ "');
            expect(wire).not.toContain("fixture.txt:");
        } finally { t.close(); }
    });
});
