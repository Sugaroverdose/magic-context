import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	ORACLE_WIRE_WHITELIST,
	canonicalizeProviderBody,
	committedWhitelistNames,
	firstDiffByte,
	type WhitelistRule,
} from "./normalization";

/**
 * The oracle whitelist law (ledger Class 6; plan unit 1: "whitelist law with
 * silent-addition rogue"). Enforced properties:
 * 1. Table hygiene: every committed rule names a producer and reason — a rule
 *    without a named producer is exactly the "it varies" admission the dispatch
 *    bans.
 * 2. Silent-addition refusal (planted rogue): a rule name used without a
 *    committed table entry reddens with the law text.
 * 3. Non-vacuity on the table path (N3): a committed test-scoped rule actually
 *    rewrites bytes through the same loader the compare site uses.
 * 4. Unpatched-surface obligations (N2) stay recorded in source as a comment
 *    block; deleting the record reddens this file.
 */
const NORMALIZATION_SOURCE = readFileSync(join(import.meta.dir, "normalization.ts"), "utf8");

describe("oracle whitelist law", () => {
	it("hygiene: every committed rule names its producer and reason", () => {
		for (const rule of ORACLE_WIRE_WHITELIST) {
			expect(rule.name.length).toBeGreaterThan(0);
			expect(rule.producer.length).toBeGreaterThan(0);
			expect(rule.reason.length).toBeGreaterThan(0);
		}
	});

	it("planted rogue: a non-committed rule name reddens with the oracle-whitelist-law text", () => {
		expect(() =>
			canonicalizeProviderBody('{"model":"mock-sonnet","messages":[]}', ["rogue-rule-not-in-table"]),
		).toThrow("oracle-whitelist-law");
	});

	it("names are unique in the committed table", () => {
		const names = ORACLE_WIRE_WHITELIST.map((rule) => rule.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("N3: a committed test-scoped rule rewrites through the same loader path", () => {
		const rule: WhitelistRule = {
			name: "test-scoped-oracle-nonce",
			producer: "oracle-determinism law fixture (test-scoped registration)",
			reason: "proves the apply path rewrites the named scalar rather than passing bytes through",
			applies: (key, value) => key === "oracle_nonce" && typeof value === "string",
		};
		const table = ORACLE_WIRE_WHITELIST as unknown as WhitelistRule[];
		table.push(rule);
		try {
			// The same entry point the compare site uses: names resolved from the
			// committed table, rule applied by getWhitelistRule.
			const raw = JSON.stringify({ model: "mock-sonnet", oracle_nonce: "abc123", messages: [] });
			const canonical = canonicalizeProviderBody(raw, committedWhitelistNames());
			expect(canonical).toContain(`<rule:${rule.name}>`);
			expect(canonical).not.toContain("abc123");
			expect(firstDiffByte(raw, canonical)).not.toBeNull();
		} finally {
			const index = table.indexOf(rule);
			if (index >= 0) table.splice(index, 1);
		}
		expect(ORACLE_WIRE_WHITELIST.length).toBe(0);
	});

	it("first-diff detector is real", () => {
		expect(firstDiffByte("abc", "abcd")).toBe(3);
		expect(firstDiffByte("abc", "abc")).toBeNull();
	});

	it("N3: the compare site consumes only committedWhitelistNames()", () => {
		const compareSource = readFileSync(
			join(import.meta.dir, "../../../tests/oracle-determinism.test.ts"),
			"utf8",
		);
		// No second rule-name source at the compare site: the committed table is
		// reached only through committedWhitelistNames().
		expect(compareSource).not.toContain("ORACLE_WIRE_WHITELIST");
		const callSites = compareSource.match(/canonicalizeProviderBody\s*\(/g) ?? [];
		const pairedWithCommitted = compareSource.match(
			/canonicalizeProviderBody\s*\([^\n]*committedWhitelistNames\(\)/g,
		) ?? [];
		expect(callSites.length).toBeGreaterThan(0);
		expect(pairedWithCommitted.length).toBe(callSites.length);
	});

	it("N2: the unpatched-surface obligations remain recorded in source", () => {
		expect(NORMALIZATION_SOURCE).toContain("ORACLE-UNPATCHED-SURFACES");
		expect(NORMALIZATION_SOURCE).toContain("crypto.randomUUID");
		expect(NORMALIZATION_SOURCE).toContain("cwd");
		expect(NORMALIZATION_SOURCE).toContain("two-boot raw");
		expect(NORMALIZATION_SOURCE).toContain("OC2");
		expect(NORMALIZATION_SOURCE).toContain("Responses");
		expect(NORMALIZATION_SOURCE).toMatch(/whitelist rule or patch/);
	});
});
