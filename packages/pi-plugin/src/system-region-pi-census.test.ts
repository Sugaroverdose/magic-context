import { describe, expect, it } from "bun:test";
import {
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;

function walk(dir: string): Array<{ rel: string; full: string }> {
	const out: Array<{ rel: string; full: string }> = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
			out.push({ rel: full.slice(SRC.length + 1), full });
	}
	return out;
}

describe("pi region contract: named-member census (stage P / P2)", () => {
	it("every production file reading cached_m0_bytes is a named member", () => {
		// Stage P2 (design §23): Pi is a serving lane. Readers of the shared
		// column (either spelling) must be exactly the discriminated set; a
		// new un-named reader fails here until its discrimination is reviewed.
		const ALLOWED: ReadonlyMap<string, string> = new Map([
			[
				"context-handler.ts",
				"comparison/coverage operands only: firstRenderBust region-aware shape check (isSystemRegionBytes, §23 D7), m0 coverage guard (null → -1), foldBustsServedPrefix before/after fold-byte comparison, and the compaction-transition in-memory baseline invalidation (nulls the local sessionMeta copy, not the DB); the handler never decodes column bytes as text and never persists them — all writes route through the fold lane",
			],
			[
				"dialogs/status-dialog.ts",
				"display-only breakdown; region rows decoded through the funnel reader for display (§23 D11), never served",
			],
			[
				"inject-compartments-pi.ts",
				"fold module: installs via the rotation funnel inside the boundary transaction (§23 D4); head-lane row reader nulls region rows; trim uses the fold-co-resident boundary (D6)",
			],
			[
				"system-prompt.ts",
				"serve path: appends the funnel-decoded region after the host bytes in the watched system channel; hash covers host bytes only (§23 D2/D3); corrupt rows declined by name",
			],
		]);
		const offenders: string[] = [];
		for (const { rel, full } of walk(SRC)) {
			const text = readFileSync(full, "utf8");
			if (!text.includes("cached_m0_bytes") && !text.includes("cachedM0Bytes"))
				continue;
			if (!ALLOWED.has(rel)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	// Stage P2 (design §23 D4): rotation is the boundary transaction (L0
	// single writer) and Pi joins as its SECOND named production caller —
	// exactly one file may invoke the executor, inside materializeM0Pi's
	// BEGIN IMMEDIATE. Raw region writes (writeSystemRegion /
	// clearSystemRegion) and hand-constructed sentinels remain forbidden in
	// Pi production files: a second writer of one column means two baselines.
	const NAMED_ROTATION_CALLERS: ReadonlyMap<string, string> = new Map([
		[
			"inject-compartments-pi.ts",
			"fold install/rotation via executeSystemRegionRotation in the boundary transaction (second named caller, §23 D4)",
		],
	]);
	const FORBIDDEN = [
		"writeSystemRegion",
		"clearSystemRegion",
		"mc:system-region",
	];
	function censusWriteOffenders(): string[] {
		const offenders: string[] = [];
		for (const { rel, full } of walk(SRC)) {
			const text = readFileSync(full, "utf8");
			for (const token of FORBIDDEN) {
				if (text.includes(token)) offenders.push(`${rel}: ${token}`);
			}
			if (
				text.includes("executeSystemRegionRotation") &&
				!NAMED_ROTATION_CALLERS.has(rel)
			) {
				offenders.push(`${rel}: executeSystemRegionRotation (un-named caller)`);
			}
		}
		return offenders;
	}

	it("region writes happen only through the named rotation caller — raw region writers stay dead", () => {
		expect(censusWriteOffenders()).toEqual([]);
	});

	it("the region capability is decided exactly once at boot and threaded thereafter (F7, D1)", () => {
		// §23 D1 is a boot-once law: a second isSystemRegionLane call site —
		// especially a per-pass re-derivation inside a hook (which would
		// re-read live config and split one session across two lane
		// truths) — must redden here, not drift silently.
		const callers: string[] = [];
		let indexCalls = 0;
		for (const { rel, full } of walk(SRC)) {
			const text = readFileSync(full, "utf8");
			const calls = (text.match(/\bisSystemRegionLane\s*\(/g) ?? []).length;
			// The import statement carries no call parenthesis; count only
			// call expressions.
			if (calls > 0) callers.push(rel);
			if (rel === "index.ts") indexCalls = calls;
		}
		expect(callers).toEqual(["index.ts"]);
		expect(indexCalls).toBe(1);
	});

	it("control: a planted second call site reddens the boot-once law", () => {
		const rogue = join(SRC, "__census_rogue_decider.ts");
		writeFileSync(
			rogue,
			'import { isSystemRegionLane } from "@magic-context/core/config/system-region-lane";\nexport const perPass = (cfg: unknown) => isSystemRegionLane(cfg as never);\n',
		);
		try {
			const callers: string[] = [];
			for (const { rel, full } of walk(SRC)) {
				if (
					(readFileSync(full, "utf8").match(/\bisSystemRegionLane\s*\(/g) ?? [])
						.length > 0
				)
					callers.push(rel);
			}
			expect(callers).toContain("__census_rogue_decider.ts");
		} finally {
			rmSync(rogue, { force: true });
		}
	});

	it("control: a planted rogue rotation caller and a raw writer both redden the census", () => {
		const rogueRotation = join(SRC, "__census-rogue-rotation.ts");
		const rogueWriter = join(SRC, "__census-rogue-writer.ts");
		writeFileSync(
			rogueRotation,
			'import { executeSystemRegionRotation } from "@magic-context/core/features/magic-context/system-region";\nexport const f = executeSystemRegionRotation;\n',
		);
		writeFileSync(
			rogueWriter,
			'import { writeSystemRegion } from "@magic-context/core/features/magic-context/system-region";\nexport const g = writeSystemRegion;\n',
		);
		try {
			const found = censusWriteOffenders();
			expect(found.some((o) => o.includes("__census-rogue-rotation"))).toBe(
				true,
			);
			expect(found.some((o) => o.includes("__census-rogue-writer"))).toBe(true);
		} finally {
			rmSync(rogueRotation, { force: true });
			rmSync(rogueWriter, { force: true });
		}
		// Removed plants must not leave residue reddening the steady law.
		expect(censusWriteOffenders()).toEqual([]);
	});
});
