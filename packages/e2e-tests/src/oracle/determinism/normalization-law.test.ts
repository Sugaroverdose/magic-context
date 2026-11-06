import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
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

/**
 * The live compare homes since the unit-2 leg-runner extraction (8fec40801):
 * every canonicalizeProviderBody call must live in one of these files and pair
 * with committedWhitelistNames(). The set is ENFORCED, not decorative: the
 * census walks the whole oracle area and any call site in a non-enumerated
 * file is an offender (control plant (b) witnesses exactly that).
 */
const COMPARE_FILES: readonly string[] = [
	join(import.meta.dir, "../../../tests/oracle-determinism.test.ts"),
	join(import.meta.dir, "../classify/leg-runner.ts"),
];
/** The committed table path: definition + its own law (self-references). */
const TABLE_PATH_NAMES: readonly string[] = ["normalization.ts", "normalization-law.test.ts"];

function walkOracleArea(): string[] {
	const files: string[] = [];
	const walk = (dir: string): void => {
		for (const dirent of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, dirent.name);
			if (dirent.isDirectory()) walk(path);
			else if (dirent.isFile() && dirent.name.endsWith(".ts")) files.push(path);
		}
	};
	walk(join(import.meta.dir, ".."));
	const testsDir = join(import.meta.dir, "../../../tests");
	for (const name of readdirSync(testsDir)) {
		if (/^oracle-.*\.test\.ts$/.test(name)) files.push(join(testsDir, name));
	}
	return files;
}

/** Census over source texts (parameterized so committed control plants can drive it). */
function censusCompareFiles(sources: Map<string, string>): { offenders: string[]; totalCalls: number } {
	const offenders: string[] = [];
	let totalCalls = 0;
	for (const [file, source] of sources) {
		if (TABLE_PATH_NAMES.includes(basename(file))) continue;
		if (source.includes("ORACLE_WIRE_WHITELIST")) {
			offenders.push(`${file}: consumes ORACLE_WIRE_WHITELIST outside the committed table path`);
		}
		const calls = source.match(/canonicalizeProviderBody\s*\(/g) ?? [];
		if (calls.length === 0) continue;
		if (!COMPARE_FILES.includes(file)) {
			offenders.push(`${file}: canonicalizeProviderBody call site in a non-enumerated oracle file`);
			continue;
		}
		const paired = source.match(/canonicalizeProviderBody\s*\([^\n]*committedWhitelistNames\(\)/g) ?? [];
		if (paired.length !== calls.length) {
			offenders.push(
				`${file}: ${calls.length} canonicalizeProviderBody call sites, only ${paired.length} paired with committedWhitelistNames()`,
			);
		}
		totalCalls += calls.length;
	}
	return { offenders, totalCalls };
}

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

	it("N3: every canonicalizeProviderBody call site is an enumerated compare file paired with committedWhitelistNames()", () => {
		const area = walkOracleArea();
		// Membership floors: both enumerated compare homes exist in the walked
		// area — a moved-away file reddens by name, not silently zero.
		for (const file of COMPARE_FILES) expect(area).toContain(file);
		const sources = new Map(area.map((file) => [file, readFileSync(file, "utf8")]));
		const { offenders, totalCalls } = censusCompareFiles(sources);
		expect(offenders).toEqual([]);
		expect(totalCalls).toBeGreaterThan(0);
	});

	it("N3 control plants (committed witnesses): unpaired call in a compare file and any call in a non-enumerated oracle file both redden the census", () => {
		const area = walkOracleArea();
		const sources = new Map(area.map((f) => [f, readFileSync(f, "utf8")]));
		const baseline = censusCompareFiles(sources);
		expect(baseline.offenders).toEqual([]);

		// (a) the leg-runner compare call without the committedWhitelistNames arg.
		const legRunnerPath = join(import.meta.dir, "../classify/leg-runner.ts");
		const legRunner = readFileSync(legRunnerPath, "utf8");
		const unpaired = legRunner.replace(
			"canonicalizeProviderBody(raw, committedWhitelistNames())",
			'canonicalizeProviderBody(raw, ["silent-addition-rogue"])',
		);
		expect(unpaired).not.toBe(legRunner); // the plant must actually land
		const plantA = censusCompareFiles(new Map([...sources, [legRunnerPath, unpaired]]));
		expect(plantA.offenders.join("\n")).toContain("paired with committedWhitelistNames()");

		// (b) a call planted in an oracle file the set does not enumerate: the
		// census reddens on set membership, proving the set is enforced.
		const comparePath = join(import.meta.dir, "../classify/compare.ts");
		expect(area).toContain(comparePath);
		expect(COMPARE_FILES).not.toContain(comparePath);
		const plantedCompare = `${readFileSync(comparePath, "utf8")}\nexport const rogueCompare = (raw: string): string => canonicalizeProviderBody(raw, committedWhitelistNames());\n`;
		const plantB = censusCompareFiles(new Map([...sources, [comparePath, plantedCompare]]));
		expect(plantB.offenders.join("\n")).toContain("non-enumerated oracle file");
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
