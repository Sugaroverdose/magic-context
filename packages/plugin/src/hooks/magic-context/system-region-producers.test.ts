/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..");

function walkTs(dir: string, prefix: string): Array<{ rel: string; full: string }> {
    const out: Array<{ rel: string; full: string }> = [];
    const walk = (d: string) => {
        for (const entry of readdirSync(d)) {
            const full = join(d, entry);
            if (statSync(full).isDirectory()) {
                if (!entry.startsWith(".")) walk(full);
                continue;
            }
            if (entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
                out.push({ rel: prefix + relative(dir, full), full });
        }
    };
    if (statSync(dir).isDirectory()) walk(dir);
    return out;
}

function productionTsFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                if (!entry.startsWith(".")) walk(full);
                continue;
            }
            if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
        }
    };
    walk(SRC_ROOT);
    return out;
}

/**
 * L0 — single writer, schedule-only. Exactly one mechanism may change bytes
 * MC contributes to the served wire: the boundary transaction (the fold /
 * rotation). Every other actor holds no write authority and may only enqueue
 * intent. This census enumerates the actors able to influence served bytes
 * and pins each row's legal path; a direct write outside a named actor fails
 * CI. Same enforcement form as the region-column sole-writer census.
 */
describe("system-region L0: per-actor producer census", () => {
    const files = productionTsFiles();
    const rel = (f: string) => relative(SRC_ROOT, f);
    const STORE = "features/magic-context/system-region.ts";
    const ALL_ZONE_FILES: Array<{ rel: string; full: string }> = [
        ...walkTs(SRC_ROOT, ""),
        ...walkTs(join(SRC_ROOT, "..", "scripts"), "scripts/"),
        ...walkTs(join(SRC_ROOT, "..", "..", "cli", "src"), "cli/"),
        ...walkTs(join(SRC_ROOT, "..", "..", "pi-plugin", "src"), "pi/"),
    ];
    const filesUsing = (pattern: RegExp) =>
        ALL_ZONE_FILES.filter(
            ({ rel, full }) => rel !== STORE && pattern.test(readFileSync(full, "utf8")),
        )
            .map(({ rel }) => rel)
            .sort();

    it("the rotation executor has exactly one production caller (the fold lane)", () => {
        expect(filesUsing(/executeSystemRegionRotation\(/)).toEqual([
            "hooks/magic-context/inject-compartments.ts",
        ]);
    });

    it("the region store's writer API is reachable only from named actors", () => {
        // Direct region writes bypassing the rotation executor are the L0
        // violation class. writeSystemRegion itself stays funnel-internal.
        expect(filesUsing(/writeSystemRegion\(/)).toEqual([]);
        expect(filesUsing(/clearSystemRegion\(/).sort()).toEqual([
            "cli/commands/migrate-session.ts",
            "features/magic-context/storage-clone.ts",
            "features/magic-context/storage-meta-shared.ts",
            "hooks/magic-context/compaction-off-transition.ts",
            "scripts/clone-session.ts",
        ]);
        expect(filesUsing(/clearAllSystemRegions\(/)).toEqual([
            "features/magic-context/migrations.ts",
        ]);
        expect(filesUsing(/clearSystemRegionsByProjectIdentity\(/)).toEqual([
            "features/magic-context/storage-identity-merge.ts",
        ]);
    });

    it("pending_ops is written only by the queue API, the boundary drain, the mode transition, clone, and named tools", () => {
        // F1/F5: the walk covers every zone that can open context.db.
        // Row-copies of already-queued intent (clone) are queue authority
        // carriers, not new intent; the schedule itself is read and applied
        // only inside the boundary permission. A new writer outside this set
        // is an actor with unauthorized schedule authority.
        const zoneFiles: Array<{ rel: string; full: string }> = [
            ...walkTs(SRC_ROOT, ""),
            ...walkTs(join(SRC_ROOT, "..", "scripts"), "scripts/"),
            ...walkTs(join(SRC_ROOT, "..", "..", "cli", "src"), "cli/"),
            ...walkTs(join(SRC_ROOT, "..", "..", "pi-plugin", "src"), "pi/"),
        ];
        // G4 honest boundary — what the regexes cannot see: dynamic
        // table-name VARIABLES (not ${...} interpolations), schema-qualified
        // forms (`main.pending_ops`), aliasing via views, and every file
        // outside the four walk roots (e2e-tests, dashboard TS). The
        // dynamic-${} arms below are captured by shape; a writer that hides
        // behind an indirect variable is a review-time defect the census
        // cannot promise to catch, same disclosure class as the Rust zone.
        const writers = zoneFiles
            .filter(({ full }) =>
                /(?:INSERT INTO|DELETE FROM|UPDATE)\s+pending_ops|INSERT INTO \$\{quoteIdentifier\(table\)\}|DELETE FROM \$\{[^}]*table[^}]*\}/i.test(
                    readFileSync(full, "utf8"),
                ),
            )
            .map(({ rel }) => rel)
            .sort();
        expect(writers).toEqual([
            "features/magic-context/compaction.ts",
            // G4: harness-twin relabel deletes over a STATIC rule table list
            // (session_projects, primer_candidates, transform_decisions —
            // pending_ops is not among them); the generic `${table}`
            // prepared statements are kept in the census because the shape,
            // not the current list, is what a future rule could target.
            "features/magic-context/opencode2-relabel.ts",
            "features/magic-context/storage-clone.ts",
            // G4: identity-merge row relocation — DELETE FROM
            // ${quoteIdentifier(table.name)} for the merged-away identity;
            // removing queued rows transfers nothing (queue dies with the
            // losing identity), no drain authority.
            "features/magic-context/storage-identity-merge.ts",
            "features/magic-context/storage-ops.ts",
            // G4: session teardown — DELETE FROM ${definition.table} /
            // ${quoteIdentifier(table)} over SESSION_SCOPED_TABLES, which
            // includes pending_ops. The schedule dies with the session;
            // deleting queued rows there removes authority, it cannot
            // apply it (no drain bypass) — L0 spirit holds, named member.
            "features/magic-context/storage-session-tables.ts",
            "features/magic-context/storage-tags.ts",
            // Dev benchmark fixture seeder: creates intent for load tests
            // only; not a runtime writer.
            "scripts/bench-store-generation-rebase.ts",
            // F5 — clone semantics are row-copy of already-queued intent, not
            // new intent: the destination inherits the source's queue and the
            // boundary drain still decides when drops land (generic
            // INSERT INTO ${table} copy).
            "scripts/clone-session.ts",
        ]);
    });

    it("ctx_reduce (the sole synchronous exception) enqueues intent only through the queue API", () => {
        const toolFiles = files.filter((f) => rel(f).startsWith("tools/ctx-reduce"));
        expect(toolFiles.length).toBeGreaterThan(0);
        expect(toolFiles.some((f) => readFileSync(f, "utf8").includes("queuePendingOp"))).toBe(
            true,
        );
        for (const f of toolFiles) {
            expect(readFileSync(f, "utf8")).not.toMatch(
                /(?:INSERT INTO|DELETE FROM|UPDATE)\s+(pending_ops|tags|session_meta)/i,
            );
        }
    });

    it("the bust permission is defined exactly once, in the postprocess phase", () => {
        const definers = files.filter((f) =>
            /const (systemReclaimAllowed|shouldApplyPendingOps|shouldRunHeuristics)\s*=/.test(
                readFileSync(f, "utf8"),
            ),
        );
        expect(definers.map(rel)).toEqual(["hooks/magic-context/transform-postprocess-phase.ts"]);
    });

    it("the §4 rotation-reason list and the code's reason literals are the same set", () => {
        // F4: the doc list is the single source of truth, parsed at test
        // time. Drift is red in BOTH directions: a doc entry without a code
        // arm, or a code literal absent from the doc. No hardcoded mirror of
        // the vocabulary may live in this test.
        const docPath = join(
            SRC_ROOT,
            "..",
            "..",
            "..",
            "docs",
            "designs",
            "frozen-system-region-residency.md",
        );
        const doc = readFileSync(docPath, "utf8");
        const fence = doc.match(/```rotation-reasons\n([^`]+)```/);
        expect(fence).not.toBeNull();
        const docLines = fence![1]
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
        const docReasons = new Set(docLines);
        expect(docLines.length).toBe(docReasons.size); // no duplicates

        // Code side: the decision tables + arms in the store module, the
        // region-reachable fold arms in mustMaterialize, and the fold-lane
        // default at the call sites. Scanned from the function bodies, not a
        // fixed-width window around an identifier.
        const codeReasons = new Set<string>();
        const storeText = readFileSync(join(SRC_ROOT, STORE), "utf8");
        for (const m of storeText.matchAll(/\[\s*"[a-zA-Z]+",\s*"([a-z_]+)"\s*\]/g))
            codeReasons.add(m[1]);
        for (const m of storeText.matchAll(/reason:\s*"([a-z_]+)"/g))
            if (m[1] !== "none") codeReasons.add(m[1]);
        const injectText = readFileSync(
            join(SRC_ROOT, "hooks/magic-context/inject-compartments.ts"),
            "utf8",
        );
        const mmStart = injectText.indexOf("export function mustMaterialize(");
        expect(mmStart).toBeGreaterThan(-1);
        const mmEndRel = injectText.slice(mmStart + 1).search(/^export (async )?function/m);
        const mmBody = injectText.slice(mmStart, mmStart + 1 + mmEndRel);
        for (const m of mmBody.matchAll(/reason:\s*"([a-z_]+)"/g)) codeReasons.add(m[1]);
        // G5 blind classes:
        // (1) template-literal composite reasons match on the STEM before
        //     `:` or `(` (render_config:budget(...));
        for (const m of mmBody.matchAll(/reason:\s*`([a-z_]+)(?::|[(:])/g))
            codeReasons.add(m[1]);
        // (2) variable-passed reasons: captured by name and resolved through
        //     this explicit map — the producer's own return literals are not
        //     regex-guaranteed reachable, so an unmapped variable name fails
        //     the census and the mapping is reviewed by hand (excluded with
        //     reason, the cached_m1_missing discipline).
        const VARIABLE_REASONS: Record<string, string> = {
            budgetShrinkReason: "render_config",
        };
        for (const m of mmBody.matchAll(/reason:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*[,}]/g)) {
            if (["null", "undefined", "true", "false"].includes(m[1])) continue;
            const stem = VARIABLE_REASONS[m[1]];
            expect(stem, `variable-passed reason ${m[1]} is not mapped`).toBeDefined();
            codeReasons.add(stem);
        }
        // Head-lane-only fold reason: region mode guards around it (`&& !regionMode`).
        codeReasons.delete("cached_m1_missing");
        // Call-site fold-lane defaults: reason literals inside the
        // systemRegion option object passed to the fold.
        for (const { full } of ALL_ZONE_FILES) {
            const text = readFileSync(full, "utf8");
            if (!/systemRegion/.test(text)) continue;
            for (const m of text.matchAll(
                /systemRegion:[\s\S]{0,400}?reason[\s:\S]{0,120}?"([a-z_]+)"/g,
            ))
                codeReasons.add(m[1]);
        }
        expect([...docReasons].sort()).toEqual([...codeReasons].sort());
    });
});
