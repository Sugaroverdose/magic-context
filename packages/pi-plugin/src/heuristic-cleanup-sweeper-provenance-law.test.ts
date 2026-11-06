import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Parity law (N2): every Pi sweeper arm declares its provenance.
 *
 * The R11 applyNewToolDrop source split picks the bash-only-carrier policy
 * (non-bash → skeleton_real) only when the caller declares source:"sweeper",
 * and the registry toolName rides with it. v1 9c1520810:heuristic-cleanup-pi.ts
 * gates ALL THREE automatic arms — emergency (:440), stale ctx_reduce strip
 * (:499), fingerprint dedup (:613) — per 3430b4ead ("Gate all three arms —
 * emergency, stale-reduce strip, fingerprint dedup — as sweeper with the
 * registry tool name, mirroring the plugin sites"). The v2 seed kept the
 * provenance only at the emergency site, so the stale-reduce and dedup arms
 * fell through to the legacy drop() full-released shape for non-bash swept
 * calls. Precedent law: 5a9faa0c5 ("emergency reclaim declares sweeper
 * provenance").
 */
const SRC = readFileSync(join(import.meta.dir, "heuristic-cleanup-pi.ts"), "utf8");
const codeOnly = SRC.split("\n")
	.filter((line) => !line.trim().startsWith("//"))
	.join("\n");

function callSites(): string[] {
	const needle = "applyNewToolDrop(target, {";
	const sites: string[] = [];
	let from = 0;
	for (;;) {
		const at = codeOnly.indexOf(needle, from);
		if (at === -1) break;
		const end = codeOnly.indexOf("});", at);
		expect(end).toBeGreaterThan(at);
		sites.push(codeOnly.slice(at, end + 3));
		from = end + 3;
	}
	return sites;
}

describe("Pi sweeper provenance law (N2)", () => {
	test("the cleanup pass drives exactly three applyNewToolDrop arms", () => {
		expect(callSites()).toHaveLength(3);
	});

	test("every sweeper arm declares source sweeper and the registry toolName", () => {
		const sites = callSites();
		expect(sites).toHaveLength(3);
		for (const [index, site] of sites.entries()) {
			expect(site, `applyNewToolDrop arm #${index + 1}`).toContain('source: "sweeper"');
			expect(site, `applyNewToolDrop arm #${index + 1}`).toContain("toolName: tag.toolName");
		}
	});
});
