/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

// ── FPE carrier-parity gate (plan Unit 8; raised by the Unit 5 merge gate) ──
// The defect class: a lane that MINTS full-mode drop carriers (FPE tokens in
// the copy-source seat of a tool call) without registering the released-input
// resolver on its `execute.before` composition. The v2 lane shipped exactly
// this (minted tokens, guard-only composition) — a re-emitted drop token would
// have executed verbatim as tool input. The Unit 5 closure wired the resolver;
// THIS gate makes the mint-without-resolve class structurally unshipable:
//   law 1  — for every `execute.before` composition site whose transitive
//            static value-import closure reaches a mint site, the site itself
//            must import the fpe-resolve composition (a lane dropping its
//            resolver registration reddens; a new minting lane without one
//            reddens);
//   law 2  — every mint holder is an adjudicated, closed set (a new file that
//            mints reddens until named);
//   law 3  — Pi stays non-FPE by design: no pi-plugin production file imports
//            or calls the fpe family (the gate asserts the mirror mints no
//            carriers rather than forcing a resolver onto pi).
// Scanning uses the TypeScript parser (the Unit 5 volatile-census walker
// pattern), never a regex over raw source: comments, string/template literals
// and regex literals can neither fake an import nor hide a real one. Type-only
// edges are skipped — erased at emit, they cannot execute.

type ImportEdge = { names: string[]; spec: string; kind: string };

const AST_CACHE = new Map<string, ts.SourceFile>();
function parseFile(fileName: string, text: string): ts.SourceFile {
    const key = `${fileName}:${text.length}`;
    const cached = AST_CACHE.get(key);
    if (cached) return cached;
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    AST_CACHE.set(key, sf);
    return sf;
}

function importEdges(text: string, fileName: string): ImportEdge[] {
    const sf = parseFile(fileName, text);
    const edges: ImportEdge[] = [];
    const clause = (c: ts.ImportClause | undefined, spec: string): void => {
        if (!c || c.isTypeOnly) return;
        const nb = c.namedBindings;
        if (nb && ts.isNamedImports(nb)) {
            const vals = nb.elements.filter((e) => !e.isTypeOnly).map((e) => e.name.text);
            if (vals.length) edges.push({ names: vals, spec, kind: "named" });
        } else if (nb && ts.isNamespaceImport(nb)) {
            edges.push({ names: ["*"], spec, kind: "namespace" });
        } else {
            edges.push({
                names: [c.name ? c.name.text : "_default"],
                spec,
                kind: "default",
            });
        }
    };
    const walk = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            if (!n.importClause)
                edges.push({
                    names: [],
                    spec: n.moduleSpecifier.text,
                    kind: "sideeffect",
                });
            else clause(n.importClause, n.moduleSpecifier.text);
        }
        if (
            ts.isCallExpression(n) &&
            n.expression.kind === ts.SyntaxKind.ImportKeyword &&
            n.argument !== undefined &&
            ts.isStringLiteral(n.argument)
        ) {
            // Dynamic import with a literal specifier: statically enumerable,
            // and the OpenCode-1 entry's lazy hooks phase (which installs the
            // composed hook map) is exactly such an edge.
            edges.push({ names: ["*"], spec: n.argument.text, kind: "dynamic" });
        }
        if (
            ts.isExportDeclaration(n) &&
            n.moduleSpecifier &&
            ts.isStringLiteral(n.moduleSpecifier) &&
            !n.isTypeOnly
        ) {
            const spec = n.moduleSpecifier.text;
            if (!n.exportClause) edges.push({ names: ["*"], spec, kind: "star" });
            else if (ts.isNamedExports(n.exportClause)) {
                const vals = n.exportClause.elements
                    .filter((e) => !e.isTypeOnly)
                    .map((e) => e.name.text);
                if (vals.length) edges.push({ names: vals, spec, kind: "reexport" });
            }
        }
        ts.forEachChild(n, walk);
    };
    walk(sf);
    return edges;
}

