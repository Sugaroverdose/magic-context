/// <reference types="bun-types" />

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    clearAllSystemRegions,
    clearSystemRegion,
    clearSystemRegionsByProjectIdentity,
    executeSystemRegionRotation,
    readSystemRegion,
} from "../../features/magic-context/system-region";

const SRC_ROOT = join(import.meta.dir, "..", "..");
// F1: the walk roots are the whole production surface that can open
// context.db — the plugin core AND its scripts, the CLI package, and the Pi
// package (which imports the core). A "production tree" claim must match the
// walk roots, so the census walks every zone, not just packages/plugin/src.
const PKG_ROOT = join(SRC_ROOT, "..");
const REPO_PACKAGES = join(PKG_ROOT, "..");
const TS_ROOTS: ReadonlyArray<{ dir: string; prefix: string }> = [
    { dir: SRC_ROOT, prefix: "" },
    { dir: join(PKG_ROOT, "scripts"), prefix: "scripts/" },
    { dir: join(REPO_PACKAGES, "cli", "src"), prefix: "cli/" },
    { dir: join(REPO_PACKAGES, "pi-plugin", "src"), prefix: "pi/" },
    // P1 (round 11): #2665 names the runtime scripts tree too — it carries
    // real TS (benchmarks, probes, generators) that can open context.db.
    { dir: join(REPO_PACKAGES, "pi-plugin", "scripts"), prefix: "pi-scripts/" },
];

const lines: string[] = [];
mock.module("../../shared/logger", () => ({
    log: () => {},
    sessionLog: (_sessionId: string, message: string) => lines.push(message),
    flushLogger: () => {},
    setLogLineForwarder: () => {},
    writeForwardedLogLine: () => {},
    getLogFilePath: () => "/tmp/magic-context-test.log",
    getLoggerDiagnostics: () => ({
        swallowedWriteCount: 0,
        lastErrorMessage: null,
        lastErrorTime: null,
    }),
}));

import { encodeSystemRegionRow } from "../../features/magic-context/system-region";

function freshDb() {
    const db = new BunDatabase(":memory:");
    initializeDatabase(db);
    return db as never;
}

function seedRegion(db: never, sessionId: string, content = "<project-memory>x</project-memory>") {
    getOrCreateSessionMeta(db, sessionId);
    db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
        encodeSystemRegionRow(content),
        sessionId,
    );
    expect(readSystemRegion(db, sessionId)).toBe(content);
}

function clearedLines(): string[] {
    return lines.filter((line) => line.includes("system-region cleared"));
}

/**
 * Sole-writer census (L3/L7). Assignment and REPLACE checks apply to every
 * production file except the named writers; files whose UPDATE ... SET is
 * assembled dynamically need a named exemption AND must pass their sub-law
 * (the region column may not be reachable through the dynamic path). The
 * class this pins: a raw `cached_m0_bytes` eraser outside the receipted
 * funnel — any form: literal NULL, positional or named bind, upsert-carried
 * value, REPLACE-into row wipe, list-driven dynamic SET, or a Rust column
 * literal. This is how the un-receipted-eraser class stays dead, not just
 * the instances the review found.
 */
const ALLOWED_WRITERS: ReadonlyMap<string, string> = new Map([
    ["features/magic-context/system-region.ts", "the receipted funnel itself"],
    [
        "features/magic-context/storage-meta-shared.ts",
        "fold-row transaction path: persistCachedM0's explicit UPDATE (single production caller, pinned by law below)",
    ],
]);

const ALLOWED_DYNAMIC_SET: ReadonlyMap<string, string> = new Map([
    [
        "features/magic-context/storage-meta-session.ts",
        "generic updateSessionMeta dispatcher; column names come from the fixed property->column map",
    ],
    [
        "features/magic-context/storage-meta-shared.ts",
        "same dispatcher for the shared harness; the region column is reachable only through persistCachedM0's pinned positional bind",
    ],
    [
        "features/magic-context/migrations.ts",
        "v34 clears-list and ensureColumn; the region column may not appear as a list pair (sub-law)",
    ],
    [
        "features/magic-context/store-generation-rebase.ts",
        "JSON-array prune columns; the region column may not be named at all (sub-law)",
    ],
    [
        "features/magic-context/storage-meta-persisted.ts",
        "CAS helper with a hard two-column allowlist; the region column may not be named at all (sub-law)",
    ],
    [
        "features/magic-context/storage-identity-merge.ts",
        "generic table-descriptor merge (never targets session_meta; asserted behaviorally in the merge law); static SQL may not assign the region column",
    ],
    [
        "features/magic-context/storage-schema-helpers.ts",
        "fallback defaults list for non-region columns only (sub-law: may not name cached_m0 columns)",
    ],
    [
        "scripts/clone-session.ts",
        "clone row-copy dispatcher: the region column is excluded from the dynamic SET and reset through the receipted funnel (sub-law)",
    ],
]);

