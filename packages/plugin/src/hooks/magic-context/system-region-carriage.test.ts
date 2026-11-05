/// <reference types="bun-types" />

/**
 * Head-era carriage deletion census (assembly-v2 Unit 1, Step 3; spec §11,
 * GLM-corrected).
 *
 * The frozen system-region lane is the only history carriage: panels + delta
 * live in the sentinel region row and serve inside system[0]
 * (system-prompt-hash.ts). The synthetic-head carriage — prependM0M1Messages,
 * the m[1] replay/soft-refresh pair, the head-completeness readers, the
 * syntheticHead flags/walks, the mural PNG file part — is DELETED. This law
 * is the census that keeps it dead: for every deletion class it walks the
 * plugin production tree (packages/plugin/src + packages/plugin/scripts,
 * design §25.4 walk shape, #2720 named deny-list) and demands zero holders,
 * plus per-class planted rogue witnesses proving each pattern actually bites
 * (#2644: attack the mechanism, not the happy path).
 *
 * Adjudicated floor rows (spec §11 dispositions, plan Unit 1 Files):
 * - `src/v2/hooks/payload.ts` — the OpenCode-2 adapter's HEAD_IDS mint reads
 *   `message.info.syntheticHead` on host-supplied rows. Out-of-contract
 *   (adapter-side foreign-row bookkeeping); it must not redden the census and
 *   must stay the ONLY production reader of the flag.
 * - Mural: the text block renders INSIDE the region panels (region-render,
 *   golden-pinned); the PNG file part died with the carriage it rode
 *   (named ruling — region serving is system[0]-text-only, the lane never
 *   served the image). The co-persisted identity columns
 *   (cached_m0_mural_data_url/_hash) stay: they are rotation markers
 *   (#2626 no-new-persistence, #2618 prefer existing columns).
 * - Pi keeps its own head machinery in packages/pi-plugin (its carriage
 *   deletion is the Stage P2 twin, tracked in PARITY.md); this census is
 *   plugin-package scoped by design.
 *
 * Test-surface classes: deleted symbols must not be referenced by plugin
 * test files either (the six pin sets were re-expressed, not silently
 * dropped); stray-synthetic DEFENSE fixtures (foreign rows, LKG leftovers)
 * remain allowed in the adjudicated walk/trim test files.
 */

import { describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { createTestTempDir } from "../../shared/test-temp-dir";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const WALK_ROOTS = [join(PKG_ROOT, "src"), join(PKG_ROOT, "scripts")];
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".codegraph"]);
const TS_EXT = /\.(ts|tsx|mts|cts|mjs|cjs)$/;

function collectFiles(dir: string, out: string[]): void {
    // Named deny-list, never skip-all-dot-dirs (#2720).
    let entries: string[];
    try {
        entries = require("node:fs").readdirSync(dir, { withFileTypes: true }) as Array<{
            name: string;
            isDirectory(): boolean;
        }>;
    } catch {
        return;
    }
    for (const e of entries) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) collectFiles(full, out);
        else if (TS_EXT.test(e.name)) out.push(full);
    }
    out.sort();
}

interface ScanRow {
    rel: string;
    text: string;
}

function scan(
    testFiles: boolean,
    extraRoots: Array<{ dir: string; prefix: string }> = [],
): ScanRow[] {
    const rows: ScanRow[] = [];
    for (const { dir, prefix } of [
        ...WALK_ROOTS.map((d) => ({ dir: d, prefix: `${relative(PKG_ROOT, d)}/` })),
        ...extraRoots,
    ]) {
        const files: string[] = [];
        collectFiles(dir, files);
        for (const f of files) {
            if (!testFiles && f.endsWith(".test.ts")) continue;
            rows.push({
                rel: prefix + relative(dir, f),
                text: require("node:fs").readFileSync(f, "utf8"),
            });
        }
    }
    return rows;
}

function holders(rows: ScanRow[], pattern: RegExp): string[] {
    return rows.filter((r) => pattern.test(r.text)).map((r) => r.rel);
}

// Zone-membership floor (#2714): the two walked roots must contribute files;
// a dropped root fails the law by name, not silently zero.
describe("carriage deletion census: walk shape", () => {
    it("both production roots are present and walked", () => {
        for (const root of WALK_ROOTS) {
            const files: string[] = [];
            collectFiles(root, files);
            expect(files.length, `walked root ${root} returned no files`).toBeGreaterThan(0);
        }
    });
});

