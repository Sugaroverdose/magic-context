import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import {
    deriveKey,
    FILLER_POOL,
    fpeGate,
    isFpeTokenCandidate,
    renderDropToken,
} from "./fpe";
import {
    createToolExecuteBeforeHook,
    lookupReleasedToolInput,
    resolveReleasedToolInput,
} from "./fpe-resolve";

const KEY = deriveKey("test-session-001");

describe("FPE", () => {
    const MARK = /[\u0300-\u036f]/;
    const markCount = (t: string) => [...t].filter((c) => MARK.test(c)).length;

    it("render is a pure function (restart/cache consistency)", () => {
        // Tokens re-render every transform pass; the wire bytes only stay
        // stable across restarts because render has no state, no RNG, and its
        // seed derives from (payload, sessionId) alone.
        for (const tagId of [0, 42, 18118, 2_000_000]) {
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

    it("v3 round-trips every tag in the real range", () => {
        for (const tagId of [0, 1, 42, 999, 18118, 19_000, 1_411_342, 1_411_343, 1_411_344, 2_000_000]) {
            const token = renderDropToken(tagId, KEY);
            const result = fpeGate(token, KEY, 2_000_000);
            expect(result.matched).toBe(true);
            expect(result.tagId).toBe(tagId);
        }
    });

    it("forces 3 cells above the 2-cell tag ceiling", () => {
        // 1188^2 - 1 = 1_411_343 is the last tag the 2-cell cipher covers;
        // below it the seeded P randomizes, above it P=3 is forced.
        expect(fpeGate(renderDropToken(1_411_343, KEY), KEY, 2_000_000).tagId).toBe(1_411_343);
        expect(markCount(renderDropToken(1_411_344, KEY))).toBe(3);
        expect(markCount(renderDropToken(2_000_000, KEY))).toBe(3);
    });

    it("cell count randomizes between 2 and 3 (seeded, deterministic)", () => {
        let p2 = 0;
        let p3 = 0;
        for (let i = 1; i <= 500; i++) {
            const m = markCount(renderDropToken(i, KEY));
            if (m === 2) p2++;
            else p3++;
        }
        expect(p2).toBeGreaterThan(100);
        expect(p3).toBeGreaterThan(100);
    });

    it("v3 geometry: 2-3 marks, len 14-20, one mark per cluster, cells never touch", () => {
        for (let i = 1; i <= 1000; i++) {
            const token = renderDropToken(i, KEY);
            const marks = markCount(token);
            expect(marks === 2 || marks === 3).toBe(true);
            expect(token.length).toBeGreaterThanOrEqual(14);
            expect(token.length).toBeLessThanOrEqual(20);
            const nfd = token.normalize("NFD");
            // cells never touch: no stacked marks, no leading orphan
            expect(/[\u0300-\u036f][\u0300-\u036f]/.test(nfd)).toBe(false);
            expect(MARK.test(nfd[0])).toBe(false);
            for (const ch of token) {
                expect(MARK.test(ch) ? FILLER_POOL.includes(ch) : /[a-z0-9]/.test(ch)).toBe(true);
            }
        }
    });

    it("v3 render is NFC-stable by construction", () => {
        for (let i = 1; i <= 1000; i++) {
            expect(renderDropToken(i, KEY).normalize("NFC")).toBe(renderDropToken(i, KEY));
        }
    });

    it("produces unique tokens for unique inputs (1000)", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1000; i++) seen.add(renderDropToken(i, KEY));
        expect(seen.size).toBe(1000);
    });

    it("format uniqueness: positions and mark identities vary", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            const token = renderDropToken(i, KEY);
            seen.add([...token].map((c) => (MARK.test(c) ? `m${c.codePointAt(0)?.toString(16)}` : c)).join(""));
        }
        expect(seen.size).toBe(1000);
    });

    it("different keys produce different tokens", () => {
        const a = renderDropToken(42, KEY);
        const b = renderDropToken(42, deriveKey("test-session-002"));
        expect(a).not.toBe(b);
    });

    it("gate bounds-check: acceptance ranges over real tags, not the cipher domain", () => {
        const token = renderDropToken(42, KEY);
        expect(fpeGate(token, KEY, 41).matched).toBe(false);
        expect(fpeGate(token, KEY, 42).matched).toBe(true);
    });

    it("gate rejects the retired v2 bulk-mark format, soup, prose, garbles", () => {
        const v2Era = "b\u034b3\u033ec\u0366h\u0357w\u0342i\u0351g\u0369k";
        expect(fpeGate(v2Era, KEY, 19_000).matched).toBe(false);
        expect(fpeGate("dd gsza9s", KEY, 19_000).matched).toBe(false);
        expect(fpeGate("9\u2022\u2e3166\u2022\u2e314586\u2023\u20235", KEY, 19_000).matched).toBe(false);
        for (const s of ["ls -la", "npm install express", "hello world", "2024-01-15", "x"]) {
            expect(fpeGate(s, KEY, 10_000).matched).toBe(false);
        }
    });

    it("gate accepts valid v3 tokens", () => {
        for (const tagId of [0, 1, 42, 500, 18118]) {
            const token = renderDropToken(tagId, KEY);
            expect(fpeGate(token, KEY, 1_000_000).matched).toBe(true);
        }
    });

    it("isFpeTokenCandidate gates on the v3 shape", () => {
        expect(isFpeTokenCandidate(renderDropToken(42, KEY))).toBe(true);
        // retired v2 shape (mark-heavy) is NOT a candidate: passes through inert
        expect(isFpeTokenCandidate("b\u034b3\u033ec\u0366h\u0357w\u0342i\u0351g\u0369k")).toBe(false);
        expect(isFpeTokenCandidate("ls -la")).toBe(false);
        expect(isFpeTokenCandidate("a1b2c3d4e5f6")).toBe(false);
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

describe("FPE resolver contract (resolver, not gate)", () => {
    const KEY = deriveKey("ses_fpe_lookup");
    const deps = () => ({
        lookupOriginal: (_sessionId: string, tagId: number) =>
            tagId === 8 ? { command: "pwd" } : undefined,
        maxTag: () => 100,
    });

    it("corrupted legacy soup resolves to nothing, never rejects", () => {
        const args = { command: "9•⸱66•⸱4586‣‣5" };
        expect(() =>
            resolveReleasedToolInput(args, "ses_fpe_lookup", deps())
        ).not.toThrow();
        expect(resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).toBeUndefined();
    });

    it("corrupted retired v2 shape resolves to nothing, never rejects", () => {
        // v2 bulk-mark form: base36 payload + pool-mark fillers (U+0301 is a
        // composition pair and NOT pool-valid — it must never appear here)
        const args = { command: "zͦz͒z̓zͦz͒z̓zz" };
        expect(() =>
            resolveReleasedToolInput(args, "ses_fpe_lookup", deps())
        ).not.toThrow();
        expect(resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).toBeUndefined();
    });

    it("synthesized v3-shaped token resolves to nothing, never rejects", () => {
        const args = { command: "46z9\u036F73569\u031324" };
        expect(() =>
            resolveReleasedToolInput(args, "ses_fpe_lookup", deps())
        ).not.toThrow();
        expect(resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).toBeUndefined();
    });

    it("a real v3 mint for a released call still resolves to the original", () => {
        const token = renderDropToken(8, KEY);
        const args = { command: token };
        expect(resolveReleasedToolInput(args, "ses_fpe_lookup", deps())).toEqual({
            command: "pwd",
        });
    });

    it("hook passes corrupted legacy args through unchanged", async () => {
        const hook = createToolExecuteBeforeHook({ fpeResolve: deps() });
        const output = { args: { command: "9•⸱66•⸱4586‣‣5" } };
        await hook({ tool: "bash", sessionID: "ses_fpe_lookup" }, output);
        expect(output.args).toEqual({ command: "9•⸱66•⸱4586‣‣5" });
    });

    it("hook never blocks a call on resolver internals failure", async () => {
        const broken = {
            lookupOriginal: () => {
                throw new Error("db exploded");
            },
            maxTag: () => 100,
        };
        const hook = createToolExecuteBeforeHook({ fpeResolve: broken });
        const token = renderDropToken(8, KEY);
        const output = { args: { command: token } };
        await hook({ tool: "bash", sessionID: "ses_fpe_lookup" }, output);
        expect(output.args).toEqual({ command: token });
    });
});