/** Identifiers actually referenced in code position (never comments/strings). */
function referencedIdentifiers(text: string, fileName: string): Set<string> {
    const sf = parseFile(fileName, text);
    const ids = new Set<string>();
    const walk = (n: ts.Node): void => {
        if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent)) ids.add(n.text);
        ts.forEachChild(n, walk);
    };
    walk(sf);
    return ids;
}

/** String literals in VALUE position (a type union member is not a hook
 *  registration). Type-node subtrees are skipped entirely. */
function stringLiterals(text: string, fileName: string): Set<string> {
    const sf = parseFile(fileName, text);
    const out = new Set<string>();
    const walk = (n: ts.Node, inType: boolean): void => {
        const inTypeHere = inType || ts.isTypeNode(n);
        if (ts.isStringLiteral(n) && !inTypeHere) out.add(n.text);
        ts.forEachChild(n, (child) => walk(child, inTypeHere));
    };
    walk(sf, false);
    return out;
}

// Census walk roots (#2665 form): the full TS production surface EXCEPT the pi
// zone, which law 3 covers with its own non-minting property. Named deny-list
// per #2720; test files are census-exempt (they may mint fixtures).
const WALK_ROOTS = [
    { dir: join(import.meta.dir, "../../../../plugin/src"), prefix: "" },
    { dir: join(import.meta.dir, "../../../../plugin/scripts"), prefix: "scripts/" },
    { dir: join(import.meta.dir, "../../../../cli/src"), prefix: "cli/" },
];
const WALK_DENY_DIRS = new Set([".git", "node_modules", "dist", ".codegraph"]);
const PRODUCTION_FILE = /\.(ts|tsx|mts|cts|mjs|cjs)$/;

interface WalkFile {
    rel: string;
    full: string;
    text: string;
}

function collectFiles(dir: string, prefix: string, out: WalkFile[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir).sort();
    } catch {
        return;
    }
    for (const entry of entries) {
        const full = join(dir, entry);
        let stat: { isDirectory(): boolean };
        try {
            stat = statSync(full);
        } catch {
            continue;
        }
        if (stat.isDirectory()) {
            if (!WALK_DENY_DIRS.has(entry)) collectFiles(full, `${prefix}${entry}/`, out);
            continue;
        }
        if (PRODUCTION_FILE.test(entry) && !entry.endsWith(".test.ts")) {
            out.push({ rel: `${prefix}${entry}`, full, text: readFileSync(full, "utf8") });
        }
    }
}

function walkProduction(extraRoots: Array<{ dir: string; prefix: string }> = []): WalkFile[] {
    const out: WalkFile[] = [];
    for (const { dir, prefix } of [...WALK_ROOTS, ...extraRoots]) collectFiles(dir, prefix, out);
    return out;
}

// ── The fpe family vocabulary (named explicitly — law 2 and the Pi law) ──
const FPE_MINT_ENTRY = "renderDropToken";
const FPE_DEFINITION = "hooks/magic-context/fpe.ts";
const FPE_FAMILY_CALLS = new Set([
    "renderDropToken",
    "fpeEncrypt",
    "fpeDecrypt",
    "fpeGate",
    "isFpeTokenCandidate",
]);
const FPE_RESOLVE_MODULE = "fpe-resolve";
const RESOLVER_COMPOSITION_IMPORTS = new Set([
    "createToolExecuteBeforeHook",
    "resolveReleasedToolInput",
]);
const EXECUTE_BEFORE_HOOK_NAMES = new Set(["execute.before", "tool.execute.before"]);

function resolveSpecifier(fromRel: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null;
    const fromParts = fromRel.split("/");
    fromParts.pop();
    for (const part of spec.split("/")) {
        if (part === ".") continue;
        if (part === "..") fromParts.pop();
        else fromParts.push(part);
    }
    const bare = fromParts.join("/");
    if (filesByRel.has(`${bare}.ts`)) return `${bare}.ts`;
    if (filesByRel.has(`${bare}/index.ts`)) return `${bare}/index.ts`;
    return null;
}