describe("carriage deletion census: production tree is headless", () => {
    const production = scan(false);

    const classes: Array<{ name: string; pattern: RegExp; floors?: string[] }> = [
        { name: "prependM0M1Messages", pattern: /\bprependM0M1Messages\b/ },
        { name: "replayCachedM1", pattern: /\breplayCachedM1\b/ },
        { name: "softRefreshCachedM1", pattern: /\bsoftRefreshCachedM1\b/ },
        { name: "hasCompleteCachedM0M1", pattern: /\bhasCompleteCachedM0M1\b/ },
        { name: "prepareCachedM0M1Replay", pattern: /\bprepareCachedM0M1Replay\b/ },
        { name: "syntheticHeadCount", pattern: /\bsyntheticHeadCount\b/ },
        { name: "isSyntheticHeadMessage", pattern: /\bisSyntheticHeadMessage\b/ },
        { name: "isSyntheticPrefixHead", pattern: /\bisSyntheticPrefixHead\b/ },
        {
            name: "syntheticHead carriage (mint/field)",
            pattern: /syntheticHead\s*[:?]/,
            // payload.ts: OpenCode-2 adapter HEAD_IDS mint (out-of-contract
            // host-row bookkeeping, spec §11 floor). self-tag-trial: a live
            // diagnostics harness that builds HEAD-shaped fixture rows to
            // measure model tag behavior; it emulates the host surface, it
            // is not the deleted carriage.
            floors: ["src/v2/hooks/payload.ts", "scripts/self-tag-trial/host-plugin.mjs"],
        },
    ];

    for (const cls of classes) {
        it(`${cls.name}: zero production holders`, () => {
            const found = holders(production, cls.pattern).filter(
                (f) => !(cls.floors ?? []).includes(f),
            );
            expect(found).toEqual([]);
        });
    }

    it("the only production readers of message.info.syntheticHead are the adjudicated floors", () => {
        // Both read shapes count: the direct member access and a narrowed-cast
        // read — the field lives outside the shared MessageInfo shape so the
        // adapter-local flag never re-enters the carriage vocabulary census.
        const readers = holders(production, /\.(?:info\s+as\s*\{[^}]*\}\s*\.\s*)?syntheticHead\b/);
        expect(readers).toEqual([
            "src/v2/hooks/payload.ts",
            "scripts/self-tag-trial/host-plugin.mjs",
        ]);
    });

    it("the region replay successor is present and wired (anti-vacuity)", () => {
        // Deleting prepareCachedM0M1Replay must not delete the replay itself:
        // the named region successor carries the boot-floor contract
        // (region-boot-law re-anchors onto it in the same commit family).
        const defs = holders(production, /\bfunction prepareRegionReplay\b/);
        expect(defs).toEqual(["src/hooks/magic-context/inject-compartments.ts"]);
        const callers = holders(production, /\bprepareRegionReplay\s*\(/).filter(
            (f) => !defs.includes(f),
        );
        expect(
            callers.every((f) => f === "src/hooks/magic-context/transform-postprocess-phase.ts"),
        ).toBe(true);
        expect(callers.length).toBeGreaterThan(0);
    });

    it("mural PNG carriage is dead; region-panel mural text and identity columns survive", () => {
        // Named ruling (spec §11 disposition): the PNG file part died with the
        // head carriage; the mural text block renders inside the region
        // panels; the persisted columns stay as rotation markers.
        // Scoped to the carriage file: an unrelated diagnostics script may
        // construct image-part fixtures freely (cereb-full-sync-probe.ts).
        const inject = production.find(
            (r) => r.rel === "src/hooks/magic-context/inject-compartments.ts",
        );
        expect(inject?.text).not.toMatch(/muralImage/);
        expect(inject?.text).not.toMatch(/image\/png/);
        const storage = production.find(
            (r) => r.rel === "src/features/magic-context/storage-meta-shared.ts",
        );
        expect(storage?.text).toContain("cached_m0_mural_data_url");
        expect(storage?.text).toContain("cached_m0_mural_hash");
        const regionRender = production.find(
            (r) => r.rel === "src/hooks/magic-context/region-render.ts",
        );
        expect(regionRender?.text).toMatch(/resolveMuralForM0/);
    });

    it("the never-empty floor constants are consumed only by the region producer", () => {
        // region-render owns the never-empty floors; the fold feeds the delta
        // placeholder into the trio (materializeM0) — both are region-era.
        const consumers = holders(production, /\bM0_EMPTY_BODY\b|\bM1_EMPTY_PLACEHOLDER\b/);
        expect(consumers).toEqual([
            "src/hooks/magic-context/inject-compartments.ts",
            "src/hooks/magic-context/region-render.ts",
        ]);
    });
});