// G3: `UPDATE session_meta SET` as a bare fragment is the closed set of
// every file allowed to write session_meta rows at all. A new file with the
// fragment is an offender until named here with a reason — this is what makes
// const-split / join-split assembly (`const sql = "UPDATE session_meta SET ";
// db.prepare(sql + cols)`) unable to hide: the fragment itself is census
// scope, not just its adjacency to an assembly operator. Files already
// sanctioned as writers or dynamic-SET exemptions are merged in below.
const STATIC_SET_WRITERS: ReadonlyMap<string, string> = new Map([
    [
        "cli/commands/migrate-session.ts",
        "project re-home: static cached_m1_bytes clear; region goes through the funnel",
    ],
    [
        "features/magic-context/compartment-storage.ts",
        "compartment marker/watermark meta columns (static)",
    ],
    [
        "features/magic-context/migration-v94-write-split.ts",
        "migration backfill of split columns (static)",
    ],
    [
        "features/magic-context/migrations.ts",
        "schema backfill statements (dynamic list pinned by sub-law)",
    ],
    ["features/magic-context/pi-content-decisions.ts", "Pi decision columns (static)"],
    ["features/magic-context/session-decision-calibration.ts", "calibration columns (static)"],
    ["features/magic-context/storage-db.ts", "fence/init meta column (static)"],
    [
        "features/magic-context/storage-identity-merge.ts",
        "identity rewrite (dynamic form pinned by sub-law; never targets session_meta)",
    ],
    [
        "features/magic-context/storage-meta-persisted.ts",
        "persisted meta CAS writers (dynamic form pinned by sub-law)",
    ],
    [
        "features/magic-context/storage-meta-session.ts",
        "generic meta dispatcher (dynamic form pinned by sub-law)",
    ],
    ["features/magic-context/storage-replay-document.ts", "replay-document column (static)"],
    [
        "features/magic-context/storage-schema-helpers.ts",
        "bulk column-safe resets (dynamic form pinned by sub-law)",
    ],
    [
        "features/magic-context/store-generation-rebase.ts",
        "generation rebase markers (dynamic form pinned by sub-law)",
    ],
    ["hooks/magic-context/compaction-off-transition.ts", "transition resets (static)"],
    ["hooks/magic-context/inject-compartments.ts", "m[0] marker/CAS columns (static)"],
    ["hooks/magic-context/note-nudger.ts", "note columns (static)"],
    [
        "pi/inject-compartments-pi.ts",
        "Pi head-cache writers (static; region rows are refused by the lane readers)",
    ],
    ["scripts/bench-store-generation-rebase.ts", "bench fixture meta seeding (static)"],
    ["scripts/clone-session.ts", "clone meta copy (dynamic form pinned by sub-law)"],
]);
const FRAGMENT_ALLOWED = new Set<string>([
    ...ALLOWED_WRITERS.keys(),
    ...ALLOWED_DYNAMIC_SET.keys(),
    ...STATIC_SET_WRITERS.keys(),
]);

const ALLOWED_RUST: ReadonlyMap<string, string> = new Map([
    [
        "mc-module/src/single_store_repair.rs",
        "baseline-set consistent reset (nulls the whole cached_m0_* family together; readers self-heal via first_render; region is never active on the Rust lane)",
    ],
    [
        "db.rs",
        "dashboard invalidate_all_memory_block_caches (external editor's cache-format reset, sanctioned class like the memory-epoch bump; erases the whole baseline family together and region rows self-heal through the reader contract — absent region folds at the next boundary)",
    ],
]);

// G3 (round 2): silent-zeroing defense for the eraser census. The walk
// loops `continue` on a missing/renamed root, so a dropped zone would
// otherwise shrink coverage while every law stays green. The canonical
// zone sets are declared here, shared by the census law and the floor law,
// and the floor asserts each root is present and yields production files.
const ERASER_RUST_ROOTS: Array<{ root: string; allowed: ReadonlyMap<string, string> }> = [
    { root: join(SRC_ROOT, "..", "..", "..", "crates"), allowed: ALLOWED_RUST },
    {
        root: join(SRC_ROOT, "..", "..", "dashboard", "src-tauri", "src"),
        allowed: ALLOWED_RUST,
    },
];

function collectRsFiles(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (entry !== "target") collectRsFiles(full, out);
            continue;
        }
        if (entry.endsWith(".rs") && !entry.endsWith("_tests.rs")) out.push(full);
    }
}

function eraserZoneScan(
    tsRoots: ReadonlyArray<{ dir: string; prefix: string }> = TS_ROOTS,
    rustRoots: Array<{ root: string }> = ERASER_RUST_ROOTS,
) {
    // Canonical membership is checked against the DECLARED zones, never the
    // passed list — dropping a zone from the scan must be visible, which is
    // the entire point of the floor.
    const issues: string[] = [];
    const counts: Array<{ zone: string; files: number }> = [];
    for (const canonical of TS_ROOTS) {
        const zone = canonical.prefix || "plugin/src";
        const entry = tsRoots.find((r) => r.prefix === canonical.prefix);
        if (!entry) {
            issues.push(`zone ${zone}: absent from the walk roots`);
            continue;
        }
        let isDir = false;
        try {
            isDir = statSync(entry.dir).isDirectory();
        } catch {
            isDir = false;
        }
        if (!isDir) {
            issues.push(`zone ${zone}: directory missing`);
            continue;
        }
        const out: string[] = [];
        collectTsFiles(entry.dir, out);
        if (out.length === 0) issues.push(`zone ${zone}: walked 0 production files`);
        counts.push({ zone, files: out.length });
    }
    for (const canonical of ERASER_RUST_ROOTS) {
        const zone = `rust:${relative(SRC_ROOT, canonical.root)}`;
        const entry = rustRoots.find((r) => r.root === canonical.root);
        if (!entry) {
            issues.push(`zone ${zone}: absent from the walk roots`);
            continue;
        }
        let isDir = false;
        try {
            isDir = statSync(entry.root).isDirectory();
        } catch {
            isDir = false;
        }
        if (!isDir) {
            issues.push(`zone ${zone}: directory missing`);
            continue;
        }
        const out: string[] = [];
        collectRsFiles(entry.root, out);
        if (out.length === 0) issues.push(`zone ${zone}: walked 0 production files`);
        counts.push({ zone, files: out.length });
    }
    return { issues, counts };
}