let walked: WalkFile[] = [];
let filesByRel = new Map<string, WalkFile>();
let edgesByFile = new Map<string, ImportEdge[]>();
let idsByFile = new Map<string, Set<string>>();
let stringsByFile = new Map<string, Set<string>>();

function indexProduction(): void {
    walked = walkProduction();
    filesByRel = new Map(walked.map((f) => [f.rel, f]));
    edgesByFile = new Map();
    idsByFile = new Map();
    stringsByFile = new Map();
    for (const f of walked) {
        edgesByFile.set(f.rel, importEdges(f.text, f.full));
        idsByFile.set(f.rel, referencedIdentifiers(f.text, f.full));
        stringsByFile.set(f.rel, stringLiterals(f.text, f.full));
    }
}

/** Transitive static value-import closure (external specifiers terminate). */
function importClosure(rel: string, seen = new Set<string>()): Set<string> {
    if (seen.has(rel)) return seen;
    seen.add(rel);
    for (const edge of edgesByFile.get(rel) ?? []) {
        const target = resolveSpecifier(rel, edge.spec);
        if (target) importClosure(target, seen);
    }
    return seen;
}

function mintsCarriers(rel: string): boolean {
    const id = idsByFile.get(rel);
    if (!id) return false;
    if (id.has(FPE_MINT_ENTRY) && rel !== FPE_DEFINITION) return true;
    for (const reached of importClosure(rel)) {
        if (reached === rel) continue;
        if (reached === FPE_DEFINITION) continue;
        if (idsByFile.get(reached)?.has(FPE_MINT_ENTRY) === true) return true;
    }
    return false;
}

function registersExecuteBefore(rel: string): boolean {
    for (const lit of stringsByFile.get(rel) ?? []) {
        if (EXECUTE_BEFORE_HOOK_NAMES.has(lit)) return true;
    }
    return false;
}

function importsResolverComposition(rel: string): boolean {
    for (const edge of edgesByFile.get(rel) ?? []) {
        if (!edge.spec.includes(FPE_RESOLVE_MODULE)) continue;
        if (edge.names.some((n) => RESOLVER_COMPOSITION_IMPORTS.has(n))) return true;
    }
    return false;
}

/** The resolver is wired for this lane: the site imports the composition
 *  itself, or its static/dynamic import closure reaches a module that does
 *  (the OpenCode-1 entry adopts the hook.ts-composed map through the lazy
 *  hooks phase — a dynamic edge, which the closure follows). */
function resolverWiredForLane(rel: string): boolean {
    if (importsResolverComposition(rel)) return true;
    for (const reached of importClosure(rel)) {
        if (reached === rel) continue;
        if (importsResolverComposition(reached)) return true;
    }
    return false;
}

// The adjudicated sets at this tip. A new member reddens until it is named
// here with a reason — the closed-vocabulary pin (the volatile-census arm c).
// shared/tag-transcript.ts joined with the drop-shape doctrine restore
// (2026-11-06 coordinator ruling, carrier option): the aggregate drop()/
// truncate() and buildToolTarget drop()/truncate() arms mint carriers via
// renderDropToken(tagId, sessionKey) byte-exact to 9c1520810:packages/plugin/
// src/shared/tag-transcript.ts:1108,:1388. It registers no execute.before
// hook (law 1's mint-reachability term is hook-lane-scoped), and every
// rendered carrier reaches the wire through the resolver-wired lanes
// (hook.ts / v2/hooks/context.ts composition sites below).
const BLESSED_MINT_HOLDERS = new Set([
    "hooks/magic-context/tool-drop-target.ts",
    "shared/tag-transcript.ts",
]);
// The v1 composition (createToolExecuteBeforeHook wired into the hook map).
// The v2 composition (Unit 5 closure: guard-then-resolver). The third site is
// the OpenCode-1 entry's delegation shape: its handler forwards the event to
// the hook.ts-composed runtime hook (the resolver registers there). The two
// trial host-plugins emulate the host contract for the priming/self-tag
// trials; they are mint-free, so the composition law's mint-reachability
// term excludes them — they are blessed as sites only.
const BLESSED_COMPOSITION_SITES = new Set([
    "hooks/magic-context/hook.ts",
    "v2/hooks/context.ts",
    "index.ts",
    "scripts/priming-trial/host-plugin.mjs",
    "scripts/self-tag-trial/host-plugin.mjs",
]);

