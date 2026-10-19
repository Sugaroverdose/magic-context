import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import {
    deriveKey,
    FILLER_POOL,
    fpeDecrypt,
    fpeEncrypt,
    fpeGate,
    fpeGateLegacy,
    isFpeTokenCandidate,
    renderDropToken,
    stripFillers,
} from "./fpe";
import { lookupReleasedToolInput } from "./fpe-resolve";

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

    it("render is a pure function (restart/cache consistency)", () => {
        // Tokens re-render every transform pass; the wire bytes only stay
        // stable across restarts because render has no state, no RNG, and its
        // seed derives from (token, sessionId) alone.
        for (const tagId of [0, 42, 18118, 9_999_999]) {
            const key = deriveKey("ses_restart_consistency");
            expect(renderDropToken(tagId, key)).toBe(renderDropToken(tagId, key));
        }
    });

    it("pool is U+0300-U+036F, NFC/NFD-anchored: no composition, no self-decomposition", () => {
        for (const m of FILLER_POOL) {
            const cp = m.codePointAt(0)!;
            expect(cp).toBeGreaterThanOrEqual(0x300);
            expect(cp).toBeLessThanOrEqual(0x36f);
            expect(m.normalize("NFD")).toBe(m);
            for (const base of "abcxyz0189") {
                expect(`${base}${m}`.normalize("NFC").length).toBe(2);
            }
        }
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
            // v2: filler type counts (the format space is marks x counts, not
            // dots-vs-alnum shape — v1's shape pattern collapsed to 2^7 here).
            const pattern = token
                .split("")
                .map((c) => (/[a-z0-9]/.test(c) ? "X" : c.codePointAt(0)!.toString(36)))
                .join("");
            patterns.set(pattern, (patterns.get(pattern) ?? 0) + 1);
        }
        expect(patterns.size).toBeGreaterThan(950);
        const maxFreq = Math.max(...patterns.values());
        expect(maxFreq).toBeLessThanOrEqual(3);
    });

    it("v2 density: every gap carries at least one mark", () => {
        for (let i = 0; i < 200; i++) {
            const token = renderDropToken(i, KEY);
            const chars = [...token];
            for (let j = 0; j < chars.length - 1; j++) {
                if (/[a-z0-9]/.test(chars[j]) && /[a-z0-9]/.test(chars[j + 1])) {
                    throw new Error(`adjacent payload chars at ${j}: ${token}`);
                }
            }
            expect(token.length).toBeGreaterThanOrEqual(15);
            expect(token.length).toBeLessThanOrEqual(22);
        }
    });

    it("v2 pool is composition-free: render is NFC-stable by construction", () => {
        const token = renderDropToken(1234, KEY);
        expect(token.normalize("NFC")).toBe(token);
        // No pool mark composes with a payload character.
        const stripped = stripFillers(token);
        const marks = [...token].filter((c) => !/[a-z0-9]/.test(c));
        for (const m of new Set(marks)) {
            for (const base of stripped) {
                expect(`${base}${m}`.normalize("NFC").length).toBe(2);
            }
        }
    });

    it("gate bounds-check rejects in-range-only tokens", () => {
        const token = renderDropToken(42, KEY);
        expect(fpeGate(token, KEY, 8, 41).matched).toBe(false);
        expect(fpeGate(token, KEY, 8, 42).matched).toBe(true);
    });

    it("legacy lane resolves a v1 replay and flags corrupted soup", () => {
        // v1 render = same cipher, dot fillers.
        const payload = fpeEncrypt(42, KEY, 8);
        const legacy = `${payload[0]}\u00b7${payload.slice(1)}\u2022`;
        const resolved = fpeGateLegacy(legacy, KEY, 8, 1000);
        expect(resolved).toEqual({ status: "resolved", tagId: 42 });
        // The session's recorded garble class: soup shape, out-of-range payload.
        expect(fpeGateLegacy("9\u2022\u2e3166\u2022\u2e314586\u2023\u20235", KEY, 8, 1000)).toEqual(
            {
                status: "corrupted",
            },
        );
        expect(fpeGateLegacy("npm install express", KEY, 8, 1000)).toEqual({ status: "none" });
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
            const result = fpeGate(s, KEY, 8, 10_000);
            expect(result.matched).toBe(false);
        }
    });

    it("gate accepts valid FPE tokens", () => {
        for (const tagId of [0, 42, 999, 12345, 999_999]) {
            const token = renderDropToken(tagId, KEY);
            const result = fpeGate(token, KEY, 8, 1_000_000);
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
        mc.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, tag_number, tool_owner_message_id) VALUES (?, ?, 'tool', 'active', ?, ?)",
        ).run(SESSION, "call_a", 11, "msg_owner"); // never released
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

    it("never-released (active) tag resolves to undefined", () => {
        const { mc } = makeWorld();
        expect(lookupReleasedToolInput(mc, SESSION, 11)).toBeUndefined();
    });
});
