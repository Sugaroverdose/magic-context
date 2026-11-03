/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC_ROOT = join(import.meta.dir, "..", "..");

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
    const filesUsing = (pattern: RegExp) =>
        files
            .filter((f) => rel(f) !== STORE && pattern.test(readFileSync(f, "utf8")))
            .map(rel)
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
            "features/magic-context/storage-clone.ts",
            "features/magic-context/storage-meta-shared.ts",
            "hooks/magic-context/compaction-off-transition.ts",
        ]);
        expect(filesUsing(/clearAllSystemRegions\(/)).toEqual([
            "features/magic-context/migrations.ts",
        ]);
        expect(filesUsing(/clearSystemRegionsByProjectIdentity\(/)).toEqual([
            "features/magic-context/storage-identity-merge.ts",
        ]);
    });

    it("pending_ops is written only by the queue API, the boundary drain, the mode transition, and clone", () => {
        // Intent may be enqueued (queue/clone/drain); the schedule itself is
        // read and applied only inside the boundary permission. A new writer
        // outside these four is an actor with unauthorized schedule authority.
        expect(filesUsing(/(?:INSERT INTO|DELETE FROM|UPDATE)\s+pending_ops/i).sort()).toEqual([
            "features/magic-context/compaction.ts",
            "features/magic-context/storage-clone.ts",
            "features/magic-context/storage-ops.ts",
            "features/magic-context/storage-tags.ts",
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

    it("every rotation reason string in production is a name from the §4 enumeration", () => {
        // A trigger in code but not in the named-boundary list is an L0
        // violation: it moves bytes outside the schedule's vocabulary.
        // The names are drawn from the decision function's own tables plus
        // the fold-lane arms, so a new arm must be added to BOTH lists —
        // drift reddens this row.
        const named = new Set([
            // fold lane (mustMaterialize → region reason):
            "hard_fold",
            // decision tables (system-region.ts):
            "first_render",
            "missing_markers",
            "project_memory_epoch",
            "max_mutation_id",
            "max_memory_mutation_id",
            "upgrade_state",
            "compartment_render_epoch",
            "mural_enabled",
            "render_budget_identity",
            "memory_render_epoch",
            "rendered_budgets",
            "max_memory_id",
            "max_compartment_seq",
            "profile_version",
            "project_docs_hash",
            "force_band",
            "pending_growth",
            // provider-eviction / host arms reaching the region reason:
            "model_change",
            "system_hash",
            "ttl_idle",
            "host_compaction",
            "reanchor",
            "published_history",
            "explicit_flush",
            "none",
        ]);
        const offenders: string[] = [];
        for (const f of files) {
            const text = readFileSync(f, "utf8");
            // Only literals inside a systemRegion block count: the same files
            // also build head-lane mustMaterialize decision objects whose
            // reason strings belong to a different vocabulary.
            for (const m of text.matchAll(
                /systemRegion:\s*\{[\s\S]{0,220}?reason:\s*"([a-z0-9_]+)"/g,
            )) {
                if (!named.has(m[1])) offenders.push(`${rel(f)}: ${m[1]}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