describe("fpe carrier-parity gate (plan Unit 8, U5 merge-gate finding)", () => {
    it("the composition law: every minting lane's execute.before imports the resolver", () => {
        indexProduction();
        const offenders: string[] = [];
        for (const f of walked) {
            if (!registersExecuteBefore(f.rel)) continue;
            if (!mintsCarriers(f.rel)) continue;
            if (!resolverWiredForLane(f.rel)) {
                offenders.push(
                    `${f.rel}: registers execute.before, reaches a mint site, and imports no fpe-resolve composition — a re-emitted drop token would execute verbatim as tool input`,
                );
            }
        }
        expect(offenders).toEqual([]);
    });

    it("the mint holders are a closed, adjudicated set", () => {
        indexProduction();
        const holders = walked
            .filter((f) => f.rel !== FPE_DEFINITION)
            .filter((f) => idsByFile.get(f.rel)?.has(FPE_MINT_ENTRY))
            .map((f) => f.rel)
            .sort();
        expect(holders).toEqual([...BLESSED_MINT_HOLDERS].sort());
        // The composition sites are the same closed set: a NEW execute.before
        // registration in the production tree is a new lane and must be
        // adjudicated (then law 1 judges its resolver wiring).
        const sites = walked
            .filter((f) => registersExecuteBefore(f.rel))
            .map((f) => f.rel)
            .sort();
        expect(sites).toEqual([...BLESSED_COMPOSITION_SITES].sort());
    });

    it("rogue witness: an unblessed mint holder reddens the holder census (#2780)", () => {
        const plantDir = createTestTempDirFromPath(join(tmpdir(), "mc-fpe-plant-"));
        const plantedRel = "planted/rogue-mint.ts";
        try {
            writeFileSync(
                join(plantDir, "rogue-mint.ts"),
                'import { renderDropToken } from "../../hooks/magic-context/fpe";\nexport const mint = (tagId: number, key: bigint) => renderDropToken(tagId, key);\n',
            );
            const planted = walkProduction([{ dir: plantDir, prefix: "planted/" }]);
            const holders = planted
                .filter((f) => f.rel !== FPE_DEFINITION)
                .filter((f) => referencedIdentifiers(f.text, f.full).has(FPE_MINT_ENTRY))
                .map((f) => f.rel);
            expect(holders).toContain(plantedRel);
            // The steady census (production roots only) stays clean — the plant
            // surfaces only when its root is walked, which is exactly how a real
            // new mint holder under the production roots surfaces.
            const productionHolders = walkProduction()
                .filter((f) => f.rel !== FPE_DEFINITION)
                .filter((f) => idsByFile.get(f.rel)?.has(FPE_MINT_ENTRY))
                .map((f) => f.rel);
            expect(productionHolders).toEqual([...BLESSED_MINT_HOLDERS].sort());
        } finally {
            rmSync(plantDir, { recursive: true, force: true });
        }
    });

    it("rogue witness: a minting execute.before composition without the resolver reddens the composition law (#2780)", () => {
        const plantDir = createTestTempDirFromPath(join(tmpdir(), "mc-fpe-lane-"));
        try {
            // A lane that registers execute.before, reaches the mint site (a
            // value-import of the mint holder) and wires ONLY the guard — the
            // exact v2 defect shape (minted tokens, guard-only composition).
            writeFileSync(
                join(plantDir, "rogue-lane.ts"),
                [
                    'import { renderDropToken } from "../../hooks/magic-context/fpe";',
                    'import { createDroppedInputGuard } from "../../hooks/magic-context/dropped-input-guard";',
                    "export async function registerLane(context: { tool: { hook: (n: string, h: unknown) => Promise<void> } }): Promise<void> {",
                    "  const guard = createDroppedInputGuard();",
                    '  await context.tool.hook("execute.before", (draft: unknown) => {',
                    "    void guard;",
                    "    void renderDropToken(1, 2n);",
                    "  });",
                    "}",
                ].join("\n"),
            );
            const planted = walkProduction([{ dir: plantDir, prefix: "planted/" }]);
            const offenders: string[] = [];
            for (const f of planted) {
                if (!stringLiterals(f.text, f.full).has("execute.before")) continue;
                if (!referencedIdentifiers(f.text, f.full).has(FPE_MINT_ENTRY)) continue;
                const selfResolves = importEdges(f.text, f.full).some(
                    (edge) =>
                        edge.spec.includes(FPE_RESOLVE_MODULE) &&
                        edge.names.some((n) => RESOLVER_COMPOSITION_IMPORTS.has(n)),
                );
                if (!selfResolves) offenders.push(f.rel);
            }
            expect(offenders).toContain("planted/rogue-lane.ts");
        } finally {
            rmSync(plantDir, { recursive: true, force: true });
        }
    });

    // Pi stays non-FPE by design (plan Unit 8): the Pi mirror mints NO FPE
    // carriers — no pi-plugin production file value-imports the fpe family
    // modules or references the fpe calls / the released sentinel by name.
    // A future pi mint reddens here and must be adjudicated into a resolver-
    // wired lane, not silently shipped.
    it("the Pi mirror mints no FPE carriers (pi production scans clean)", () => {
        const piRoots = [
            { dir: join(import.meta.dir, "../../../../pi-plugin/src"), prefix: "pi/" },
            { dir: join(import.meta.dir, "../../../../pi-plugin/scripts"), prefix: "pi/scripts/" },
        ];
        const piFiles: WalkFile[] = [];
        for (const { dir, prefix } of piRoots) collectFiles(dir, prefix, piFiles);
        expect(piFiles.length).toBeGreaterThan(50);
        const offenders: string[] = [];
        for (const f of piFiles) {
            for (const edge of importEdges(f.text, f.full)) {
                if (!/\/fpe(-resolve)?("|')?$/.test(edge.spec)) continue;
                if (edge.names.some((n) => FPE_FAMILY_CALLS.has(n) || n === "deriveKey")) {
                    offenders.push(`${f.rel}: imports the fpe family (${edge.spec})`);
                }
            }
            const ids = referencedIdentifiers(f.text, f.full);
            for (const name of FPE_FAMILY_CALLS) {
                if (ids.has(name)) offenders.push(`${f.rel}: references ${name}`);
            }
            if (ids.has("TOOL_RELEASED_SENTINEL")) {
                offenders.push(`${f.rel}: references TOOL_RELEASED_SENTINEL`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it("rogue witness: a pi file minting an fpe carrier reddens the Pi law (#2780)", () => {
        const plantDir = createTestTempDirFromPath(join(tmpdir(), "mc-fpe-pi-plant-"));
        try {
            writeFileSync(
                join(plantDir, "rogue-pi-mint.ts"),
                'import { renderDropToken } from "../../plugin/src/hooks/magic-context/fpe";\nexport const t = (id: number, k: bigint) => renderDropToken(id, k);\n',
            );
            const planted: WalkFile[] = [
                {
                    rel: "pi/rogue-pi-mint.ts",
                    full: join(plantDir, "rogue-pi-mint.ts"),
                    text: readFileSync(join(plantDir, "rogue-pi-mint.ts"), "utf8"),
                },
            ];
            const offenders: string[] = [];
            for (const f of planted) {
                for (const edge of importEdges(f.text, f.full)) {
                    if (!/\/fpe(-resolve)?("|')?$/.test(edge.spec)) continue;
                    if (edge.names.some((n) => FPE_FAMILY_CALLS.has(n))) {
                        offenders.push(`${f.rel}: imports the fpe family (${edge.spec})`);
                    }
                }
            }
            expect(offenders).toEqual([
                "pi/rogue-pi-mint.ts: imports the fpe family (../../plugin/src/hooks/magic-context/fpe)",
            ]);
        } finally {
            rmSync(plantDir, { recursive: true, force: true });
        }
    });
});