describe("carriage deletion census: plugin test tree is re-expressed", () => {
    // Deleted-symbol references in tests are TS errors already; this class
    // pins the string level too (a renamed symbol cannot smuggle the carriage
    // vocabulary back in).
    const tests = scan(true).filter(
        (r) =>
            r.rel.endsWith(".test.ts") &&
            r.rel !== "src/hooks/magic-context/system-region-carriage.test.ts",
    );

    for (const symbol of [
        "prependM0M1Messages",
        "replayCachedM1",
        "softRefreshCachedM1",
        "hasCompleteCachedM0M1",
        "prepareCachedM0M1Replay",
        "syntheticHeadCount",
        "isSyntheticHeadMessage",
        "isSyntheticPrefixHead",
    ]) {
        it(`${symbol}: zero test references`, () => {
            expect(holders(tests, new RegExp(`\\b${symbol}\\b`))).toEqual([]);
        });
    }

    it("syntheticHead fixtures survive only as adjudicated stray-host witnesses", () => {
        // Re-expression, not deletion: the tail-hygiene and prefix-trim laws
        // keep hand-shaped id-less synthetic rows as FOREIGN/stray defense
        // (LKG leftovers, host-side junk). The rust-mode module-output
        // fixtures (transform-compaction-off) are adjudicated out by the
        // step-4 rust boot refusal and hold their witness until then.
        const allowed = new Set([
            "src/hooks/magic-context/tail-hygiene-walk.test.ts",
            "src/hooks/magic-context/prefix-trim-pure-replay.test.ts",
            "src/hooks/magic-context/prefix-trim-absent-boundary-adversarial.test.ts",
            "src/hooks/magic-context/transform-compaction-off.test.ts",
            // Adversarial forgeries: these fixtures plant the flag to prove the
            // postprocess replay splices (strip/reasoning) stay byte-correct on
            // host rows that carry the retired flag; the flag must stay inert.
            "src/hooks/magic-context/transform-postprocess-phase.test.ts",
        ]);
        const found = holders(tests, /syntheticHead\s*:/).filter((f) => !allowed.has(f));
        expect(found).toEqual([]);
    });
});

describe("carriage deletion census: planted rogues bite (controls)", () => {
    // One rogue per class; each must be flagged by the same pattern the
    // steady-state law uses, and the planted file must leave no residue.
    it("per-class planted rogues redden their class and nothing is exempt", () => {
        const rogues: Array<{ name: string; pattern: RegExp; file: string; body: string }> = [
            {
                name: "prependM0M1Messages",
                pattern: /\bprependM0M1Messages\b/,
                file: "rogue_prepend.ts",
                body: "export function prependM0M1Messages() { return 2; }",
            },
            {
                name: "replayCachedM1",
                pattern: /\breplayCachedM1\b/,
                file: "rogue_replay.ts",
                body: "function replayCachedM1() { return ''; } export { replayCachedM1 };",
            },
            {
                name: "softRefreshCachedM1",
                pattern: /\bsoftRefreshCachedM1\b/,
                file: "rogue_soft.ts",
                body: "function softRefreshCachedM1() { return {}; } export { softRefreshCachedM1 };",
            },
            {
                name: "hasCompleteCachedM0M1",
                pattern: /\bhasCompleteCachedM0M1\b/,
                file: "rogue_complete.ts",
                body: "export function hasCompleteCachedM0M1() { return true; }",
            },
            {
                name: "prepareCachedM0M1Replay",
                pattern: /\bprepareCachedM0M1Replay\b/,
                file: "rogue_replay_old.ts",
                body: "export function prepareCachedM0M1Replay() { return undefined; }",
            },
            {
                name: "syntheticHeadCount",
                pattern: /\bsyntheticHeadCount\b/,
                file: "rogue_shc.ts",
                body: "export interface S { syntheticHeadCount: number; }",
            },
            {
                name: "isSyntheticHeadMessage",
                pattern: /\bisSyntheticHeadMessage\b/,
                file: "rogue_walk.ts",
                body: "export function isSyntheticHeadMessage(m: unknown) { return !!m; }",
            },
            {
                name: "syntheticHead mint",
                pattern: /syntheticHead\s*[:?]/,
                file: "rogue_mint.ts",
                body: "const h = { info: { role: 'user', syntheticHead: true } }; export { h };",
            },
            {
                name: "mural PNG carriage",
                pattern: /mime:\s*"image\/png"/,
                file: "rogue_mural.ts",
                body: 'const part = { type: "file", mime: "image/png", url: "x" }; export { part };',
            },
        ];
        const dir = createTestTempDir("mc-carriage-rogue-").dir;
        try {
            for (const rogue of rogues) {
                const path = join(dir, rogue.file);
                writeFileSync(path, rogue.body, "utf8");
                const rows = scan(false, [{ dir, prefix: "planted/" }]).filter((r) =>
                    r.rel.startsWith("planted/"),
                );
                expect(
                    holders(rows, rogue.pattern),
                    `planted rogue ${rogue.file} must be flagged by class ${rogue.name}`,
                ).toContain(`planted/${rogue.file}`);
                rmSync(path, { force: true });
            }
            // Steady state after removals: no planted residue.
            const clean = scan(false, [{ dir, prefix: "planted/" }]).filter((r) =>
                r.rel.startsWith("planted/"),
            );
            expect(clean).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
