/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

const SRC_ROOT = join(import.meta.dir, "..", "..");

// H4 (round 3): census walks take a deny-list, not skip-all-dot-dirs —
// only VCS/build noise is excluded, BY NAME — and the full TS module
// extension family (.tsx/.cts/.mts sources were invisible to the old
// .ts-only filter).
const WALK_DENY_DIRS: ReadonlySet<string> = new Set([".git", "node_modules", "dist", ".codegraph"]);
const PRODUCTION_FILE = /\.(ts|tsx|mts|cts|mjs|cjs)$/;
function walkTs(dir: string, prefix: string): Array<{ rel: string; full: string }> {
    const out: Array<{ rel: string; full: string }> = [];
    const walk = (d: string) => {
        for (const entry of readdirSync(d)) {
            const full = join(d, entry);
            if (statSync(full).isDirectory()) {
                if (!WALK_DENY_DIRS.has(entry)) walk(full);
                continue;
            }
            if (PRODUCTION_FILE.test(entry) && !entry.endsWith(".test.ts"))
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
                if (!WALK_DENY_DIRS.has(entry)) walk(full);
                continue;
            }
            if (PRODUCTION_FILE.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
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
    // H3/H4 (round 3): the zone set joins the clear file's TS_ROOTS shape —
    // pi-plugin/scripts is real TS that can open context.db (#2665) and was
    // missing from this census's claimed production tree.
    const ZONE_ROOTS: ReadonlyArray<{ dir: string; prefix: string }> = [
        { dir: SRC_ROOT, prefix: "" },
        { dir: join(SRC_ROOT, "..", "scripts"), prefix: "scripts/" },
        { dir: join(SRC_ROOT, "..", "..", "cli", "src"), prefix: "cli/" },
        { dir: join(SRC_ROOT, "..", "..", "pi-plugin", "src"), prefix: "pi/" },
        { dir: join(SRC_ROOT, "..", "..", "pi-plugin", "scripts"), prefix: "pi-scripts/" },
    ];
    const zoneFiles = (
        extraRoots: ReadonlyArray<{ dir: string; prefix: string }> = [],
    ): Array<{ rel: string; full: string }> =>
        [...ZONE_ROOTS, ...extraRoots].flatMap(({ dir, prefix }) => walkTs(dir, prefix));
    const ALL_ZONE_FILES = zoneFiles();
    const filesUsing = (
        pattern: RegExp,
        extraRoots: ReadonlyArray<{ dir: string; prefix: string }> = [],
    ) =>
        zoneFiles(extraRoots)
            .filter(({ rel, full }) => rel !== STORE && pattern.test(readFileSync(full, "utf8")))
            .map(({ rel }) => rel)
            .sort();

    // Shared reason parser (G2): one implementation used by the fence law AND
    // every control, so a control can never test a private copy of the
    // patterns that drifted from the law. piTextOverride lets controls plant
    // mints in memory (production file untouched).
    const PI_FOLD_FILE = join(
        SRC_ROOT,
        "..",
        "..",
        "pi-plugin",
        "src",
        "inject-compartments-pi.ts",
    );
    function piFoldBody(text: string): string {
        const mmStart = text.indexOf("export function mustMaterializePi(");
        expect(mmStart).toBeGreaterThan(-1);
        const mmEndRel = text.slice(mmStart + 1).search(/^export (async )?function/m);
        return text.slice(mmStart, mmStart + 1 + mmEndRel);
    }
    function collectReasons(
        piTextOverride?: string,
        zoneTextOverride?: ReadonlyMap<string, string>,
    ): Set<string> {
        const codeReasons = new Set<string>();
        // H2 shared value classifier — one implementation for every reason
        // position (fold-body `reason:`, Pi mint first args, call-site
        // systemRegion windows). Recognized forms contribute their stems;
        // anything unrecognized THROWS (deny-by-default, mirroring the
        // unmapped-variable law already enforced on the mint surface).
        // Bare identifiers are reviewed through the position's explicit map;
        // decision-table sources (`obj.reason` members, `*Reason` locals not
        // in call position) skip — their vocabulary is censused where it is
        // minted. A call wrapper (`buildReason("x")`) is never a source form
        // and never skips.
        function classifyReasonValue(
            raw: string,
            where: string,
            varMap: Record<string, string>,
        ): void {
            const v = raw.trim();
            if (/^"[a-z_]*"[\s,;)}]*$/.test(v)) {
                const lit = v.replace(/^"/, "").replace(/["\s,;)}]+$/, "");
                if (lit) codeReasons.add(lit);
                return;
            }
            if (/^`/.test(v)) {
                expect(
                    /^`[a-z_]+(?::|[(:])/.test(v),
                    `${where}: reason template ${JSON.stringify(v)} has no doc-listed stem shape (deny-by-default, H2)`,
                ).toBe(true);
                codeReasons.add(v.slice(1).match(/^[a-z_]+/)![0]);
                return;
            }
            if (/^(null|undefined|true|false)\b/.test(v)) return;
            for (const lit of v.matchAll(/"([a-z_]+)"/g)) codeReasons.add(lit[1]);
            const withoutLits = v.replace(/"[^"]*"/g, " ");
            const reasonSourced = new Set(
                [...withoutLits.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\.\s*reason\b/g)].map(
                    (m) => m[1],
                ),
            );
            for (const h of withoutLits.matchAll(
                /(^|[^.\w$])([A-Za-z_$][A-Za-z0-9_$]*)(\s*(?:\(|\.))?/g,
            )) {
                const name = h[2];
                if (!name) continue;
                if (/^(typeof|new|in|of|return|const|let|var|function)$/.test(name)) continue;
                if (varMap[name]) {
                    codeReasons.add(varMap[name]);
                    continue;
                }
                const isCall = /\(/.test(h[3] ?? "");
                if (!isCall && name.endsWith("Reason")) continue; // decision-sourced local
                if (!isCall && reasonSourced.has(name)) continue; // decisions-table object
                expect(
                    undefined,
                    `${where}: reason value ${JSON.stringify(v)} carries unmapped identifier ${name} (deny-by-default, H2)`,
                ).toBeDefined();
            }
        }
        const storeText = readFileSync(join(SRC_ROOT, STORE), "utf8");
        for (const m of storeText.matchAll(/\[\s*"[a-zA-Z]+",\s*"([a-z_]+)"\s*\]/g))
            codeReasons.add(m[1]);
        for (const m of storeText.matchAll(/reason:\s*"([a-z_]+)"/g))
            if (m[1] !== "none") codeReasons.add(m[1]);
        const scanFoldBody = (text: string, marker: string, opts: { mismatchMints: boolean }) => {
            const mmStart = text.indexOf(marker);
            expect(mmStart).toBeGreaterThan(-1);
            const mmEndRel = text.slice(mmStart + 1).search(/^export (async )?function/m);
            const body = text.slice(mmStart, mmStart + 1 + mmEndRel);
            for (const m of body.matchAll(/reason:\s*"([a-z_]+)"/g)) codeReasons.add(m[1]);
            if (opts.mismatchMints) {
                // Pi mint vocabulary (G2 → H2): every piMaterializeMismatch
                // first arg through the shared deny-by-default classifier.
                // The one live variable mint is budgetShrinkReason
                // (inject-compartments-pi.ts:1322), minted by
                // renderedBudgetShrinkReason (compartment-render-epoch.ts:
                // 155-156) as `render_config:budget_shrink(…)` — reviewed,
                // stem render_config.
                const VARIABLE_MISMATCH_REASONS: Record<string, string> = {
                    budgetShrinkReason: "render_config",
                };
                for (const m of body.matchAll(/piMaterializeMismatch\(\s*([^\n]{1,120})/g)) {
                    classifyReasonValue(m[1], `${marker} mint`, VARIABLE_MISMATCH_REASONS);
                }
            }
            // G5 blind classes:
            // (1) template-literal composite reasons match on the STEM
            //     before `:` or `(` (render_config:budget(...));
            for (const m of body.matchAll(/reason:\s*`([a-z_]+)(?::|[(:])/g)) codeReasons.add(m[1]);
            // (2) variable-passed and composite reasons: DENY-BY-DEFAULT
            //     (H2) over every value form — the pre-H2 arm terminated at
            //     [,}] and silently contributed nothing for `reason:
            //     buildReason("x")` (call wrapper) or `reason: flag ? "a" :
            //     "b"` (ternary). Unrecognized shapes throw, mirroring the
            //     mint arm. Reviewed variables resolve through this explicit
            //     map (the producer's own return literals are not
            //     regex-guaranteed reachable — the cached_m1_missing
            //     discipline).
            const VARIABLE_REASONS: Record<string, string> = {
                budgetShrinkReason: "render_config",
            };
            for (const m of body.matchAll(/reason:\s*([^\n]{1,120})/g)) {
                classifyReasonValue(m[1], `${marker} body`, VARIABLE_REASONS);
            }
        };
        scanFoldBody(
            readFileSync(join(SRC_ROOT, "hooks/magic-context/inject-compartments.ts"), "utf8"),
            "export function mustMaterialize(",
            { mismatchMints: false },
        );
        scanFoldBody(
            piTextOverride ?? readFileSync(PI_FOLD_FILE, "utf8"),
            "export function mustMaterializePi(",
            { mismatchMints: true },
        );
        // Head-lane-only fold reasons: region mode guards around them
        // (`&& !regionMode`, both lanes).
        codeReasons.delete("cached_m1_missing");
        // Call-site fold-lane defaults: the systemRegion option object
        // passed to the fold, every value form through the shared
        // deny-by-default classifier (H2: the pre-H2 window regex required a
        // quoted string; a bare-identifier relay was invisible anywhere).
        // Reviewed map is empty: live call sites pass literals, `""`
        // (no-forcing), and decision-sourced expressions only.
        const SYSTEMREGION_VARIABLE_REASONS: Record<string, string> = {};
        for (const { rel, full } of ALL_ZONE_FILES) {
            const text = zoneTextOverride?.get(rel) ?? readFileSync(full, "utf8");
            if (!/systemRegion/.test(text)) continue;
            for (const m of text.matchAll(
                /systemRegion:[\s\S]{0,400}?reason\s*:\s*([^\n]{1,120})/g,
            )) {
                classifyReasonValue(
                    m[1],
                    `systemRegion window in ${rel}`,
                    SYSTEMREGION_VARIABLE_REASONS,
                );
            }
        }
        return codeReasons;
    }

    it("the rotation executor has exactly the named fold-lane callers", () => {
        // L0 is one MECHANISM (the boundary transaction), not one file: the
        // OpenCode-1 fold and the Pi fold (§23 D4) are the two named fold
        // lanes; both install inside their own BEGIN IMMEDIATE. A third
        // caller — or a caller outside a fold transaction — is two baselines.
        expect(filesUsing(/executeSystemRegionRotation\(/)).toEqual([
            "hooks/magic-context/inject-compartments.ts",
            "pi/inject-compartments-pi.ts",
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
        const opsFiles = zoneFiles();
        // G4 honest boundary — what the regexes cannot see: dynamic
        // table-name VARIABLES (not ${...} interpolations), schema-qualified
        // forms (`main.pending_ops`), aliasing via views, and every file
        // outside the four walk roots (e2e-tests, dashboard TS). The
        // dynamic-${} arms below are captured by shape; a writer that hides
        // behind an indirect variable is a review-time defect the census
        // cannot promise to catch, same disclosure class as the Rust zone.
        const writers = opsFiles
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

    it("the head-era baseline-boundary column has only named readers and writers (J2c)", () => {
        // Property enforcement surface for "no path derives wire-affecting
        // decisions from region rows unguarded": every production file that
        // touches cached_m0_last_baseline_end_message_id must be a named
        // member with its discrimination stated. A new reader that skips
        // region discrimination fails here, not in production.
        const ALLOWED: ReadonlyMap<string, string> = new Map([
            [
                "features/magic-context/system-region.ts",
                "write-site null (direct installs; column-safe probe)",
            ],
            ["features/magic-context/storage-meta-shared.ts", "central invalidation clears list"],
            [
                "hooks/magic-context/inject-compartments.ts",
                "head-lane writer (fold UPDATE) + replay/trim readers",
            ],
            [
                "hooks/magic-context/history-boundary-repair.ts",
                "reader with isSystemRegionBytes discrimination (A2)",
            ],
            [
                "v2/hooks/context.ts",
                "v2 restore-range hint; named consumer, never serves region bytes",
            ],
            ["features/magic-context/migrations.ts", "schema"],
            ["features/magic-context/storage-db.ts", "schema/ensureColumn"],
            [
                "pi/inject-compartments-pi.ts",
                "Pi trim reader with sentinel refusal (H3) + passSnapshot mapper",
            ],
        ]);
        const offenders: string[] = [];
        const files = zoneFiles();
        for (const { rel, full } of files) {
            if (rel.endsWith(".test.ts")) continue;
            if (!/cached_m0_last_baseline_end_message_id/.test(readFileSync(full, "utf8")))
                continue;
            if (!ALLOWED.has(rel)) offenders.push(rel);
        }
        // K2 (M2-corrected): repo-standard roots, matching the F1-adjudicated
        // eraser census where the boundary column actually exists: crates/
        // (reset-list writers) and repo-root scripts/. The dashboard is
        // covered by the ERASER census for cached_m0_bytes; src-tauri holds
        // no boundary-column literal, so no tauri root here (inert allow-set
        // member dropped by round-9 adjudication).
        const REPO = join(SRC_ROOT, "..", "..", "..");
        const EXTRA: Array<{ root: string; prefix: string; allowed: ReadonlySet<string> }> = [
            {
                root: join(REPO, "crates"),
                prefix: "crates/",
                allowed: new Set([
                    // reset-list writer; adjudicated never-active on the Rust
                    // lane — exemption imported from the eraser census.
                    "crates/mc-module/src/single_store_repair.rs",
                ]),
            },
            {
                root: join(REPO, "scripts"),
                prefix: "scripts/",
                allowed: new Set([
                    // read-only host probe (readonly DB handle).
                    "scripts/b2-drill/repair-history-host-probe.ts",
                ]),
            },
        ];
        for (const { root, prefix, allowed } of EXTRA) {
            if (!existsSync(root)) continue;
            const stack = [root];
            while (stack.length) {
                const dir = stack.pop()!;
                for (const entry of readdirSync(dir)) {
                    const full = join(dir, entry);
                    if (statSync(full).isDirectory()) {
                        stack.push(full);
                        continue;
                    }
                    if (!/\.(ts|rs)$/.test(entry) || entry.endsWith("_tests.rs")) continue;
                    const rel = prefix + full.slice(root.length + 1);
                    if (
                        !readFileSync(full, "utf8").includes(
                            "cached_m0_last_baseline_end_message_id",
                        )
                    )
                        continue;
                    if (!allowed.has(rel)) offenders.push(rel);
                }
            }
        }
        expect(offenders).toEqual([]);
    });

    it("the volatile segment columns have only named SQL writers and readers (Unit 2 L0)", () => {
        // L0 single-writer law for the Task-1 carriage: the two region_volatile
        // columns are written ONLY by the sanctioned accessors in
        // storage-meta-shared.ts (writeRegionVolatile + the fold-row absorb in
        // persistCachedM0) and read as raw SQL only by the serve decode in
        // region-volatile.ts. A wire-affecting write outside these named
        // actors fails here, not in production.
        const ALLOWED: ReadonlyMap<string, string> = new Map([
            ["features/magic-context/storage-db.ts", "fresh DDL + ensureColumn (schema)"],
            ["features/magic-context/migrations.ts", "migration v95 (schema)"],
            [
                "features/magic-context/storage-meta-shared.ts",
                "sole writer: writeRegionVolatile + fold-row absorb in persistCachedM0 + row mapping",
            ],
            [
                "features/magic-context/storage-meta-session.ts",
                "typed projection + column-safe fallback selects (read surface only)",
            ],
            [
                "hooks/magic-context/region-volatile.ts",
                "read-only serve decode (SELECT region_volatile_bytes) + codec",
            ],
        ]);
        const offenders: string[] = [];
        let walkedVolatileZone = 0;
        for (const { rel, full } of zoneFiles()) {
            if (rel.endsWith(".test.ts")) continue;
            const text = readFileSync(full, "utf8");
            if (!/region_volatile_bytes|region_volatile_watermark/.test(text)) continue;
            walkedVolatileZone += 1;
            if (!ALLOWED.has(rel)) offenders.push(rel);
        }
        // Zone-membership floor (#2714): the schema pair alone guarantees the
        // walk saw the columns; a dropped zone would fail here, not silently.
        expect(walkedVolatileZone).toBeGreaterThanOrEqual(3);
        expect(offenders).toEqual([]);

        // Entry-point closure (#2713 holder-set form): the sanctioned write
        // entries may only be invoked from their named production holders.
        const writers = filesUsing(/\bwriteRegionVolatile\s*\(/);
        expect(writers).toEqual([
            "features/magic-context/storage-meta-shared.ts",
            "hooks/magic-context/region-volatile.ts",
        ]);
        const recomputers = filesUsing(/\brecomputeRegionVolatileSegment\s*\(/);
        // Definition (region-volatile.ts) + the ONLY production call site: the
        // bust lane in the postprocess phase. Any other caller reddens.
        expect(recomputers).toEqual([
            "hooks/magic-context/region-volatile.ts",
            "hooks/magic-context/transform-postprocess-phase.ts",
        ]);
    });

    it("the serve site appends volatile only behind a served region and never hashes it (Unit 2 L0)", () => {
        // Property: decodeRegionVolatileBytes has exactly two production
        // readers — the codec owner (region-volatile.ts) and the Step 2.5b
        // append site (system-prompt-hash.ts) — and the append site's hashed
        // surface stays hostContent-only (the hash call must not see the
        // volatile text; it is minted from output.system AFTER appends only
        // for the host slice, pinned by the Step 3 hash of hostContent).
        const readers = filesUsing(/\bdecodeRegionVolatileBytes\b/);
        expect(readers).toEqual([
            "hooks/magic-context/region-volatile.ts",
            "hooks/magic-context/system-prompt-hash.ts",
        ]);
        const hashSite = readFileSync(
            join(SRC_ROOT, "hooks/magic-context/system-prompt-hash.ts"),
            "utf8",
        );
        expect(hashSite).toContain("promptSurfaceHashMaterial(hostContent");
        expect(hashSite).not.toMatch(/update\(.*regionVolatile/);
    });

    it("no region rotation reason mints from a raw store-read string (J1)", () => {
        // Property: every \${...} interpolation inside a reason template on
        // the rotation mint surface is either sanitizeReceiptOperand(...) or
        // a PARSED canonical value from this allowlist (numbers parsed by
        // the epoch parser, booleans parsed by decode) — grammar-bounded by
        // construction. A raw stored string interpolated here can re-mint
        // every pass and throw inside the materialization transaction: the
        // fold that would rewrite it is the thing that throws (H1/J1 wedge).
        const PARSED_CANONICAL = new Map<string, string>([
            ["cachedUpgradeIdentity.muralEnabled", "boolean|null parsed from the stored component"],
            ["current.muralEnabled", "live boolean, never store text"],
            ["before.memory", "Number() parsed by readRenderedBudgets"],
            ["before.history", "Number() parsed by readRenderedBudgets"],
            ["after.memory", "Number() parsed by readRenderedBudgets"],
            ["after.history", "Number() parsed by readRenderedBudgets"],
        ]);
        // K1(c) widened scope. The census DETERS (the funnel sanitizer is the
        // bound; nothing fatals): it scans (1) every reason:-prefixed
        // template, (2) every template ANYWHERE in the mint files that looks
        // reason-shaped (contains the arrow or a fence stem — return-position
        // and local-variable mints evade (1)), and (3) concat-assembled
        // reasons referencing stored properties. Evasion that remains —
        // multi-hop computed fragments — is the disclosed class.
        const MINT_FILES = [
            "hooks/magic-context/inject-compartments.ts",
            "hooks/magic-context/compartment-render-epoch.ts",
        ];
        const offenders: string[] = [];
        const checkTemplate = (rel: string, body: string, label: string) => {
            for (const interp of body.matchAll(/\$\{([^}]*)\}/g)) {
                const expr = interp[1].trim();
                if (expr.startsWith("sanitizeReceiptOperand(")) continue;
                if (!PARSED_CANONICAL.has(expr)) {
                    offenders.push(`${rel}: ${label} interpolates ${expr}`);
                }
            }
        };
        for (const rel of MINT_FILES) {
            const text = readFileSync(join(SRC_ROOT, rel), "utf8");
            for (const m of text.matchAll(/reason:\s*`([^`]*)`/g)) {
                checkTemplate(rel, m[1], "reason template");
            }
            for (const m of text.matchAll(/`([^`]*[→]|[^`]*render_config:[^`]*)`/g)) {
                checkTemplate(rel, m[1], "reason-shaped template");
            }
            for (const m of text.matchAll(/reason:\s*([^\n,}]+)/g)) {
                const rhs = m[1];
                if (/(\+|\.concat\()/.test(rhs) && /cached|upgradeState|_state/.test(rhs)) {
                    offenders.push(`${rel}: concat-assembled reason references stored state`);
                }
            }
        }
        expect(offenders).toEqual([]);
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
        // region-reachable fold arms in mustMaterialize (TS) AND
        // mustMaterializePi + its piMaterializeMismatch mint sites (Pi —
        // review F3: the Pi lane mints its own literals; a Pi-only rename
        // must redden here), and the fold-lane default at the call sites.
        // Scanned from the function bodies, not a fixed-width window around
        // an identifier. Parser and controls share one implementation
        // (collectReasons, hoisted for G2).
        const codeReasons = collectReasons();
        expect([...docReasons].sort()).toEqual([...codeReasons].sort());
    });

    it("the Pi template-composite mismatch mint is parser-visible (G2-i)", () => {
        // The live mural mint (inject-compartments-pi.ts:1296,
        // `piMaterializeMismatch(`render_config:mural(…)`, …)`) reached the
        // census only via the TS lane's independent render_config:* stem arm
        // (R2-c bridging). After G2 the Pi mismatch scan itself parses
        // template first args — prove the arm is LIVE against the real
        // file, not dead code that only matches plants.
        const piText = readFileSync(
            join(SRC_ROOT, "..", "..", "pi-plugin", "src", "inject-compartments-pi.ts"),
            "utf8",
        );
        const body = piFoldBody(piText);
        const templateStems = new Set<string>();
        for (const m of body.matchAll(/piMaterializeMismatch\(\s*`([a-z_]+)(?::|[(:])/g))
            templateStems.add(m[1]);
        expect(templateStems.has("render_config")).toBe(true);
        // And the collector, fed the live text, contains it.
        expect(collectReasons().has("render_config")).toBe(true);
        // The doc fence carries the stem today because the TS bridge minted
        // it; coverage is now explicit in §4 prose as well.
        const doc = readFileSync(
            join(
                SRC_ROOT,
                "..",
                "..",
                "..",
                "docs",
                "designs",
                "frozen-system-region-residency.md",
            ),
            "utf8",
        );
        const fence = doc.match(/```rotation-reasons\n([^`]+)```/)![1];
        expect(
            fence
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
        ).toContain("render_config");
    });

    // H4 (round 3): the walks skipped ALL dot-directories and accepted only
    // .ts — a rotation-caller rogue at a .tsx path or under an in-zone
    // dot-directory was invisible to every producer census (and the eraser
    // census, closed in the clear file). Plants attack the walk itself.
    it("every producer census zone walks production files, by name (H3/#2665 floor)", () => {
        for (const { dir, prefix } of ZONE_ROOTS) {
            expect(
                statSync(dir, { throwIfNoEntry: false })?.isDirectory(),
                `zone absent: ${prefix}`,
            ).toBe(true);
            expect(walkTs(dir, prefix).length, `zone walked 0 files: ${prefix}`).toBeGreaterThan(0);
        }
    });

    it("control: .tsx and dot-dir rogues redden the producer census walks (H4)", () => {
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-h4-producers-"));
        try {
            const rogue =
                'import { executeSystemRegionRotation } from "@magic-context/core/features/magic-context/system-region";\nexport const r = (input: never) => executeSystemRegionRotation(input);\n';
            writeFileSync(join(dir, "rogue.tsx"), rogue);
            mkdirSync(join(dir, ".probe"));
            writeFileSync(join(dir, ".probe", "rogue.ts"), rogue);
            const found = filesUsing(/executeSystemRegionRotation\(/, [
                { dir, prefix: "planted-h4/" },
            ]);
            expect(found).toContain("planted-h4/rogue.tsx");
            expect(found).toContain("planted-h4/.probe/rogue.ts");
            // Pre-H4 blindness: .ts-only filter and skip-all-dot-dirs.
            expect("rogue.tsx".endsWith(".ts")).toBe(false);
            expect(".probe".startsWith(".")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        // Steady state unchanged by the walk widening: the named lists hold.
        expect(filesUsing(/executeSystemRegionRotation\(/)).toEqual([
            "hooks/magic-context/inject-compartments.ts",
            "pi/inject-compartments-pi.ts",
        ]);
    });

    it("control: a planted Pi template composite with a new stem reddens the fence law (G2-i)", () => {
        const piText = readFileSync(
            join(SRC_ROOT, "..", "..", "pi-plugin", "src", "inject-compartments-pi.ts"),
            "utf8",
        );
        const planted = piText.replace(
            "const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;",
            'return piMaterializeMismatch(`pi_composite_fake(x)`, "planted", 0, 1);\n\tconst hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;',
        );
        expect(planted).not.toBe(piText);
        // Same parser as the law: the stem surfaces…
        expect(collectReasons(planted).has("pi_composite_fake")).toBe(true);
        // …and the doc does not carry it → the bi-equality would redden.
        const doc = readFileSync(
            join(
                SRC_ROOT,
                "..",
                "..",
                "..",
                "docs",
                "designs",
                "frozen-system-region-residency.md",
            ),
            "utf8",
        );
        const docReasons = new Set(
            doc
                .match(/```rotation-reasons\n([^`]+)```/)![1]
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
        );
        expect(docReasons.has("pi_composite_fake")).toBe(false);
        expect([...docReasons].sort()).not.toEqual([...collectReasons(planted)].sort());
    });

    it("control: an unmapped variable first-arg mint reddens the fence law (G2-ii)", () => {
        // The variable-mint arm applies the same unmapped-variable law the
        // reason: surface already enforces: a mint whose first argument is a
        // bare identifier not resolved through VARIABLE_MISMATCH_REASONS
        // fails the census (the expect inside the collector throws) — it can
        // never silently contribute nothing.
        const piText = readFileSync(
            join(SRC_ROOT, "..", "..", "pi-plugin", "src", "inject-compartments-pi.ts"),
            "utf8",
        );
        const planted = piText.replace(
            "const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;",
            'return piMaterializeMismatch(unmapped_pi_mint_var, "planted", 0, 1);\n\tconst hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;',
        );
        expect(planted).not.toBe(piText);
        expect(() => collectReasons(planted)).toThrow(/unmapped_pi_mint_var/);
        // Steady live text has no variable mints → collector stays quiet.
        expect(() => collectReasons()).not.toThrow();
    });

    // H2: the reason-value parser was ALLOW-BY-DEFAULT — unrecognized value
    // forms simply contributed nothing (the arms terminated at literal,
    // template stem, and identifier-then-[,}]). Three plant classes prove
    // the deny-by-default classifier closes them; each also asserts the
    // PRE-H2 arm was blind to the plant, so the control attacks the closed
    // class, not a coincidence.
    const H2_ANCHOR = "const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;";
    function piWith(code: string): string {
        const piText = readFileSync(PI_FOLD_FILE, "utf8");
        const planted = piText.replace(H2_ANCHOR, `${code}\n\t${H2_ANCHOR}`);
        expect(planted).not.toBe(piText);
        return planted;
    }

    it("control: a call-wrapper reason denies (H2)", () => {
        const planted = piWith('if (p) return { value: true, reason: wrapReason("hard_fold") };');
        expect(() => collectReasons(planted)).toThrow(/wrapReason/);
        // Pre-H2 blindness: the variable arm terminated at [,}], so a
        // paren-followed identifier matched nothing.
        expect(
            /reason:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*[,}]/.test('reason: wrapReason("hard_fold")'),
        ).toBe(false);
    });

    it("control: a ternary reason denies (H2)", () => {
        const planted = piWith(
            'if (p) return { value: true, reason: plantedFlag ? "hard_fold" : "hard_fold" };',
        );
        expect(() => collectReasons(planted)).toThrow(/plantedFlag/);
        expect(
            /reason:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*[,}]/.test('reason: plantedFlag ? "a" : "b"'),
        ).toBe(false);
    });

    it("control: a bare-identifier relay in a systemRegion window denies (H2)", () => {
        const rel = "hooks/magic-context/transform-postprocess-phase.ts";
        const zone = ALL_ZONE_FILES.find((f) => f.rel === rel);
        expect(zone).toBeDefined();
        const text = readFileSync(zone!.full, "utf8");
        const planted = `${text}\nconst planted_fold = injectM0M1({ systemRegion: { enabled: true, reason: plantedRelayVar } });\n`;
        expect(() => collectReasons(undefined, new Map([[rel, planted]]))).toThrow(
            /plantedRelayVar/,
        );
        // Pre-H2 blindness: the window regex demanded a quoted string.
        expect(
            /systemRegion:[\s\S]{0,400}?reason[\s:\S]{0,120}?"([a-z_]+)"/.test(
                "{ systemRegion: { enabled: true, reason: plantedRelayVar } }",
            ),
        ).toBe(false);
        // Steady: live call sites classify clean.
        expect(() => collectReasons()).not.toThrow();
    });
});
