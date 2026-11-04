import { describe, expect, it } from "bun:test";
import {
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";

const SRC = import.meta.dir;

// H3 (round 3): the Pi census joins the SHARED zone set (#2665) — the same
// production surface the OpenCode-1 eraser census walks, Pi side: src plus
// the pi-plugin runtime scripts tree (benchmarks, probes, generators —
// writable code that can open context.db). Walking only src/ left the
// scripts zone census-invisible; membership is asserted, not assumed: both
// canonical zones must be present on disk and carry production files, or
// the law fails naming the zone (G3 form).
const PI_CENSUS_ZONES: ReadonlyArray<{ dir: string; prefix: string }> = [
	{ dir: SRC, prefix: "" },
	{ dir: join(SRC, "..", "scripts"), prefix: "scripts/" },
];

function walk(root: string, prefix: string, dir = root): Array<{ rel: string; full: string }> {
	const out: Array<{ rel: string; full: string }> = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) out.push(...walk(root, prefix, full));
		else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
			out.push({ rel: prefix + relative(root, full), full });
	}
	return out;
}

function walkPiCensusZones(
	zones: ReadonlyArray<{ dir: string; prefix: string }> = PI_CENSUS_ZONES,
): Array<{ rel: string; full: string }> {
	const out: Array<{ rel: string; full: string }> = [];
	const issues: string[] = [];
	// Canonical membership (G3 lesson): a zone dropped from the passed list
	// must redden by NAME, not silently shrink the census.
	for (const canonical of PI_CENSUS_ZONES) {
		if (!zones.some((z) => z.prefix === canonical.prefix))
			issues.push(`zone absent from roots: ${canonical.prefix || "src/"}`);
	}
	for (const zone of zones) {
		if (!statSync(zone.dir, { throwIfNoEntry: false })?.isDirectory()) {
			issues.push(`zone absent: ${zone.prefix || "src/"}`);
			continue;
		}
		const files = walk(zone.dir, zone.prefix);
		if (files.length === 0)
			issues.push(`zone walked 0 production files: ${zone.prefix || "src/"}`);
		out.push(...files);
	}
	expect(issues, "pi census zone floors").toEqual([]);
	return out;
}