/** Deny-shape checks per dynamic-SET exemption. Returns a violation string or null. */
function subLawViolation(rel: string, text: string): string | null {
    const namesRegion = /cached_m0_bytes/.test(text);
    switch (rel) {
        case "features/magic-context/storage-meta-session.ts": {
            if (!namesRegion) return null;
            for (const m of text.matchAll(/cached_m0_bytes/g)) {
                const line = text.slice(
                    text.lastIndexOf("\n", m.index) + 1,
                    text.indexOf("\n", m.index),
                );
                if (
                    !/NULL AS cached_m0_bytes|cached_m0_bytes:\s*"cached_m0_bytes"|cached_m0_bytes:\s*"NULL AS/i.test(
                        line,
                    )
                ) {
                    return `region column named outside projections/column-map: ${line.trim()}`;
                }
            }
            return null;
        }
        case "features/magic-context/storage-meta-shared.ts": {
            if (!namesRegion) return null;
            // Deny shapes: an erase-list pair (the C1-era reset-list form) or
            // an assignment whose value is not the fold's positional bind.
            if (/\[\s*"cached_m0_bytes"\s*,/.test(text)) {
                return "region column in an erase-list pair";
            }
            for (const m of text.matchAll(/cached_m0_bytes\s*=\s*([^\n,;]*)/g)) {
                if (m[1].trim() !== "?") return `assignment to ${m[1].trim() || "<empty>"}`;
            }
            return null;
        }
        case "features/magic-context/migrations.ts": {
            if (/\[\s*"cached_m0_bytes"\s*,/.test(text)) {
                return "region column reachable through a clears list";
            }
            if (/cached_m0_bytes\s*=\s*(NULL|:|\$|@|excluded\.)/i.test(text)) {
                return "static assignment of the region column";
            }
            return null;
        }
        case "features/magic-context/store-generation-rebase.ts":
        case "features/magic-context/storage-meta-persisted.ts":
            return namesRegion ? "names the region column" : null;
        case "features/magic-context/storage-identity-merge.ts":
            return /cached_m0_bytes\s*=\s*(NULL|\?|[:@$]\w|excluded\.)/i.test(text)
                ? "static assignment of the region column"
                : null;
        case "features/magic-context/storage-schema-helpers.ts":
            return /cached_m0/.test(text) ? "names cached_m0 columns" : null;
        case "scripts/clone-session.ts": {
            if (!/column\.name !== "cached_m0_bytes"/.test(text))
                return "region column not excluded from the dynamic clone SET";
            if (!/clearSystemRegion\(db, destinationSessionId, "scripts_clone"\)/.test(text))
                return "clone does not reset the destination region through the funnel";
            if (/UPDATE\s+session_meta\s+SET[\s\S]{0,400}?cached_m0_bytes\s*=/.test(text))
                return "dynamic SET could assign the region column";
            return null;
        }
        default:
            return `dynamic-SET file ${rel} has no sub-law`;
    }
}

function collectTsFiles(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            if (!entry.startsWith(".")) collectTsFiles(full, out);
            continue;
        }
        // Round 11 (P1b): the widened pi-scripts root carries a real .cjs
        // probe — runtime-writable code is in scope regardless of extension.
        if (/\.(ts|mjs|cjs)$/.test(entry) && !entry.endsWith(".test.ts")) out.push(full);
    }
}

