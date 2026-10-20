import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import {
    deriveKey,
    fpeDecrypt,
    fpeEncrypt,
    fpeGate,
    isFpeTokenCandidate,
    renderDropToken,
    stripFillers,
} from "./fpe";
import {
    createToolExecuteBeforeHook,
    lookupReleasedToolInput,
    resolveReleasedToolInput,
} from "./fpe-resolve";

const KEY = deriveKey("test-session-001");

describe("FPE", () => {
    it("round-trips at L=8", () => {
        for (const tagId of [0, 1, 42, 999, 12345, 999_999, 9_999_999]) {
            const token = fpeEncrypt(tagId, KEY, 8);
            expect(token.length).toBe(8);
            expect(fpeDecrypt(token, KEY, 8)).toBe(tagId);
        }
    });

    it("round-trips at L=9", () => {
        for (const tagId of [10_000_000, 99_999_999]) {
            const token = fpeEncrypt(tagId, KEY, 9);
            expect(token.length).toBe(9);
            expect(fpeDecrypt(token, KEY, 9)).toBe(tagId);
        }
    });

    it("is deterministic", () => {
        const a = fpeEncrypt(42, KEY, 8);
        const b = fpeEncrypt(42, KEY, 8);
        expect(a).toBe(b);
    });

    it("produces unique tokens for unique inputs (1000)", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            seen.add(fpeEncrypt(i, KEY, 8));
        }
        expect(seen.size).toBe(1000);
    });

    it("different keys produce different tokens", () => {
        const key2 = deriveKey("different-session");
        expect(fpeEncrypt(42, KEY, 8)).not.toBe(fpeEncrypt(42, key2, 8));
    });

    it("renderDropToken produces filled token", () => {
        const token = renderDropToken(42, KEY);
        expect(token.length).toBeGreaterThanOrEqual(8);
        expect(token.length).toBeLessThanOrEqual(22);
        const stripped = stripFillers(token);
        expect(stripped.length).toBe(8);
        expect(fpeDecrypt(stripped, KEY, 8)).toBe(42);
    });

    it("filler pattern uniqueness (1000 tokens, L=8)", () => {
        const patterns = new Map<string, number>();
        for (let i = 0; i < 1000; i++) {
            const token = renderDropToken(i, KEY);
            const pattern = token
                .split("")
                .map((c) => (/[a-z0-9]/.test(c) ? "X" : "."))
                .join("");
            patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
        }
        expect(patterns.size).toBeGreaterThan(500);
        const maxFreq = Math.max(...patterns.values());
        expect(maxFreq).toBeLessThanOrEqual(10);
    });

    it("gate rejects non-FPE strings", () => {
        const cases = [
            "ls -la /tmp",
            "git commit -m 'fix bug'",
            "npm install express",
            "cat /etc/passwd",
            "echo hello world",
            "grep -rn 'pattern' src/",
            "python3 script.py --flag",
            "curl https://example.com/api",
        ];
        for (const s of cases) {
            const result = fpeGate(s, KEY, 8);
            expect(result.matched).toBe(false);
        }
    });

    it("gate accepts valid FPE tokens", () => {
        for (const tagId of [0, 42, 999, 12345, 999_999]) {
            const token = renderDropToken(tagId, KEY);
            const result = fpeGate(token, KEY, 8);
            expect(result.matched).toBe(true);
            expect(result.tagId).toBe(tagId);
        }
    });

    it("isFpeTokenCandidate detects candidates", () => {
        expect(isFpeTokenCandidate(renderDropToken(42, KEY))).toBe(true);
        expect(isFpeTokenCandidate("ls -la")).toBe(false);
        expect(isFpeTokenCandidate("")).toBe(false);
    });

    it("deriveKey is deterministic", () => {
        expect(deriveKey("session-1")).toBe(deriveKey("session-1"));
        expect(deriveKey("session-1")).not.toBe(deriveKey("session-2"));
    });
});

