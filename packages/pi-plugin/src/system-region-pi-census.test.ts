import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

describe("pi region contract: named-member census (stage P)", () => {
	it("every production file reading cached_m0_bytes is a named member", () => {
		// Stage P: the Pi lane ships the region OFF (v1-TS-only, C2), so its
		// readers must be exactly the discriminated set. A new un-named
		// reader of the shared column fails here until its sentinel
		// discrimination is reviewed and it is listed with a reason.
		const ALLOWED: ReadonlyMap<string, string> = new Map([
			[
				"context-handler.ts",
				"firstRenderBust derives from the pass-snapshot row, which nulls region rows at the reader",
			],
			[
				"dialogs/status-dialog.ts",
				"display-only breakdown; decode helper strips sentinel-led bytes (F6)",
			],
			[
				"inject-compartments-pi.ts",
				"head-lane module: row reader nulls region rows (stage P), decode/markers/replay refuse, trim refuses (H3)",
			],
		]);
		const offenders: string[] = [];
		for (const { rel, full } of walk(SRC)) {
			if (!readFileSync(full, "utf8").includes("cached_m0_bytes")) continue;
			if (!ALLOWED.has(rel)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
	});

	it("the Pi lane executes no region rotation and writes no region bytes", () => {
		// Rotation is the OpenCode-1-TS boundary transaction (L0 single
		// writer). Pi must never import the executors or hand-construct the
		// sentinel: a Pi-side rotation or raw region write means two writers
		// of one column.
		const FORBIDDEN = [
			"executeSystemRegionRotation",
			"writeSystemRegion",
			"clearSystemRegion",
			"mc:system-region",
		];
		const offenders: string[] = [];
		for (const { rel, full } of walk(SRC)) {
			const text = readFileSync(full, "utf8");
			for (const token of FORBIDDEN) {
				if (text.includes(token)) offenders.push(`${rel}: ${token}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
