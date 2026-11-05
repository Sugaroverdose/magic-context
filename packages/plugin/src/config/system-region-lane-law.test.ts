/// <reference types="bun-types" />

// Unit 1 Step 4 laws: the lane predicate is an unconditional constant and
// `transform_mode: "rust"` is a named boot refusal (assembly-v2 plan Unit 1,
// migration plan Task 4 Step 4, spec §21 amendment).
//
// Governance (owner ruling 2026-11-05, plan:20): compaction-off gets no
// carve-out — region serve like everything else; `isSystemRegionLane` →
// constant true; `transform_mode: "rust"` → named boot refusal (standing
// shelve). The predicate is a pure constant: reading ANY config field would
// reopen the per-site re-derivation the one-decider rule (L0 spirit) forbids.
// The rust refusal therefore cannot live inside the predicate — it fires at
// the config-resolution funnel, before the lane is ever consulted.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSystemRegionLane } from "./system-region-lane";
import { resolveTransformMode } from "./transform-mode";

const PKG = join(import.meta.dir, "..", "..");

describe("system-region lane predicate is a pure constant (Unit 1 Step 4)", () => {
    const TABLE: Array<{ name: string; config: Record<string, unknown> }> = [
        { name: "defaults", config: {} },
        {
            name: "ts explicit + compaction on",
            config: { transform_mode: "ts", compaction: { enabled: true } },
        },
        { name: "compaction off (legacy false)", config: { compaction: false } },
        { name: "compaction off (object)", config: { compaction: { enabled: false } } },
        { name: "compaction null", config: { compaction: null } },
    ];
    for (const row of TABLE) {
        it(`isSystemRegionLane: ${row.name} -> true`, () => {
            expect(isSystemRegionLane(row.config)).toBe(true);
        });
    }

    // The pure-constant law is structural: the predicate body must not read
    // any config field. A body that touches `config` re-opens conditional
    // service (the retired compaction-off / rust arms) without changing the
    // exported signature.
    it("the predicate source reads no config field (pure constant, structural)", () => {
        const source = readFileSync(join(PKG, "src/config/system-region-lane.ts"), "utf8");
        const body = source.slice(source.indexOf("export function isSystemRegionLane"));
        expect(body).not.toMatch(/config\s*\./);
        expect(body).not.toMatch(/config\s*\[/);
        expect(body).not.toMatch(/config\s*\?\?/);
    });
});

describe("transform_mode rust is a named boot refusal (Unit 1 Step 4)", () => {
    const TABLE: Array<{ name: string; userTierHasSubc: boolean; compactionEnabled: boolean }> = [
        { name: "user-level subc present", userTierHasSubc: true, compactionEnabled: true },
        { name: "no user-level subc", userTierHasSubc: false, compactionEnabled: true },
        { name: "compaction off", userTierHasSubc: true, compactionEnabled: false },
        { name: "neither", userTierHasSubc: false, compactionEnabled: false },
    ];
    for (const row of TABLE) {
        it(`rust -> ts with a named refusal: ${row.name}`, () => {
            const result = resolveTransformMode({
                configured: "rust",
                userTierHasSubc: row.userTierHasSubc,
                compactionEnabled: row.compactionEnabled,
            });
            expect(result.mode).toBe("ts");
            expect(result.warnings.length).toBeGreaterThan(0);
            const joined = result.warnings.join("\n");
            // Named refusal: names the mode, the product decision, and the
            // shelve — not a silent downgrade.
            expect(joined).toMatch(/rust/i);
            expect(joined).toMatch(/refus/i);
        });
    }

    it("ts is unaffected by the refusal", () => {
        expect(
            resolveTransformMode({
                configured: "ts",
                userTierHasSubc: false,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "ts", warnings: [] });
    });

    // Anti-vacuity: the refusal is the only rust outcome. The resolver must
    // have no path that returns "rust" — a resurrected arm would make the
    // constant-true predicate serve MC region bytes beside the module's own
    // composition (double baseline; #2704 exclusion).
    it("no input yields mode rust (structural)", () => {
        const source = readFileSync(join(PKG, "src/config/transform-mode.ts"), "utf8");
        const returns = [...source.matchAll(/return\s*\{[^}]*mode:\s*"rust"[^}]*\}/g)].map(
            (m) => m[0],
        );
        expect(returns).toEqual([]);
    });
});