describe("FPE released-input lookup (registry spine)", () => {
    function makeWorld() {
        const dir = mkdtempSync(join(tmpdir(), "fpe-lookup-"));
        const hostPath = join(dir, "opencode.db");
        const host = new Database(hostPath);
        host.exec(`
            CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
            CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
        `);
        const insertPart = host.prepare(
            "INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)",
        );
        const toolPart = (callId: string, command: string) =>
            JSON.stringify({
                type: "tool",
                tool: "bash",
                callID: callId,
                state: { input: { command } },
            });
        insertPart.run("prt_a", "msg_owner", SESSION, toolPart("call_a", "ls"));
        insertPart.run("prt_b", "msg_owner", SESSION, toolPart("call_b", "pwd"));
        insertPart.run(
            "prt_text",
            "msg_owner",
            SESSION,
            JSON.stringify({ type: "text", text: "narrative" }),
        );
        host.close();
        process.env.OPENCODE_DB = hostPath;
        const mc = new Database(":memory:");
        mc.exec(`
            CREATE TABLE tags (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT, message_id TEXT, type TEXT, status TEXT,
                tag_number INTEGER, tool_owner_message_id TEXT
            );
        `);
        const insertTag = mc.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, tag_number, tool_owner_message_id) VALUES (?, ?, 'tool', 'dropped', ?, ?)",
        );
        // Production key geometry: tool rows key on the wire call id.
        insertTag.run(SESSION, "call_a", 7, "msg_owner");
        insertTag.run(SESSION, "call_b", 8, "msg_owner");
        insertTag.run(SESSION, "call_c", 9, "msg_owner"); // part pruned from the host
        return { mc };
    }
    const SESSION = "ses_fpe_lookup";
    const savedEnv = process.env.OPENCODE_DB;
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.OPENCODE_DB;
        else process.env.OPENCODE_DB = savedEnv;
    });

    it("resolves a released tag to the exact part's original input", () => {
        const { mc } = makeWorld();
        expect(lookupReleasedToolInput(mc, SESSION, 7)).toEqual({ command: "ls" });
    });

    it("parallel batch: same owner message resolves per call id", () => {
        const { mc } = makeWorld();
        expect(lookupReleasedToolInput(mc, SESSION, 8)).toEqual({ command: "pwd" });
    });

    it("pruned part resolves to undefined (token stays inert)", () => {
        const { mc } = makeWorld();
        expect(lookupReleasedToolInput(mc, SESSION, 9)).toBeUndefined();
    });

    it("unknown tag resolves to undefined", () => {
        const { mc } = makeWorld();
        expect(lookupReleasedToolInput(mc, SESSION, 404)).toBeUndefined();
    });
});

describe("FPE resolver contract (resolver, not gate)", () => {
    const RKEY = deriveKey("ses_fpe_lookup");
    const deps = () => ({
        lookupOriginal: (_sessionId: string, tagId: number) =>
            tagId === 8 ? { command: "pwd" } : undefined,
    });

    it("corrupted token-shaped soup resolves to nothing, never rejects", () => {
        const args = { command: "9\u2022\u2E3166\u2022\u2E314586\u2023\u20235" };
        expect(() => resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).not.toThrow();
        expect(resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).toBeUndefined();
    });

    it("a non-soup mark-bearing string resolves to nothing, never rejects", () => {
        const args = { command: "z\u0366z\u0352z\u0313z\u0366z\u0352z\u0313zz" };
        expect(() => resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).not.toThrow();
        expect(resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).toBeUndefined();
    });

    it("a real mint for a released call resolves to the original", () => {
        const token = renderDropToken(8, RKEY);
        expect(resolveReleasedToolInput({ command: token }, "ses_fpe_lookup", deps())).toEqual({
            command: "pwd",
        });
    });

    it("hook passes unresolvable token-shaped args through unchanged", async () => {
        const hook = createToolExecuteBeforeHook({ fpeResolve: deps() });
        const output = { args: { command: "9\u2022\u2E3166\u2022\u2E314586\u2023\u20235" } };
        await hook({ tool: "bash", sessionID: "ses_fpe_lookup" }, output);
        expect(output.args).toEqual({ command: "9\u2022\u2E3166\u2022\u2E314586\u2023\u20235" });
    });

    it("hook never blocks a call on resolver internals failure", async () => {
        const broken = {
            lookupOriginal: () => {
                throw new Error("db exploded");
            },
        };
        const hook = createToolExecuteBeforeHook({ fpeResolve: broken });
        const token = renderDropToken(8, RKEY);
        const output = { args: { command: token } };
        await hook({ tool: "bash", sessionID: "ses_fpe_lookup" }, output);
        expect(output.args).toEqual({ command: token });
    });
});