describe("system-region clear funnel: sole receipted eraser (L3/L7)", () => {
    it("the production tree has no raw cached_m0_bytes eraser outside the sanctioned funnel", () => {
        const offenders: string[] = [];
        const tsFiles: Array<{ rel: string; full: string }> = [];
        for (const { dir, prefix } of TS_ROOTS) {
            if (!statSync(dir).isDirectory()) continue;
            const out: string[] = [];
            collectTsFiles(dir, out);
            for (const full of out) tsFiles.push({ rel: prefix + relative(dir, full), full });
        }
        for (const { rel, full } of tsFiles) {
            const text = readFileSync(full, "utf8");
            if (!ALLOWED_WRITERS.has(rel)) {
                if (/cached_m0_bytes\s*=\s*(NULL|\?|[:@$]\w|excluded\.)/i.test(text)) {
                    offenders.push(`${rel} (assignment)`);
                }
                if (/REPLACE\s+INTO\s+session_meta/i.test(text)) {
                    offenders.push(`${rel} (REPLACE nulls the row)`);
                }
                // F2(b): an INSERT (or upsert) whose session_meta column list
                // mentions the region column writes it implicitly — the same
                // erase with no `=` anywhere. Only the funnel's own upsert may.
                if (
                    /INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+session_meta[\s\S]{0,500}?cached_m0_bytes/i.test(
                        text,
                    )
                ) {
                    offenders.push(`${rel} (INSERT column list names the region)`);
                }
            }
            // F2(a): a SET clause assembled by concatenation or join is a
            // dynamic SET wearing a static prefix; treat every form as such.
            const dynamicSet =
                /UPDATE\s+session_meta\s+SET\s*\$\{/.test(text) ||
                /UPDATE\s+session_meta\s+SET\s*["'`]\s*\+/.test(text) ||
                /UPDATE\s+session_meta\s+SET["'`]?\s*\.join\(/.test(text) ||
                /["'`]UPDATE session_meta SET ["'`]?\s*\+\s*\w+/.test(text);
            // G3/H2: the fragment is in census scope regardless of assembly
            // adjacency (const-split defeats proximity checks). Honest
            // boundary: the census deters ACCIDENTAL and SEMI-DELIBERATE
            // shapes — character-wise assembly and multi-hop computed
            // fragments (identifiers rebound through helpers before
            // reaching prepare) are uncoverable at regex strength, the same
            // disclosed class as the Rust zone. What is closed: any file
            // holding the fragment as text (whole or split at any single
            // string boundary) while also holding an assembly operator.
            if (/UPDATE session_meta SET/.test(text) && !FRAGMENT_ALLOWED.has(rel)) {
                offenders.push(`${rel} (unnamed session_meta SET writer)`);
            }
            // H2: the SET-less fragment is the other half of the split —
            // "UPDATE session_meta" closing its quote before SET, combined
            // in the same file with any SQL-assembly operator (+, .join(,
            // .concat(). A two-way split of the fragment cannot present
            // both halves without tripping this or the SET-side rule.
            if (
                /["'`]UPDATE\s+session_meta\s+["'`]/.test(text) &&
                /\+|\.join\(|\.concat\(/.test(text) &&
                !FRAGMENT_ALLOWED.has(rel)
            ) {
                offenders.push(`${rel} (SET-less session_meta fragment + assembly)`);
            }
            if (
                /session_meta/i.test(text) &&
                /(?:prepare|exec|run|all|get|iterate)\(\s*\w+\s*(?:\+|\.join\(|\.concat\()/.test(
                    text,
                )
            ) {
                offenders.push(`${rel} (identifier-led statement assembly)`);
            }
            if (dynamicSet) {
                if (!ALLOWED_DYNAMIC_SET.has(rel)) offenders.push(`${rel} (dynamic SET, unnamed)`);
                else {
                    const violation = subLawViolation(rel, text);
                    if (violation)
                        offenders.push(`${rel} (dynamic-SET exemption broken: ${violation})`);
                }
            }
        }
        // The Rust lane and the dashboard share context.db: their
        // column-literal writers are inventoried too, with named exemptions.
        // (A1: the census must not be silently narrower than the "production
        // tree" claim — every producer able to raw-null the column, in any
        // language that touches the DB, appears here or offends. Zone
        // presence/count floors are a dedicated law, G3.)
        const RUST_ROOTS = ERASER_RUST_ROOTS;
        for (const { root, allowed } of RUST_ROOTS) {
            if (!statSync(root).isDirectory()) continue;
            const walkRs = (dir: string) => {
                for (const entry of readdirSync(dir)) {
                    const full = join(dir, entry);
                    if (statSync(full).isDirectory()) {
                        if (entry !== "target") walkRs(full);
                        continue;
                    }
                    if (!entry.endsWith(".rs") || entry.endsWith("_tests.rs")) continue;
                    const rel = relative(root, full);
                    if (allowed.has(rel)) continue;
                    const rust = readFileSync(full, "utf8");
                    // F2(c): the literal is only one form. A reset-list pair
                    // (col, ResetValue::Null) or a format!/concatenated column
                    // name against session_meta is the same erase with the
                    // name moved off the SQL string; both offend. Fully
                    // opaque runtime-computed column names are beyond any
                    // regex census — this zone's claim is deliberately
                    // narrowed to shapes that name or stage the column.
                    if (/"cached_m0_bytes"|cached_m0_bytes\s*=\s*NULL/i.test(rust)) {
                        offenders.push(`${rel} (rust column writer, root=${root})`);
                    } else if (
                        /ResetValue::Null/.test(rust) &&
                        /session_meta|cached_m0/i.test(rust)
                    ) {
                        offenders.push(`${rel} (rust reset list, root=${root})`);
                    } else if (
                        /session_meta/i.test(rust) &&
                        /format!\s*\([^)]*cached_m0|\+\s*=\s*[^;]*cached_m0|push_str\(\s*"cached_m0/i.test(
                            rust,
                        )
                    ) {
                        offenders.push(`${rel} (rust dynamic column name, root=${root})`);
                    }
                }
            };
            walkRs(root);
        }
        // Exemption lists are load-bearing: an entry without a real reason is
        // a hole waiting to widen.
        for (const [file, reason] of [
            ...ALLOWED_WRITERS,
            ...ALLOWED_DYNAMIC_SET,
            ...ALLOWED_RUST,
        ]) {
            if (!reason || reason.length < 10) offenders.push(`unreasoned exemption ${file}`);
        }
        if (offenders.length > 0) console.log("OFFENDERS:", JSON.stringify(offenders, null, 1));
        expect(offenders).toEqual([]);
    });

    // G1 (round 2) closes the alias/rebind blind class for the call-site
    // counts by PROPERTY, not by enumerating call shapes (#2673): a
    // call-with-paren regex is blind to `import { persistCachedM0 as p };
    // p(…)` and `const p = persistCachedM0; p(…)`, and the raw-write census
    // cannot backstop it — the aliased call still lands in the sanctioned
    // funnel UPDATE, so nothing downstream reddens. The census is therefore
    // (callers ∪ bare-identifier-holders) compared against a blessed set:
    // ANY occurrence of the identifier outside its definition file must
    // name its holder file, whatever the syntax.
    const DEFINITION_PERSIST = "features/magic-context/storage-meta-shared.ts";
    const BLESSED_PERSIST_HOLDERS: ReadonlyMap<string, string> = new Map([
        [
            "hooks/magic-context/inject-compartments.ts",
            "fold lane caller (OpenCode-1 materializeM0, §23 D4 first named caller)",
        ],
        [
            "pi/inject-compartments-pi.ts",
            "fold lane caller (Pi materializeM0Pi, §23 D4 second named caller)",
        ],
        [
            "features/magic-context/storage.ts",
            "barrel re-export list entry (no call site, no local binding)",
        ],
        [
            "features/magic-context/storage-meta.ts",
            "barrel re-export list entry (no call site, no local binding)",
        ],
    ]);
    // Dispatcher-abuse surface: files carrying BOTH the dispatcher
    // identifier (any form) and a column-bytes write shape (object key or
    // member assignment). Each holder is adjudicated here with its role; a
    // new holder must be blessed or reddens.
    const BLESSED_DISPATCHER_HOLDERS: ReadonlyMap<string, string> = new Map([
        [
            "hooks/magic-context/transform-postprocess-phase.ts",
            "comparison operands only (null-gate + fold-bust m0Bytes pairing, lines ~1975-2012); never writes cachedM0Bytes",
        ],
        [
            "hooks/magic-context/transform.ts",
            "pass-local sessionMeta invalidation on a baseline-transition (in-memory object-key null, transform.ts:893); the DB row is erased by the funnel, not here",
        ],
        [
            "pi/context-handler.ts",
            "comparison/coverage operands (firstRenderBust shape, coverage guard, fold-bust before/after) + in-memory baseline invalidation (context-handler.ts:2788); never decodes or persists column bytes (§23 Pi census twin)",
        ],
    ]);
    function scanPersistCensuses(extraRoots: Array<{ dir: string; prefix: string }> = []) {
        const persistHolders: string[] = [];
        const persistCallers: string[] = [];
        const dispatcherHolders: string[] = [];
        const dispatcherAbusers: string[] = [];
        for (const { dir, prefix } of [...TS_ROOTS, ...extraRoots]) {
            const files: string[] = [];
            collectTsFiles(dir, files);
            for (const f of files) {
                const text = readFileSync(f, "utf8");
                const rel = prefix + relative(dir, f);
                if (prefix === "" && rel === DEFINITION_PERSIST) continue;
                if (/\bpersistCachedM0\b/.test(text)) {
                    persistHolders.push(rel);
                    if (/\bpersistCachedM0\s*\(/.test(text)) persistCallers.push(rel);
                }
                if (
                    /\bupdateSessionMeta\b/.test(text) &&
                    (/cachedM0Bytes\s*:/.test(text) || /\.cachedM0Bytes\s*=/.test(text))
                ) {
                    dispatcherHolders.push(rel);
                    if (/updateSessionMeta\s*\([\s\S]{0,400}?cachedM0Bytes/.test(text))
                        dispatcherAbusers.push(rel);
                }
            }
        }
        return { persistHolders, persistCallers, dispatcherHolders, dispatcherAbusers };
    }

    it("the region column has exactly the named fold-lane writer channels", () => {
        // persistCachedM0 is the fold-row writer: one production call site
        // per fold lane — the OpenCode-1 materialize and the Pi materialize
        // (§23 D4) — and no production caller may push cachedM0Bytes through
        // the generic updateSessionMeta dispatcher (that would bypass both
        // the funnel and the fold). Stage P2 widened the walk to the full
        // production surface (TS_ROOTS, #2665): the claim is repo-wide, not
        // plugin-package-local.
        const census = scanPersistCensuses();
        expect(census.persistHolders.sort()).toEqual([...BLESSED_PERSIST_HOLDERS.keys()].sort());
        expect(census.persistCallers.sort()).toEqual([
            "hooks/magic-context/inject-compartments.ts",
            "pi/inject-compartments-pi.ts",
        ]);
        expect(census.dispatcherHolders.sort()).toEqual(
            [...BLESSED_DISPATCHER_HOLDERS.keys()].sort(),
        );
        // Strict sub-law: no file may pass column bytes in a call-argument
        // window to the dispatcher — even blessed holders stay clean here.
        expect(census.dispatcherAbusers).toEqual([]);
    });

    it("control: alias/rebind plants redden the holder censuses (G1)", () => {
        // Mechanism attacks on the holder property, in a temp root (no
        // production tree is ever written): (1) import-alias persist rogue —
        // the call paren sits on the ALIAS, so the pre-G1 caller regex and
        // the blessed-caller equality would have missed it; (2)
        // const-rebind persist rogue — same blind class via a local
        // binding; (3) dispatcher alias rogue — abuse through
        // `const u = updateSessionMeta; u(db, s, { cachedM0Bytes: x })`,
        // invisible to the call-adjacency regex. Each plant must surface as
        // an unblessed holder name; removal regreens.
        const dir = mkdtempSync(join(tmpdir(), "mc-g1-plant-"));
        const plant = (name: string, body: string) => writeFileSync(join(dir, name), body);
        try {
            plant(
                "rogue_alias_persist.ts",
                'import { persistCachedM0 as p } from "x";\np(db, "s", {});\n',
            );
            let c = scanPersistCensuses([{ dir, prefix: "planted/" }]);
            expect(c.persistHolders).toContain("planted/rogue_alias_persist.ts");
            expect(c.persistHolders.sort()).not.toEqual([...BLESSED_PERSIST_HOLDERS.keys()].sort());
            // Old-shape proof: the canonical name is never followed by a
            // call paren, so the pre-G1 law was blind to this file.
            expect(
                /\bpersistCachedM0\s*\(/.test(
                    readFileSync(join(dir, "rogue_alias_persist.ts"), "utf8"),
                ),
            ).toBe(false);
            rmSync(join(dir, "rogue_alias_persist.ts"), { force: true });

            plant(
                "rogue_rebind_persist.ts",
                'import { persistCachedM0 } from "x";\nconst q = persistCachedM0;\nq(db, "s", {});\n',
            );
            c = scanPersistCensuses([{ dir, prefix: "planted/" }]);
            expect(c.persistHolders).toContain("planted/rogue_rebind_persist.ts");
            expect(
                /\bpersistCachedM0\s*\(/.test(
                    readFileSync(join(dir, "rogue_rebind_persist.ts"), "utf8"),
                ),
            ).toBe(false);
            rmSync(join(dir, "rogue_rebind_persist.ts"), { force: true });

            plant(
                "rogue_alias_dispatcher.ts",
                'import { updateSessionMeta as u } from "x";\nu(db, "s", { cachedM0Bytes: buf });\n',
            );
            c = scanPersistCensuses([{ dir, prefix: "planted/" }]);
            expect(c.dispatcherHolders).toContain("planted/rogue_alias_dispatcher.ts");
            expect(c.dispatcherHolders.sort()).not.toEqual(
                [...BLESSED_DISPATCHER_HOLDERS.keys()].sort(),
            );
            // Old-shape proof: the dispatcher name is never followed by its
            // call paren with column bytes in the window.
            expect(
                /updateSessionMeta\s*\([\s\S]{0,400}?cachedM0Bytes/.test(
                    readFileSync(join(dir, "rogue_alias_dispatcher.ts"), "utf8"),
                ),
            ).toBe(false);
            rmSync(join(dir, "rogue_alias_dispatcher.ts"), { force: true });

             // Steady state after removals: holder censuses match the
             // blessed sets again (plants leave no residue).
             const c2 = scanPersistCensuses([{ dir, prefix: "planted/" }]);
             expect(c2.persistHolders.sort()).toEqual([...BLESSED_PERSIST_HOLDERS.keys()].sort());
             expect(c2.dispatcherHolders.sort()).toEqual(
                 [...BLESSED_DISPATCHER_HOLDERS.keys()].sort(),
             );
         } finally {
             rmSync(dir, { recursive: true, force: true });
         }
     });

     // H1 (round 3): the holder census is FILE-granular — membership says
     // nothing about a blessed file's internals. Three shapes stay green
     // under G1 alone: (a) a second persistCachedM0() call inside a fold
     // file (holders/callers are sets, not counts); (b) an alias origin +
     // alias call inside a blessed barrel — the file is already blessed so
     // holders equality passes, and the canonical caller regex has no
     // `persistCachedM0(` paren to find; (c) `const u = updateSessionMeta;
     // u(db, s, { cachedM0Bytes })` inside a blessed dispatcher holder —
     // the abusers window requires the literal `updateSessionMeta(`.
     // Closure is PER-FILE BEHAVIOR: each blessed file must keep the
     // behavior its blessing justifies.
     const BLESSED_FOLD_CALL_COUNTS: ReadonlyMap<string, number> = new Map([
         ["hooks/magic-context/inject-compartments.ts", 1],
         ["pi/inject-compartments-pi.ts", 2],
     ]);
     function locateBlessedFile(rel: string): string | null {
         for (const { dir, prefix } of TS_ROOTS) {
             if (!rel.startsWith(prefix)) continue;
             const f = join(dir, rel.slice(prefix.length));
             if (statSync(f, { throwIfNoEntry: false })?.isFile()) return f;
         }
         return null;
     }
     function blessedBehaviorViolations(
         textOverrides: ReadonlyMap<string, string> = new Map(),
     ): string[] {
         const violations: string[] = [];
         for (const [rel, justification] of BLESSED_PERSIST_HOLDERS) {
             const f = locateBlessedFile(rel);
             if (!f) {
                 violations.push(`${rel}: blessed file missing from the production tree`);
                 continue;
             }
             const text = textOverrides.get(rel) ?? readFileSync(f, "utf8");
             const aliasOrigin =
                 /persistCachedM0\s+as\s+\w/.test(text) || /=\s*persistCachedM0\b/.test(text);
             const canonicalCalls = (text.match(/\bpersistCachedM0\s*\(/g) ?? []).length;
             if (justification.startsWith("barrel")) {
                 // The blessing claims: re-export entry only, no call site,
                 // no local binding. Anything else voids the blessing.
                 if (canonicalCalls > 0)
                     violations.push(`${rel}: barrel carries a canonical call site`);
                 if (aliasOrigin) violations.push(`${rel}: barrel carries an alias origin`);
             } else {
                 const blessed = BLESSED_FOLD_CALL_COUNTS.get(rel);
                 if (blessed === undefined)
                     violations.push(`${rel}: fold-lane holder without a blessed call count`);
                 else if (canonicalCalls !== blessed)
                     violations.push(
                         `${rel}: ${canonicalCalls} canonical persistCachedM0 calls, blessed ${blessed}`,
                     );
                 if (aliasOrigin)
                     violations.push(`${rel}: alias origin bypasses the canonical-name count`);
             }
         }
         for (const rel of BLESSED_DISPATCHER_HOLDERS.keys()) {
             const f = locateBlessedFile(rel);
             if (!f) {
                 violations.push(`${rel}: blessed file missing from the production tree`);
                 continue;
             }
             const text = textOverrides.get(rel) ?? readFileSync(f, "utf8");
             const aliases = new Set<string>();
             for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*updateSessionMeta\b/g))
                 aliases.add(m[1]);
             for (const m of text.matchAll(/updateSessionMeta\s+as\s+(\w+)/g)) aliases.add(m[1]);
             for (const alias of aliases) {
                 if (new RegExp(`\\b${alias}\\s*\\([\\s\\S]{0,400}?cachedM0Bytes`).test(text))
                     violations.push(
                         `${rel}: ${alias} (bound from updateSessionMeta) called near a column key`,
                     );
             }
         }
         return violations;
     }

     it("blessed files keep the per-file behavior their blessing justifies (H1)", () => {
         expect(blessedBehaviorViolations()).toEqual([]);
     });

     it("control: rogues planted INSIDE blessed-file copies redden the per-file law (H1)", () => {
         // Blessed-file copies in memory (the production tree is never
         // written); each plant must (1) redden blessedBehaviorViolations
         // and (2) be blind to the pre-H1 file-granular censuses — holders
         // equality (file already blessed) and the canonical regexes.
         const read = (rel: string) => {
             const f = locateBlessedFile(rel);
             if (!f) throw new Error(`missing blessed file ${rel}`);
             return readFileSync(f, "utf8");
         };

         // (a) second canonical call inside the OpenCode-1 fold file.
         const foldPlant = `${read("hooks/magic-context/inject-compartments.ts")}\npersistCachedM0(db, "s", { m0Bytes: null });\n`;
         expect(
             blessedBehaviorViolations(
                 new Map([["hooks/magic-context/inject-compartments.ts", foldPlant]]),
             ).some((v) => v.includes("blessed 1")),
         ).toBe(true);
         // Pre-H1 blindness: sets of files, counts unchanged.
         expect((read("hooks/magic-context/inject-compartments.ts").match(/\bpersistCachedM0\s*\(/g) ?? []).length).toBe(1);

         // (b) alias origin + alias call inside a blessed barrel.
         const barrelPlant = `${read("features/magic-context/storage.ts")}\nimport { persistCachedM0 as pp } from "x";\npp(db, "s", {});\n`;
         const barrelViolations = blessedBehaviorViolations(
             new Map([["features/magic-context/storage.ts", barrelPlant]]),
         );
         expect(barrelViolations.some((v) => v.includes("storage.ts") && v.includes("alias origin"))).toBe(true);
         // Pre-H1 blindness: file already in holders; no canonical paren for
         // the callers list — both censuses unchanged by this plant.
         expect(/\bpersistCachedM0\s*\(/.test(barrelPlant)).toBe(false);

         // (c) alias dispatcher call with the contracted column key inside a
         // blessed dispatcher holder. Padding keeps the plant outside the
         // 400-char window of any legitimate canonical updateSessionMeta(
         // call, so the pre-H1 abusers regex stays blind.
         const pad = "\n// " + "padding-gap".repeat(60) + "\n";
         const dispatcherPlant = `${read("hooks/magic-context/transform-postprocess-phase.ts")}${pad}const u = updateSessionMeta;\nu(db, s, { cachedM0Bytes: buf });\n`;
         expect(
             blessedBehaviorViolations(
                 new Map([["hooks/magic-context/transform-postprocess-phase.ts", dispatcherPlant]]),
             ).some((v) => v.includes("u (bound from updateSessionMeta)")),
         ).toBe(true);
         expect(
             /updateSessionMeta\s*\([\s\S]{0,400}?cachedM0Bytes/.test(
                 dispatcherPlant.slice(dispatcherPlant.indexOf(pad)),
             ),
         ).toBe(false);
     });

    it("the eraser census walks every canonical zone, present and non-empty (G3)", () => {
        // Defense against a silently narrowed "production tree": a missing
        // or empty root must fail HERE, naming the zone, not shrink the
        // eraser census coverage. The walked counts are recorded in the
        // failure message surface (asserted non-trivial) — every TS zone
        // and both Rust zones (crates/, dashboard src-tauri) must carry
        // production files.
        const { issues, counts } = eraserZoneScan();
        expect(counts.map((c) => `${c.zone}=${c.files}`).join(" ")).toContain("pi/");
        expect(counts.length).toBe(TS_ROOTS.length + ERASER_RUST_ROOTS.length);
        expect(issues).toEqual([]);
    });

    it("control: mutated root lists redden the zone floor with the zone named (G3)", () => {
        // In-memory mutations only — no production tree is renamed, moved,
        // or emptied.
        const tsMutated = TS_ROOTS.filter((r) => r.prefix !== "pi/");
        expect(
            eraserZoneScan(tsMutated).issues.some((i) => i.includes("pi/") && i.includes("absent")),
        ).toBe(true);
        const emptyDir = mkdtempSync(join(tmpdir(), "mc-g3-empty-"));
        try {
            // A canonical zone whose dir is present-but-empty reddens with
            // the count, not the existence message (in-memory roots
            // substitution: the declared zone stays, its dir points at an
            // empty temp dir).
            const withEmpty = TS_ROOTS.map((r) =>
                r.prefix === "cli/" ? { dir: emptyDir, prefix: r.prefix } : r,
            );
            const issues = eraserZoneScan(withEmpty).issues;
            expect(issues.some((i) => i.includes("cli/") && i.includes("0 production files"))).toBe(
                true,
            );
        } finally {
            rmSync(emptyDir, { recursive: true, force: true });
        }
        const rustMutated = ERASER_RUST_ROOTS.filter((r) => !r.root.endsWith("crates"));
        expect(
            eraserZoneScan(TS_ROOTS, rustMutated).issues.some(
                (i) => i.includes("crates") && i.includes("absent"),
            ),
        ).toBe(true);
        // Steady state regreens.
        expect(eraserZoneScan().issues).toEqual([]);
    });

    it("the baseline invalidation funnel receipts region erases", async () => {
        // clearCachedM0M1 (structural compartment invalidation) must route the
        // region column through the receipted funnel, never the clears list.
        const { clearCachedM0M1 } = await import(
            "../../features/magic-context/storage-meta-shared"
        );
        const db = freshDb();
        seedRegion(db, "ses-baseline-clear");
        lines.length = 0;
        clearCachedM0M1(db as never, "ses-baseline-clear", "boundary_repair");
        expect(readSystemRegion(db, "ses-baseline-clear")).toBeNull();
        expect(clearedLines()).toEqual(["system-region cleared reason=boundary_repair"]);
    });

    it("K1: malformed reasons never fatal — the funnel sanitizes, logs a named violation, proceeds", () => {
        // Reason is receipt text, not policy: a throw inside the
        // materialization transaction is itself the wedge (throw, re-mint,
        // wedge) no matter how good the mint census is. The floor must not
        // be fatal. Grammar violations are sanitized to the legal shape and
        // the RAW token is preserved verbatim in a loud violation receipt;
        // programmer typos stay caught by the test-time grammar laws.
        const malformed = ["", "With Space", "UPPER", "dash-x", "ab", "x".repeat(60), "tab\tx"];
        for (const reason of malformed) {
            const db = freshDb();
            seedRegion(db, "ses-reason-guard");
            lines.length = 0;
            expect(() =>
                executeSystemRegionRotation(
                    db as never,
                    "ses-reason-guard",
                    reason,
                    "<project-memory>y</project-memory>",
                    {} as never,
                    () => {},
                ),
            ).not.toThrow();
            expect(
                lines.some(
                    (line) =>
                        line.startsWith("system-region receipt-violation:") &&
                        line.includes("fn=executeSystemRegionRotation") &&
                        line.includes(`raw=${JSON.stringify(reason)}`),
                ),
            ).toBe(true);
            const rot = lines.find((line) => line.startsWith("system-region rotation:"));
            expect(rot).toBeDefined();
            expect(rot).toContain("executed=true");
            const used = /reason=(\S+) executed=true/.exec(rot!)![1];
            expect(used).toMatch(/^[a-z][a-z0-9_]{2,47}(?::[^\s]{1,120})?$/);
            expect(used.length).toBeLessThanOrEqual(48 + 1 + 120);
            expect(() => clearSystemRegion(db as never, "ses-reason-guard", reason)).not.toThrow();
            expect(readSystemRegion(db, "ses-reason-guard")).toBeNull();
            expect(
                lines.some(
                    (line) =>
                        line.startsWith("system-region receipt-violation:") &&
                        line.includes("fn=clearSystemRegion"),
                ),
            ).toBe(true);
            expect(() => clearAllSystemRegions(db as never, reason)).not.toThrow();
            expect(() =>
                clearSystemRegionsByProjectIdentity(db as never, ["git:x"], reason),
            ).not.toThrow();
        }
        // Refusal semantics survive the non-fatal floor: a forged payload
        // with a malformed reason is still refused and erases nothing.
        {
            const db = freshDb();
            seedRegion(db, "ses-reason-guard");
            lines.length = 0;
            expect(() =>
                executeSystemRegionRotation(
                    db as never,
                    "ses-reason-guard",
                    "Bad Reason",
                    // Genuinely refused: the never-empty floor rejects this
                    // payload (a mid-string sentinel is not a forgery — the
                    // forger must LEAD with it, which encodeSystemRegionRow
                    // owns; empty is the honest refusal shape here).
                    "",
                    {} as never,
                    () => {},
                ),
            ).not.toThrow();
            const rot = lines.find((line) => line.startsWith("system-region rotation:"));
            expect(rot).toContain("executed=false");
            expect(readSystemRegion(db, "ses-reason-guard")).toBe(
                "<project-memory>x</project-memory>",
            );
        }
        // Well-formed tokens never produce a violation line, including the
        // composite receipt shape the rotation lane passes.
        {
            const db = freshDb();
            seedRegion(db, "ses-reason-guard");
            lines.length = 0;
            clearSystemRegion(db as never, "ses-reason-guard", "render_config:budget(m8000→m1000)");
            expect(lines.some((line) => line.includes("receipt-violation"))).toBe(false);
            expect(readSystemRegion(db, "ses-reason-guard")).toBeNull();
        }
    });

    it("clearSystemRegion receipts the event and leaves the row unreadable as a region", () => {
        const db = freshDb();
        seedRegion(db, "ses-clear-funnel");
        lines.length = 0;
        clearSystemRegion(db as never, "ses-clear-funnel", "test_reason");
        expect(readSystemRegion(db, "ses-clear-funnel")).toBeNull();
        expect(clearedLines()).toEqual(["system-region cleared reason=test_reason"]);
    });

    it("clearing an absent region is not an event and leaves no line", () => {
        const db = freshDb();
        getOrCreateSessionMeta(db, "ses-absent-clear");
        lines.length = 0;
        clearSystemRegion(db as never, "ses-absent-clear", "nothing_here");
        expect(clearedLines()).toEqual([]);
    });

    it("identity merge clears region rows through the funnel with a named receipt", async () => {
        const { mergeProjectIdentities } = await import(
            "../../features/magic-context/storage-identity-merge"
        );
        const db = freshDb();
        seedRegion(db, "ses-merge-a");
        seedRegion(db, "ses-merge-b");
        db.prepare(
            "UPDATE session_meta SET cached_m0_project_identity = ? WHERE session_id IN (?, ?)",
        ).run("/identity/from", "ses-merge-a", "ses-merge-b");
        // Give the merge a changed row to process (it early-returns on a
        // zero-change audit — and the raw eraser historically lived behind
        // that early return).
        const { insertMemory } = await import("../../features/magic-context/memory/storage-memory");
        insertMemory(db as never, {
            projectPath: "/identity/from",
            category: "ARCHITECTURE",
            content: "merge me",
        });
        lines.length = 0;
        const report = mergeProjectIdentities(db as never, "/identity/from", "/identity/to");
        // The generic table-descriptor writer must never target the region's
        // home table: session_meta is not a project-identity-scoped table.
        expect(report.auditedTables.some((t) => t.tableName === "session_meta")).toBe(false);
        expect(readSystemRegion(db, "ses-merge-a")).toBeNull();
        expect(readSystemRegion(db, "ses-merge-b")).toBeNull();
        const receipts = clearedLines().filter((line) => line.includes("reason=identity_merge"));
        expect(receipts.length).toBe(1);
        expect(receipts[0]).toContain("count=2");
        // Next-pass repair: the cleared row folds a fresh region, as designed.
        const { mustMaterialize } = await import("./inject-compartments");
        const decision = mustMaterialize({
            db,
            sessionId: "ses-merge-a",
            state: getOrCreateSessionMeta(db, "ses-merge-a"),
            projectPath: "/identity/to",
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        // A cleared row folds immediately: null bytes short-circuit to
        // first_render; a stale head-era row would say region_first_install.
        expect(["first_render", "region_first_install"]).toContain(decision.reason);
    });

    it("session clone clears the destination region row through the funnel", async () => {
        const { copySessionStateForClone } = await import(
            "../../features/magic-context/storage-clone"
        );
        const db = freshDb();
        seedRegion(db, "ses-clone-src");
        seedRegion(db, "ses-clone-dst");
        const filter = {
            resolveBoundaryOrdinal: () => 1,
            includeTag: () => true,
            includeMessageId: () => true,
            selectPendingPiMarker: () => null,
        };
        lines.length = 0;
        copySessionStateForClone(db as never, "ses-clone-src", "ses-clone-dst", filter as never);
        expect(readSystemRegion(db, "ses-clone-dst")).toBeNull();
        expect(clearedLines().some((line) => line.includes("reason=storage_clone"))).toBe(true);
        // The source row is untouched by a clone.
        expect(readSystemRegion(db, "ses-clone-src")).toBe("<project-memory>x</project-memory>");
    });

    it("compaction-off transition clears the region through the funnel with a receipt", async () => {
        const { reconcileCompactionMode } = await import("./compaction-off-transition");
        const db = freshDb();
        seedRegion(db, "ses-off-transition");
        lines.length = 0;
        reconcileCompactionMode({
            db,
            sessionId: "ses-off-transition",
            compactionOff: true,
            historianRunnable: false,
            compartmentInProgress: false,
            cleanupMarkers: () =>
                ({
                    cleaned: true,
                    clearedMarkerCount: 0,
                    markerStates: [],
                }) as never,
        });
        expect(readSystemRegion(db, "ses-off-transition")).toBeNull();
        expect(
            clearedLines().some((line) => line.includes("reason=compaction_off_transition")),
        ).toBe(true);
    });
});

describe("system-region migration erasers route through the funnel", () => {
    it.each([
        26, 30, 34,
    ])("migration v%i clears installed regions with a named receipt", async (v) => {
        const { MIGRATIONS } = await import("../../features/magic-context/migrations");
        const db = freshDb();
        seedRegion(db, `ses-mig-${v}`);
        lines.length = 0;
        const entry = MIGRATIONS.find((m) => m.version === v);
        expect(entry).toBeDefined();
        entry!.up(db as never);
        expect(readSystemRegion(db, `ses-mig-${v}`)).toBeNull();
        expect(clearedLines().some((line) => line.includes(`reason=migration_v${v}`))).toBe(true);
    });
});

describe("system-region baseline-invalidation per-call receipts (A1)", () => {
    it("every production clearCachedM0M1 call site passes a named reason", () => {
        // Structural law: the region column's fate rides the baseline
        // invalidation funnel, and L7 requires a NAMED reason per CALL — a
        // per-file or defaulted reason would let new callers erase regions
        // anonymously. The signature makes the parameter required (compile
        // time); this law pins the value: non-empty literal or `reason`
        // forwarded from the enclosing signature.
        // G2a: same four-zone walk as the eraser census — a caller added in
        // the CLI, the Pi package, or the scripts zone must not be able to
        // erase regions anonymously.
        const zoneFiles: Array<{ rel: string; full: string }> = [];
        for (const { dir, prefix } of TS_ROOTS) {
            if (!statSync(dir).isDirectory()) continue;
            const out: string[] = [];
            collectTsFiles(dir, out);
            for (const full of out) zoneFiles.push({ rel: prefix + relative(dir, full), full });
        }
        const violations: string[] = [];
        for (const { rel, full } of zoneFiles) {
            if (rel === "features/magic-context/storage-meta-shared.ts") continue;
            const text = readFileSync(full, "utf8");
            for (const m of text.matchAll(/clearCachedM0M1\(([^)]*)\)/g)) {
                const args = m[1];
                const third = args.split(",").slice(2).join(",").trim();
                if (!/^(?:"[a-z0-9_]{3,}"|reason)$/.test(third)) {
                    violations.push(`${rel}: (${args.trim()})`);
                }
            }
        }
        expect(violations).toEqual([]);
    });
});
