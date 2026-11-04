/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
        const files = [
            ...walkTs(SRC_ROOT, ""),
            ...walkTs(join(SRC_ROOT, "..", "scripts"), "scripts/"),
            ...walkTs(join(SRC_ROOT, "..", "..", "cli", "src"), "cli/"),
            ...walkTs(join(SRC_ROOT, "..", "..", "pi-plugin", "src"), "pi/"),
        ];
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
        // an identifier.
        const collectReasons = (injectTextOverride?: string) => {
            const codeReasons = new Set<string>();
            const storeText = readFileSync(join(SRC_ROOT, STORE), "utf8");
            for (const m of storeText.matchAll(/\[\s*"[a-zA-Z]+",\s*"([a-z_]+)"\s*\]/g))
                codeReasons.add(m[1]);
            for (const m of storeText.matchAll(/reason:\s*"([a-z_]+)"/g))
                if (m[1] !== "none") codeReasons.add(m[1]);
            const injectText =
                injectTextOverride ??
                readFileSync(join(SRC_ROOT, "hooks/magic-context/inject-compartments.ts"), "utf8");
            const scanFoldBody = (
                text: string,
                marker: string,
                opts: { mismatchMints: boolean },
            ) => {
                const mmStart = text.indexOf(marker);
                expect(mmStart).toBeGreaterThan(-1);
                const mmEndRel = text.slice(mmStart + 1).search(/^export (async )?function/m);
                const body = text.slice(mmStart, mmStart + 1 + mmEndRel);
                for (const m of body.matchAll(/reason:\s*"([a-z_]+)"/g)) codeReasons.add(m[1]);
                if (opts.mismatchMints) {
                    for (const m of body.matchAll(/piMaterializeMismatch\(\s*"([a-z_]+)"/g))
                        codeReasons.add(m[1]);
                }
                // G5 blind classes:
                // (1) template-literal composite reasons match on the STEM
                //     before `:` or `(` (render_config:budget(...));
                for (const m of body.matchAll(/reason:\s*`([a-z_]+)(?::|[(:])/g))
                    codeReasons.add(m[1]);
                // (2) variable-passed reasons: captured by name and resolved
                //     through this explicit map — the producer's own return
                //     literals are not regex-guaranteed reachable, so an
                //     unmapped variable name fails the census and the mapping
                //     is reviewed by hand (excluded with reason, the
                //     cached_m1_missing discipline).
                const VARIABLE_REASONS: Record<string, string> = {
                    budgetShrinkReason: "render_config",
                };
                for (const m of body.matchAll(/reason:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*[,}]/g)) {
                    if (["null", "undefined", "true", "false"].includes(m[1])) continue;
                    const stem = VARIABLE_REASONS[m[1]];
                    expect(stem, `variable-passed reason ${m[1]} is not mapped`).toBeDefined();
                    codeReasons.add(stem);
                }
            };
            scanFoldBody(injectText, "export function mustMaterialize(", {
                mismatchMints: false,
            });
            const piText = readFileSync(
                join(SRC_ROOT, "..", "..", "pi-plugin", "src", "inject-compartments-pi.ts"),
                "utf8",
            );
            scanFoldBody(piText, "export function mustMaterializePi(", {
                mismatchMints: true,
            });
            // Head-lane-only fold reasons: region mode guards around them
            // (`&& !regionMode`, both lanes).
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
            return codeReasons;
        };
        const codeReasons = collectReasons();
        expect([...docReasons].sort()).toEqual([...codeReasons].sort());
    });

    it("control: a planted Pi-lane-only fold reason reddens the fence law", () => {
        // F3 mechanism attack: the Pi parser half must actually see literals
        // — a Pi-only rename/addition reddens, not silently passes. The
        // plant mutates the parsed text in memory (production file
        // untouched).
        const docPath = join(
            SRC_ROOT,
            "..",
            "..",
            "..",
            "docs",
            "designs",
            "frozen-system-region-residency.md",
        );
        const docReasons = new Set(
            readFileSync(docPath, "utf8")
                .match(/```rotation-reasons\n([^`]+)```/)![1]
                .split("\n")
                .map((l) => l.trim())
                .filter(Boolean),
        );
        const piPath = join(SRC_ROOT, "..", "..", "pi-plugin", "src", "inject-compartments-pi.ts");
        const piText = readFileSync(piPath, "utf8");
        // Sanity: the steady state parses the Pi lane's real literals.
        const planted = piText.replace(
            "const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;",
            'return piMaterializeMismatch("pi_lane_only_fake", "planted", 0, 1);\n\tconst hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;',
        );
        expect(planted).not.toBe(piText);
        // Re-run the collector against the mutated Pi text by pointing the
        // reader at it: rebuild the scan locally with the same patterns
        // (same +1 slice offset as the law).
        const markerAt = planted.indexOf("export function mustMaterializePi(");
        expect(markerAt).toBeGreaterThan(-1);
        const endRel = planted.slice(markerAt + 1).search(/^export (async )?function/m);
        const truncated = planted.slice(markerAt, markerAt + 1 + endRel);
        const seen = new Set<string>();
        for (const m of truncated.matchAll(/piMaterializeMismatch\(\s*"([a-z_]+)"/g))
            seen.add(m[1]);
        expect(seen.has("pi_lane_only_fake")).toBe(true);
        expect(docReasons.has("pi_lane_only_fake")).toBe(false);
    });
});
