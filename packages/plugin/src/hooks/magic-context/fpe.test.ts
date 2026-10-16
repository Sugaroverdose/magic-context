import { describe, expect, it } from "bun:test";
import {
    deriveKey,
    fpeDecrypt,
    fpeEncrypt,
    fpeGate,
    isFpeTokenCandidate,
    renderDropToken,
    stripFillers,
} from "./fpe";

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