// Stage P2 (design §23): Pi is a serving lane. Readers of the shared
// column (either spelling) must be exactly the discriminated set; a new
// un-named reader fails here until its discrimination is reviewed. H3
// (round 3): the scan covers the SHARED Pi zone set (#2665) — src plus the
// runtime scripts tree — not src alone.
const ALLOWED_READERS: ReadonlyMap<string, string> = new Map([
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

function censusReaderOffenders(): string[] {
	const offenders: string[] = [];
	for (const { rel, full } of walkPiCensusZones()) {
		const text = readFileSync(full, "utf8");
		if (!text.includes("cached_m0_bytes") && !text.includes("cachedM0Bytes"))
			continue;
		if (!ALLOWED_READERS.has(rel)) offenders.push(rel);
	}
	return offenders;
}

describe("pi region contract: named-member census (stage P / P2)", () => {
	it("every production file reading cached_m0_bytes is a named member", () => {
		expect(censusReaderOffenders()).toEqual([]);
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
		for (const { rel, full } of walkPiCensusZones()) {
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

	// G1 (round 2): the boot-once census is the bare-identifier HOLDER set,
	// not a call-paren count. An aliased import (`import { isSystemRegionLane
	// as lane }`) or a const-rebind (`const f = isSystemRegionLane`)
	// re-derives the capability while hiding from a `\s*\(` regex; any
	// occurrence of the name outside its (out-of-tree) definition must name
	// its file and lands on this list.
	function isSystemRegionLaneHolders(): string[] {
		const holders: string[] = [];
		for (const { rel, full } of walkPiCensusZones()) {
			if (/\bisSystemRegionLane\b/.test(readFileSync(full, "utf8")))
				holders.push(rel);
		}
		return holders;
	}

	it("the region capability is decided exactly once at boot and threaded thereafter (F7, D1)", () => {
		// §23 D1 is a boot-once law: a second capability holder — especially
		// a per-pass re-derivation inside a hook (which would re-read live
		// config and split one session across two lane truths) — must redden
		// here, not drift silently. The one holder (index.ts) must hold
		// exactly one call expression: the boot resolution that feeds the
		// threaded boolean.
		expect(isSystemRegionLaneHolders()).toEqual(["index.ts"]);
		const indexText = readFileSync(join(SRC, "index.ts"), "utf8");
		expect((indexText.match(/\bisSystemRegionLane\s*\(/g) ?? []).length).toBe(
			1,
		);
	});

	it("control: alias and rebind plants redden the boot-once law (G1)", () => {
		// Mechanism attacks, each shape invisible to the pre-G1 call-paren
		// count: (1) aliased import + aliased per-pass call; (2) const
		// rebind + bound call. Each must surface as an extra holder; removal
		// regreens.
		const rogueAlias = join(SRC, "__census_rogue_alias_lane.ts");
		const rogueRebind = join(SRC, "__census_rogue_rebind_lane.ts");
		writeFileSync(
			rogueAlias,
			'import { isSystemRegionLane as lane } from "@magic-context/core/config/system-region-lane";\nexport const perPass = (cfg: unknown) => lane(cfg as never);\n',
		);
		let holders = isSystemRegionLaneHolders();
		expect(holders).toContain("__census_rogue_alias_lane.ts");
		expect(holders).not.toEqual(["index.ts"]);
		rmSync(rogueAlias, { force: true });
		writeFileSync(
			rogueRebind,
			'import { isSystemRegionLane } from "@magic-context/core/config/system-region-lane";\nconst f = isSystemRegionLane;\nexport const late = (cfg: unknown) => f(cfg as never);\n',
		);
		holders = isSystemRegionLaneHolders();
		expect(holders).toContain("__census_rogue_rebind_lane.ts");
		rmSync(rogueRebind, { force: true });
		// Steady state after removals.
		expect(isSystemRegionLaneHolders()).toEqual(["index.ts"]);
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

	it("control: scripts-zone plants redden the census; a dropped zone fails the floor by name (H3)", () => {
		// The pre-H3 census walked src/ only: a cached_m0_bytes reader or a
		// raw region writer in the runtime scripts tree — production code
		// that can open context.db (#2665) — stayed invisible. Plants live
		// OUTSIDE src/, so they also demonstrate the old walk's blindness.
		const scriptsDir = join(SRC, "..", "scripts");
		const rogueReader = join(scriptsDir, "__census-rogue-reader.ts");
		const rogueWriter = join(scriptsDir, "__census-rogue-writer.ts");
		expect(rogueReader.startsWith(join(SRC, "subdir")) || rogueReader.startsWith(SRC + "/")).toBe(
			false,
		);
		writeFileSync(
			rogueReader,
			'export const f = (db: { prepare: (q: string) => unknown }, s: string) => db.prepare("SELECT cached_m0_bytes FROM session_meta WHERE session_id = ?").get(s);\n',
		);
		writeFileSync(
			rogueWriter,
			'import { writeSystemRegion } from "@magic-context/core/features/magic-context/system-region";\nexport const g = writeSystemRegion;\n',
		);
		try {
			expect(
				censusReaderOffenders().some(
					(o) => o.startsWith("scripts/") && o.includes("__census-rogue-reader"),
				),
			).toBe(true);
			expect(
				censusWriteOffenders().some(
					(o) => o.startsWith("scripts/") && o.includes("__census-rogue-writer"),
				),
			).toBe(true);
		} finally {
			rmSync(rogueReader, { force: true });
			rmSync(rogueWriter, { force: true });
		}
		// Removal regreens both censuses.
		expect(censusReaderOffenders()).toEqual([]);
		expect(censusWriteOffenders()).toEqual([]);
		// Zone floor: dropping scripts from the walked roots must redden by
		// NAME against the canonical set, not silently shrink coverage.
		expect(() => walkPiCensusZones([PI_CENSUS_ZONES[0]])).toThrow(/scripts\//);
	});
});
