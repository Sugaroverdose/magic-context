/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { deriveKey, renderDropToken } from "./fpe";
import { isNeutralizedReasoningPart, TOOL_RELEASED_SENTINEL } from "./sentinel";
import type { MessageLike, ThinkingLikePart } from "./tag-messages";
import {
    createToolDropTarget,
    extractToolCallObservation,
    hasMeaningfulPart,
    partHasCompletedResult,
    type ToolCallIndex,
    ToolMutationBatch,
} from "./tool-drop-target";

// ── Closure census for the volatile-segment lane (ruling 3) ────────────────
// The volatile lane renders head bytes only; it must have no code path into a
// message part-mutation primitive (it can never strip a protected block). The
// law is enforced over the real transitive static value-import closure from
// region-volatile.ts, three ways:
//   belt  — the six-name mutator deny list (the direct-text pins + module
//           names); a renamed hazard is NOT caught here, it is caught by the
//           closure-set pin — a closed vocabulary, not an enumerable hazard list;
//   brace — fail-closed on any value binding pulled out of a mutator that is
//           not on the pure-read allowlist, and fail-closed on any dynamic
//           import()/require() token in a reached file not on the escape hatch;
//   pin   — the EXACT reachable-file set, so a seventh mutator module entering
//           the closure is a new-file violation even though no list names it.
// Scanning uses the TypeScript parser, never a regex over raw source: comments,
// string/template literals, and regex literals can neither fake an import nor
// hide a real one. (A reviewer reded a regex walker with a fake static import
// written inside a doc-comment; the AST never sees comments.) Type-only edges
// are skipped — erased at emit, they cannot execute.
const VOLATILE_MUTATOR_BASENAMES = new Set([
    "sentinel.ts",
    "tool-drop-target.ts",
    "tag-messages.ts",
    "apply-operations.ts",
    "heuristic-cleanup.ts",
    "strip-content.ts",
]);
// The only non-mutating exports the volatile closure may pull from a mutator
// module. Fail-closed: a mutator, a mint, or a renamed one reaching the lane
// is not on this list and reddens.
const VOLATILE_MUTATOR_ALLOWLIST: Record<string, ReadonlySet<string>> = {
    "tool-drop-target.ts": new Set(["extractToolCallObservation"]),
};

// Fail-closed dynamic modality (arm b): any dynamic import()/require()/
// createRequire token in a REACHED file is a violation UNLESS the file is on
// this escape hatch, each entry carrying its justification. These are the only
// four legitimate such sites in the closure (verified against the AST this
// session); an escape-hatch entry may never name a mutator as its target — a
// dynamic edge into a mutator reddens even from an allowlisted file.
const VOLATILE_DYNAMIC_MODALITY_ESCAPE_HATCH: Record<string, string> = {
    "hooks/magic-context/read-session-formatting.ts":
        "createRequire + dynamic import of the optional installed tokenizer / encoding WASM packages (installedPaths.tokenizerPath/encodingPath); never a region mutator.",
    "features/magic-context/storage-db.ts":
        "lazy dynamic import() of two non-mutator local modules (read-session-chunk, message-time-backfill) to defer heavy load.",
    "shared/sqlite.ts":
        "dynamic import() selecting the node:sqlite vs bun:sqlite driver at runtime.",
    "features/magic-context/memory/embedding-local.ts":
        "dynamic import() of optional ONNX / @huggingface/transformers WASM deps (+ node:module via createRequire) for local embeddings.",
};

// Pin (arm c): the exact reachable non-mutator file set (relative to src/) from
// a clean static value-import walk of region-volatile.ts. Any new reachable
// file — including a seventh mutator module that no deny list names — reddens
// until this set is intentionally updated.
const VOLATILE_CLOSURE_SET = new Set([
    "agents/language-directive.ts",
    "agents/magic-context-prompt.ts",
    "config/schema/agent-overrides.ts",
    "config/schema/magic-context.ts",
    "features/magic-context/compaction-marker.ts",
    "features/magic-context/compartment-chunk-embedding.ts",
    "features/magic-context/compartment-lease.ts",
    "features/magic-context/compartment-storage.ts",
    "features/magic-context/compression-depth-storage.ts",
    "features/magic-context/context-store-uuid.ts",
    "features/magic-context/dreamer/cron.ts",
    "features/magic-context/fail-closed-block.ts",
    "features/magic-context/git-commits/storage-git-commit-embeddings.ts",
    "features/magic-context/git-commits/storage-git-commits.ts",
    "features/magic-context/git-commits/sweep-coordinator.ts",
    "features/magic-context/lkg-prefix-chunks.ts",
    "features/magic-context/memory/constants.ts",
    "features/magic-context/memory/cosine-similarity.ts",
    "features/magic-context/memory/embedding-backfill.ts",
    "features/magic-context/memory/embedding-cache.ts",
    "features/magic-context/memory/embedding-failure.ts",
    "features/magic-context/memory/embedding-identity.ts",
    "features/magic-context/memory/embedding-local.ts",
    "features/magic-context/memory/embedding-model-match.ts",
    "features/magic-context/memory/embedding-openai.ts",
    "features/magic-context/memory/embedding-ssrf.ts",
    "features/magic-context/memory/embedding-synapse.ts",
    "features/magic-context/memory/embedding-worker-client.ts",
    "features/magic-context/memory/embedding.ts",
    "features/magic-context/memory/index.ts",
    "features/magic-context/memory/memory-selection.ts",
    "features/magic-context/memory/normalize-hash.ts",
    "features/magic-context/memory/project-identity-cache.ts",
    "features/magic-context/memory/project-identity.ts",
    "features/magic-context/memory/promotion.ts",
    "features/magic-context/memory/storage-memory-embeddings.ts",
    "features/magic-context/memory/storage-memory-fts.ts",
    "features/magic-context/memory/storage-memory-verifications.ts",
    "features/magic-context/memory/storage-memory.ts",
    "features/magic-context/memory/transformers-remote-host.ts",
    "features/magic-context/memory/types.ts",
    "features/magic-context/memory/verification-paths.ts",
    "features/magic-context/memory/visibility.ts",
    "features/magic-context/merged-reasoning-decisions.ts",
    "features/magic-context/message-fts-rowid-map.ts",
    "features/magic-context/message-index.ts",
    "features/magic-context/migration-v94-write-split.ts",
    "features/magic-context/migration-worker-client.ts",
    "features/magic-context/migrations.ts",
    "features/magic-context/mural/mural-font.generated.ts",
    "features/magic-context/mural/mural-selection.ts",
    "features/magic-context/mural/render-mural.ts",
    "features/magic-context/mural/render-trigger.ts",
    "features/magic-context/mural/resolve-mural.ts",
    "features/magic-context/mural/storage-mural-cues.ts",
    "features/magic-context/mural/storage-mural.ts",
    "features/magic-context/no-content-compartment.ts",
    "features/magic-context/opencode2-relabel.ts",
    "features/magic-context/pi-content-decisions.ts",
    "features/magic-context/project-docs-hash.ts",
    "features/magic-context/project-embedding-registry.ts",
    "features/magic-context/project-identity.ts",
    "features/magic-context/protection-window.ts",
    "features/magic-context/reclaim-protection.ts",
    "features/magic-context/recursive-text-splitter.ts",
    "features/magic-context/resolve-subagent-fallback.ts",
    "features/magic-context/session-activity.ts",
    "features/magic-context/session-decision-calibration.ts",
    "features/magic-context/session-project-storage.ts",
    "features/magic-context/shadow-backfill-state.ts",
    "features/magic-context/storage-clone.ts",
    "features/magic-context/storage-compartment-history-version.ts",
    "features/magic-context/storage-db.ts",
    "features/magic-context/storage-embedding-measurements.ts",
    "features/magic-context/storage-identity-rekey-map.ts",
    "features/magic-context/storage-m0-mutation-log.ts",
    "features/magic-context/storage-memory-mutation-log.ts",
    "features/magic-context/storage-meta-persisted.ts",
    "features/magic-context/storage-meta-session.ts",
    "features/magic-context/storage-meta-shared.ts",
    "features/magic-context/storage-meta.ts",
    "features/magic-context/storage-native-replay.ts",
    "features/magic-context/storage-notes.ts",
    "features/magic-context/storage-ops.ts",
    "features/magic-context/storage-primers.ts",
    "features/magic-context/storage-project-state.ts",
    "features/magic-context/storage-replay-document.ts",
    "features/magic-context/storage-schema-helpers.ts",
    "features/magic-context/storage-session-tables.ts",
    "features/magic-context/storage-source.ts",
    "features/magic-context/storage-subagent-invocations.ts",
    "features/magic-context/storage-tags.ts",
    "features/magic-context/storage-v22-backfill-failures.ts",
    "features/magic-context/storage.ts",
    "features/magic-context/system-region.ts",
    "features/magic-context/tool-definition-tokens.ts",
    "features/magic-context/tool-owner-backfill.ts",
    "features/magic-context/user-memory/storage-user-memory.ts",
    "features/magic-context/workspaces.ts",
    "hooks/magic-context/compaction-marker-manager.ts",
    "hooks/magic-context/compartment-parser.ts",
    "hooks/magic-context/compartment-render-epoch.ts",
    "hooks/magic-context/ctx-reduce-nudge.ts",
    "hooks/magic-context/decay-curve.ts",
    "hooks/magic-context/decay-render.ts",
    "hooks/magic-context/decision-calibration.ts",
    "hooks/magic-context/embed-session-state.ts",
    "hooks/magic-context/emergency-drop.ts",
    "hooks/magic-context/host-served-rows.ts",
    "hooks/magic-context/image-token-estimate.ts",
    "hooks/magic-context/inject-compartments.ts",
    "hooks/magic-context/lkg-slot.ts",
    "hooks/magic-context/read-session-chunk.ts",
    "hooks/magic-context/read-session-db.ts",
    "hooks/magic-context/read-session-formatting.ts",
    "hooks/magic-context/read-session-raw.ts",
    "hooks/magic-context/read-session-true-raw-tokens.ts",
    "hooks/magic-context/region-render.ts",
    "hooks/magic-context/region-volatile.ts",
    "hooks/magic-context/system-injection-stripper.ts",
    "hooks/magic-context/tag-content-primitives.ts",
    "hooks/magic-context/tag-part-guards.ts",
    "hooks/magic-context/tail-hygiene-walk.ts",
    "hooks/magic-context/temporal-awareness.ts",
    "hooks/magic-context/todo-view.ts",
    "hooks/magic-context/tokenizer-calibration-seeds.json",
    "hooks/magic-context/tokenizer-calibration.ts",
    "hooks/magic-context/tool-sweep-policy.ts",
    "hooks/magic-context/user-profile-render.ts",
    "plugin/boot-quiet.ts",
    "shared/background-batch-drain.ts",
    "shared/bounded-session-map.ts",
    "shared/commit-detection.ts",
    "shared/context-limit-provenance.ts",
    "shared/data-path.ts",
    "shared/embedding-activity.ts",
    "shared/error-message.ts",
    "shared/escalation-bands.ts",
    "shared/harness-provider-map.ts",
    "shared/harness.ts",
    "shared/historian-tool-defaults.json",
    "shared/historian-tool-expansions.ts",
    "shared/historian-tool-template.ts",
    "shared/internal-initiator-marker.ts",
    "shared/logger.ts",
    "shared/models-dev-cache.ts",
    "shared/off-thread-migration-clock.ts",
    "shared/opencode-db-path.ts",
    "shared/pi-executable.ts",
    "shared/project-directory-key.ts",
    "shared/prompt-surface.ts",
    "shared/record-type-guard.ts",
    "shared/redaction.ts",
    "shared/rpc-utils.ts",
    "shared/sqlite-helpers.ts",
    "shared/sqlite.ts",
    "shared/stable-json.ts",
    "shared/stale-plugin-build.ts",
    "shared/storage-permissions.ts",
    "shared/system-directive.ts",
    "shared/tag-owner-id.ts",
    "shared/test-temp-dir.ts",
    "shared/window-geometry.ts",
    "shared/write-transaction-timing.ts",
    "shared/xml-unescape.ts",
    "v2/store-reader.ts",
]);

interface ImportEdge {
    names: string[];
    spec: string;
    kind: "named" | "namespace" | "default" | "star" | "sideeffect";
}

const VOLATILE_AST_CACHE = new Map<string, ts.SourceFile>();
function parseVolatileFile(fileName: string, text: string): ts.SourceFile {
    const key = `${fileName} ${text}`;
    let sf = VOLATILE_AST_CACHE.get(key);
    if (!sf) {
        sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
        VOLATILE_AST_CACHE.set(key, sf);
    }
    return sf;
}

// Static VALUE import/re-export edges only (type-only clauses/specifiers are
// skipped — erased, cannot execute). Parsed from the AST, so nothing inside a
// comment, string, or regex literal can masquerade as an import.
function volatileImportEdges(text: string, fileName: string): ImportEdge[] {
    const sf = parseVolatileFile(fileName, text);
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
            edges.push({ names: [c.name ? c.name.text : "_default"], spec, kind: "default" });
        }
    };
    const walk = (n: ts.Node): void => {
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
            if (!n.importClause)
                edges.push({ names: [], spec: n.moduleSpecifier.text, kind: "sideeffect" });
            else clause(n.importClause, n.moduleSpecifier.text);
        }
        if (
            ts.isExportDeclaration(n) &&
            n.moduleSpecifier &&
            ts.isStringLiteral(n.moduleSpecifier) &&
            !n.isTypeOnly
        ) {
            if (!n.exportClause)
                edges.push({ names: ["*"], spec: n.moduleSpecifier.text, kind: "star" });
            else if (ts.isNamedExports(n.exportClause)) {
                const vals = n.exportClause.elements
                    .filter((e) => !e.isTypeOnly)
                    .map((e) => e.name.text);
                if (vals.length)
                    edges.push({ names: vals, spec: n.moduleSpecifier.text, kind: "named" });
            }
        }
        n.forEachChild(walk);
    };
    walk(sf);
    return edges;
}

// Dynamic import()/require()/createRequire tokens, AST-detected. Returns the
// call kind with its string-literal target ("<dynamic>" when non-literal).
function volatileModalityTokens(text: string, fileName: string): string[] {
    const sf = parseVolatileFile(fileName, text);
    const toks: string[] = [];
    const arg = (n: ts.CallExpression): string =>
        n.arguments[0] && ts.isStringLiteral(n.arguments[0]) ? n.arguments[0].text : "<dynamic>";
    const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
            if (n.expression.kind === ts.SyntaxKind.ImportKeyword) toks.push(`import(${arg(n)})`);
            else {
                const callee = n.expression.getText(sf);
                if (
                    callee === "require" ||
                    callee.endsWith(".require") ||
                    callee.endsWith("createRequire") ||
                    callee.includes("createRequire")
                )
                    toks.push(`require(${arg(n)})`);
            }
        }
        n.forEachChild(walk);
    };
    walk(sf);
    return toks;
}

function volatileSpecToFile(
    srcRoot: string,
    fromFile: string,
    spec: string,
    patch: Map<string, string>,
): string | null {
    if (!spec.startsWith(".")) return null;
    const base = resolve(fromFile, "..", spec);
    for (const c of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
    ]) {
        if (patch.has(c)) {
            if (c.startsWith(`${srcRoot}/`) && !c.endsWith(".test.ts")) return c;
            continue;
        }
        try {
            if (statSync(c).isFile() && c.startsWith(`${srcRoot}/`) && !c.endsWith(".test.ts")) {
                return c;
            }
        } catch {
            // not a file at this candidate path — try the next
        }
    }
    return null;
}

function mutatorBasenameHit(target: string): string | null {
    if (target === "<dynamic>" || !target.startsWith(".")) return null;
    const tb = target.split("/").pop() ?? "";
    if (VOLATILE_MUTATOR_BASENAMES.has(tb)) return tb;
    if (VOLATILE_MUTATOR_BASENAMES.has(`${tb}.ts`)) return `${tb}.ts`;
    return null;
}

interface VolatileCensus {
    violations: string[];
    reached: string[];
}

/**
 * Walk the transitive static value-import closure from region-volatile.ts and
 * return every violation of the volatile lane's reach-freedom contract: an
 * unallowlisted value binding from a mutator, a dynamic import()/require()
 * outside the escape hatch (or naming a mutator from inside it), or a reachable
 * file set that differs from the pin. `overrides` is a virtual-patch map
 * (absolute path → text): it rewrites an existing reached file's bytes and/or
 * declares a brand-new reachable file (so a seventh-module plant is seen
 * without a disk write). Never mutates anything on disk.
 */
function runVolatileCensus(
    opts: {
        overrides?: Map<string, string>;
        mutatorAllowlist?: Record<string, ReadonlySet<string>>;
        escapeHatch?: Record<string, string>;
        closureSet?: ReadonlySet<string>;
    } = {},
): VolatileCensus {
    const srcRoot = resolve(import.meta.dirname, "..", "..");
    const start = join(srcRoot, "hooks", "magic-context", "region-volatile.ts");
    const patch = opts.overrides ?? new Map<string, string>();
    const read = (p: string): string => patch.get(p) ?? readFileSync(p, "utf8");
    const allowlist = opts.mutatorAllowlist ?? VOLATILE_MUTATOR_ALLOWLIST;
    const escapeHatch = opts.escapeHatch ?? VOLATILE_DYNAMIC_MODALITY_ESCAPE_HATCH;
    const closureSet = opts.closureSet ?? VOLATILE_CLOSURE_SET;
    const rel = (p: string): string => p.slice(srcRoot.length + 1);
    const violations: string[] = [];
    const seen = new Set<string>([start]);
    const queue: string[] = [start];
    while (queue.length > 0) {
        const file = queue.shift() as string;
        const fileRel = rel(file);
        const text = read(file);
        // (arm b) fail-closed dynamic modality on every reached non-mutator file.
        const hatched = fileRel in escapeHatch;
        for (const tok of volatileModalityTokens(text, file)) {
            const target = tok.slice(tok.indexOf("(") + 1, tok.lastIndexOf(")"));
            const namesMutator = mutatorBasenameHit(target);
            if (!hatched)
                violations.push(
                    `${fileRel} -[modality ${tok}]-> dynamic import/require not escape-hatched`,
                );
            else if (namesMutator)
                violations.push(`${fileRel} -[modality ${tok}]-> escape hatch names a mutator`);
        }
        for (const edge of volatileImportEdges(text, file)) {
            const target = volatileSpecToFile(srcRoot, file, edge.spec, patch);
            if (!target) continue;
            const basenameT = target.slice(target.lastIndexOf("/") + 1);
            if (VOLATILE_MUTATOR_BASENAMES.has(basenameT)) {
                const allowed = allowlist[basenameT];
                if (edge.kind === "named") {
                    for (const name of edge.names) {
                        if (!allowed?.has(name)) {
                            violations.push(`${fileRel} -[named ${name}]-> ${basenameT}`);
                        }
                    }
                } else {
                    violations.push(`${fileRel} -[${edge.kind}]-> ${basenameT}`);
                }
                continue; // never audit a mutator module's own internals
            }
            if (!seen.has(target)) {
                seen.add(target);
                queue.push(target);
            }
        }
    }
    // (arm c) positive closure-set pin.
    for (const p of seen)
        if (!closureSet.has(rel(p))) violations.push(`new reachable file ${rel(p)}`);
    for (const p of closureSet)
        if (!seen.has(join(srcRoot, p))) violations.push(`missing reachable file ${p}`);
    return { violations, reached: [...seen].map(rel).sort() };
}

function message(id: string, role: string, parts: unknown[]): MessageLike {
    return {
        info: { id, role, sessionID: "ses-1" },
        parts,
    };
}

// Mirrors production: the drop target renders its token from the session key.
const sessionKey = deriveKey("ses-1");

function hasCall(messages: MessageLike[], callId: string): boolean {
    for (const msg of messages) {
        for (const part of msg.parts) {
            const observation = extractToolCallObservation(part);
            if (observation?.callId === callId) {
                return true;
            }
        }
    }

    return false;
}

function buildIndex(messages: MessageLike[]): ToolCallIndex {
    const index: ToolCallIndex = new Map();
    for (const msg of messages) {
        for (const part of msg.parts) {
            const observation = extractToolCallObservation(part);
            if (observation) {
                const entry = index.get(observation.callId) ?? {
                    occurrences: [],
                    hasResult: false,
                };
                entry.occurrences.push({ message: msg, part, kind: observation.kind });
                // Mirror production (tag-messages.ts): an OpenCode `{ type: "tool" }`
                // part is a "result" observation by type even while pending, so gate
                // hasResult on an actual completed result.
                if (observation.kind === "result" && partHasCompletedResult(part))
                    entry.hasResult = true;
                index.set(observation.callId, entry);
            }
        }
    }
    return index;
}

describe("tool-drop-target", () => {
    it("strips attachments on a newly selected skeleton but preserves legacy replay", () => {
        const attachment = { type: "file", mime: "image/png", url: "data:image/png;base64,abcd" };
        const original = {
            type: "tool",
            callID: "c1",
            state: { input: { path: "a" }, output: "large output", attachments: [attachment] },
        };
        const row = message("m1", "assistant", [original]);
        const target = createToolDropTarget(
            "c1",
            [],
            buildIndex([row]),
            new ToolMutationBatch([row]),
            7,
            sessionKey,
        );
        expect(target.hasAttachments()).toBe(true);
        expect(target.skeletonStripped()).toBe("truncated");
        expect((row.parts[0] as typeof original).state.attachments).toEqual([]);
        expect(original.state.attachments).toEqual([attachment]);
        const replay = message("m1", "assistant", [structuredClone(original)]);
        createToolDropTarget(
            "c1",
            [],
            buildIndex([replay]),
            new ToolMutationBatch([replay]),
            7,
            sessionKey,
        ).skeletonReal();
        expect((replay.parts[0] as typeof original).state.attachments).toEqual([attachment]);
    });
    let buildOutput: ReturnType<typeof mock<(suffix: string) => string>>;

    beforeEach(() => {
        buildOutput = mock((suffix: string) => `output-${suffix}`);
    });

    describe("extractToolCallObservation", () => {
        describe("#given supported and unsupported tool part shapes", () => {
            describe("#when extracting tool call observations", () => {
                it("#then it classifies invocation/result parts and ignores invalid shapes", () => {
                    expect(extractToolCallObservation({ type: "tool", callID: "call-a" })).toEqual({
                        callId: "call-a",
                        kind: "result",
                    });
                    expect(
                        extractToolCallObservation({ type: "tool-invocation", callID: "call-b" }),
                    ).toEqual({
                        callId: "call-b",
                        kind: "invocation",
                    });
                    expect(extractToolCallObservation({ type: "tool_use", id: "call-c" })).toEqual({
                        callId: "call-c",
                        kind: "invocation",
                    });
                    expect(
                        extractToolCallObservation({ type: "tool_result", tool_use_id: "call-d" }),
                    ).toEqual({
                        callId: "call-d",
                        kind: "result",
                    });
                    expect(
                        extractToolCallObservation({ type: "tool_result", tool_use_id: "" }),
                    ).toBeNull();
                    expect(extractToolCallObservation({ type: "text", text: "plain" })).toBeNull();
                });
            });
        });
    });

    describe("partHasCompletedResult", () => {
        it("counts a completed OpenCode tool part (output string) as closed", () => {
            expect(
                partHasCompletedResult({ type: "tool", callID: "c", state: { output: "done" } }),
            ).toBe(true);
        });

        it("counts an errored OpenCode tool part (status error, no output) as closed", () => {
            expect(
                partHasCompletedResult({
                    type: "tool",
                    callID: "c",
                    state: { status: "error", error: "boom", input: { content: "x".repeat(600) } },
                }),
            ).toBe(true);
        });

        it("keeps a running OpenCode tool part (no output, no error) open", () => {
            expect(
                partHasCompletedResult({
                    type: "tool",
                    callID: "c",
                    state: { status: "running", input: { prompt: "p" } },
                }),
            ).toBe(false);
        });

        it("keeps a pending OpenCode tool part open", () => {
            expect(
                partHasCompletedResult({ type: "tool", callID: "c", state: { status: "pending" } }),
            ).toBe(false);
        });

        it("counts an Anthropic tool_result part as closed", () => {
            expect(partHasCompletedResult({ type: "tool_result", tool_use_id: "c" })).toBe(true);
        });

        it("excludes invocation-shaped parts and non-records", () => {
            expect(partHasCompletedResult({ type: "tool-invocation", callID: "c" })).toBe(false);
            expect(partHasCompletedResult({ type: "tool_use", id: "c" })).toBe(false);
            expect(partHasCompletedResult(null)).toBe(false);
            expect(partHasCompletedResult({ type: "tool" })).toBe(false);
        });
    });

    describe("createToolDropTarget", () => {
        describe("#given a complete invocation/result tool pair", () => {
            describe("#when dropping the call", () => {
                it("#then it renders the full released shape in place, keeps the pair, and clears thinking", () => {
                    const invocation = { type: "tool-invocation", callID: "call-1" };
                    const toolPart = {
                        type: "tool",
                        callID: "call-1",
                        state: { output: buildOutput("tool") },
                    };
                    const wrapperToolUse = { type: "tool_use", id: "call-1" };
                    const wrapperResult = {
                        type: "tool_result",
                        tool_use_id: "call-1",
                        content: buildOutput("result"),
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [invocation]),
                        message("m-tool", "tool", [toolPart]),
                        message("m-wrapper", "assistant", [
                            { type: "step-start", snapshot: "snap-1" },
                            wrapperToolUse,
                            wrapperResult,
                            { type: "step-finish", reason: "tool-calls" },
                        ]),
                        message("m-keep", "assistant", [{ type: "text", text: "keep me" }]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "private" },
                        { type: "reasoning", text: "trace" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);

                    const target = createToolDropTarget(
                        "call-1",
                        thinkingParts,
                        index,
                        batch,
                        1,
                        sessionKey,
                    );
                    const result = target.drop();

                    expect(result).toBe("removed");
                    expect(buildOutput).toHaveBeenCalledTimes(2);

                    batch.finalize();

                    // A released pair is never removed: every wrapper survives and
                    // the call stays on the wire in its full released shape.
                    expect(hasCall(messages, "call-1")).toBe(true);
                    expect(messages).toHaveLength(4);

                    const token = renderDropToken(1, sessionKey);
                    // No input on the originals → the fallback carrier key.
                    expect(messages[0]?.parts[0]).toEqual({
                        type: "tool-invocation",
                        callID: "call-1",
                        args: { d: token },
                    });
                    expect(messages[1]?.parts[0]).toEqual({
                        type: "tool",
                        callID: "call-1",
                        state: { output: "", attachments: [], input: { d: token } },
                    });
                    expect(messages[2]?.parts[1]).toEqual({
                        type: "tool_use",
                        id: "call-1",
                        input: { d: token },
                    });
                    expect(messages[2]?.parts[2]).toEqual({
                        type: "tool_result",
                        tool_use_id: "call-1",
                        content: "",
                    });
                    expect(messages[2]?.parts[0]).toEqual({
                        type: "step-start",
                        snapshot: "snap-1",
                    });
                    expect(messages[2]?.parts[3]).toEqual({
                        type: "step-finish",
                        reason: "tool-calls",
                    });

                    // The LIVE part objects the host may still execute from stay
                    // byte-identical; the carrier rides the wire clone only.
                    expect(invocation).not.toHaveProperty("args");
                    expect(toolPart.state).toEqual({ output: "output-tool" });
                    expect(wrapperToolUse).not.toHaveProperty("input");
                    expect(wrapperResult.content).toBe("output-result");

                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[0]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[0])).toBe(true);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[1]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[1])).toBe(true);
                });
            });
        });

        describe("#given a protected thinking block alongside ordinary reasoning", () => {
            // The drop/erase lanes neutralize the dropped call's reasoning via
            // the single shared primitive (neutralizeDroppedReasoningPart),
            // which every wire-mutating site uses — the pending-op drain, the
            // heuristic cleanup, and the auto-reclaim all route through it, as
            // does the erased (stamp) path. A protected block is one with no
            // `thinking`/`text` (a redacted_thinking block, or a signed block
            // whose payload the provider must replay byte-identical); the
            // primitive must leave it intact. This law attacks that guard on
            // both release shapes (skeleton-carrier drop + stamp erase) so a
            // regression that clears protected bytes on either path reddens.
            const completePair = (): {
                messages: MessageLike[];
                index: ToolCallIndex;
                batch: ToolMutationBatch;
                protectedBlock: Record<string, unknown>;
            } => {
                const protectedBlock: Record<string, unknown> = {
                    type: "redacted_thinking",
                    data: "SIGNATURE_BYTES_MUST_NOT_CHANGE",
                };
                const messages: MessageLike[] = [
                    message("m-inv", "assistant", [{ type: "tool-invocation", callID: "call-1" }]),
                    message("m-tool", "tool", [
                        { type: "tool", callID: "call-1", state: { output: buildOutput("tool") } },
                    ]),
                    message("m-wrapper", "assistant", [
                        { type: "tool_use", id: "call-1" },
                        { type: "tool_result", tool_use_id: "call-1", content: buildOutput("r") },
                    ]),
                    message("m-keep", "assistant", [{ type: "text", text: "keep me" }]),
                ];
                const index = buildIndex(messages);
                const batch = new ToolMutationBatch(messages);
                return { messages, index, batch, protectedBlock };
            };

            for (const [name, run] of [
                ["drop", (t: ReturnType<typeof createToolDropTarget>) => t.drop()],
                ["erase", (t: ReturnType<typeof createToolDropTarget>) => t.erase()],
            ] as const) {
                it(`leaves the protected block byte-identical while clearing ordinary reasoning (${name})`, () => {
                    const { index, batch, protectedBlock } = completePair();
                    const before = JSON.stringify(protectedBlock);
                    const ordinary: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "private" },
                    ];
                    const thinkingParts = [...ordinary, protectedBlock] as ThinkingLikePart[];
                    const target = createToolDropTarget(
                        "call-1",
                        thinkingParts,
                        index,
                        batch,
                        1,
                        sessionKey,
                    );
                    const result = run(target);
                    expect(result).toBe("removed");
                    batch.finalize();

                    // The ordinary reasoning part is neutralized off the wire.
                    expect(isNeutralizedReasoningPart(ordinary[0])).toBe(true);
                    // The protected block survives byte-for-byte — not neutralized,
                    // not emptied, its provider payload intact.
                    expect(JSON.stringify(protectedBlock)).toBe(before);
                    expect(isNeutralizedReasoningPart(protectedBlock)).toBe(false);
                });
            }
        });

        describe("#given the volatile-segment recompute lane", () => {
            it("has no code path into message reasoning (cannot strip a protected block)", () => {
                // Ruling 3's fourth site: the volatile drain must never strip a
                // protected thinking block. This lane renders only head bytes
                // from memory/compartment/docs state — it takes no message
                // array at all — so its reach-freedom is a structural property.
                //
                // BELT: the volatile file's own bytes never name a part-mutation
                // primitive or reach a message array.
                const source = readFileSync(
                    new URL("./region-volatile.ts", import.meta.url),
                    "utf8",
                );
                expect(source).not.toMatch(/neutralizeDroppedReasoningPart/);
                expect(source).not.toMatch(/clearThinkingParts/);
                expect(source).not.toMatch(/\bMessageLike\b/);
                expect(source).not.toMatch(/\.parts\b/);
                // BRACES: the AST value-import closure reaches no unallowlisted
                // mutator binding, pulls no dynamic import()/require() outside
                // the escape hatch, and its reachable-file set equals the pin.
                expect(runVolatileCensus().violations).toEqual([]);
            });

            it("the mutator allowlist names only real, still-present exports (fail-closed guard)", () => {
                // The allowlist is the one thing that keeps the clean tree green.
                // If a pure read is renamed away, its allowlist entry goes stale
                // and this reddens — forcing re-audit rather than silently
                // widening what the volatile lane may pull from a mutator module.
                for (const [basename, names] of Object.entries(VOLATILE_MUTATOR_ALLOWLIST)) {
                    // Every allowlisted mutator is a sibling of this census.
                    const found = join(import.meta.dirname, basename);
                    expect(statSync(found).isFile(), `mutator module ${basename} exists`).toBe(
                        true,
                    );
                    const text = readFileSync(found, "utf8");
                    for (const name of names) {
                        const declared =
                            new RegExp(
                                `export\\s+(?:async\\s+)?(?:function|const|class)\\s+${name}\\b`,
                            ).test(text) ||
                            new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(text);
                        expect(declared, `${basename} still exports ${name}`).toBe(true);
                    }
                }
            });

            it("the dynamic-modality escape hatch is real and never licenses a mutator target", () => {
                // (arm b) Fail-closed means the hatch is the sole license for a
                // dynamic token. A hatch entry that has become vestigial (no such
                // token anymore) is dead weight that hides a future plant, and a
                // hatch entry that could name a mutator defeats the whole gate —
                // both are defects, so the hatch is audited, not just trusted.
                expect(Object.keys(VOLATILE_DYNAMIC_MODALITY_ESCAPE_HATCH).length).toBeGreaterThan(
                    0,
                );
                for (const [relPath, justification] of Object.entries(
                    VOLATILE_DYNAMIC_MODALITY_ESCAPE_HATCH,
                )) {
                    expect(
                        justification.length,
                        `${relPath} hatch needs a justification`,
                    ).toBeGreaterThan(20);
                    // The hatch must cover a file that is really in the closure.
                    expect(
                        VOLATILE_CLOSURE_SET.has(relPath),
                        `${relPath} is reachable (hatch is not vestigial on an unreachable file)`,
                    ).toBe(true);
                    const abs = join(resolve(import.meta.dirname, "..", ".."), relPath);
                    const toks = volatileModalityTokens(readFileSync(abs, "utf8"), abs);
                    // Not vestigial: the file really does carry a dynamic token.
                    expect(
                        toks.length,
                        `${relPath} still uses dynamic import/require`,
                    ).toBeGreaterThan(0);
                    // And never a mutator: an escape-hatched dynamic edge may not
                    // reach the part-mutation modules by literal specifier.
                    for (const tok of toks) {
                        const target = tok.slice(tok.indexOf("(") + 1, tok.lastIndexOf(")"));
                        expect(
                            mutatorBasenameHit(target),
                            `${relPath} dynamic target ${target} must not be a mutator`,
                        ).toBeNull();
                    }
                }
            });

            it("the reachable closure is exactly the pinned file set (arm c)", () => {
                // A seventh mutator that no deny list names still enters here as a
                // NEW reachable file, so the closed vocabulary — not the six-name
                // enumeration — is the load-bearing brace. Any drift (a new file,
                // or one that stopped being reachable) reddens until the pin is
                // intentionally updated.
                expect(runVolatileCensus().reached).toEqual([...VOLATILE_CLOSURE_SET].sort());
            });

            it("ignores a static import faked inside a comment (arm a, AST)", () => {
                // The reviewer reded a regex walker by writing a fake static
                // mutator import inside a doc-comment. The AST never sees
                // comments, so the census must be blind to it — while the very
                // same import written OUTSIDE a comment must redden. Paired so
                // neither the ignore (false green) nor the catch (vacuous) can
                // pass on its own.
                const srcRoot = resolve(import.meta.dirname, "..", "..");
                const dr = join(srcRoot, "hooks", "magic-context", "decay-render.ts");
                const baseText = readFileSync(dr, "utf8");
                const inComment = new Map([
                    [dr, `${baseText}\n/* import { makeSentinel } from "./sentinel"; */\n`],
                ]);
                expect(
                    runVolatileCensus({ overrides: inComment }).violations.join("\n"),
                ).not.toContain("makeSentinel");
                const realImport = new Map([
                    [dr, `${baseText}\nimport { makeSentinel } from "./sentinel";\n`],
                ]);
                expect(
                    runVolatileCensus({ overrides: realImport }).violations.join("\n"),
                ).toContain("makeSentinel");
            });

            it("REDS under planted reach (committed rogue-loop witnesses)", () => {
                // #2780: re-runnable witnesses, plants kept virtual (never on
                // disk). One per reviewer-plant class; each asserts the hardened
                // walker REDS with the planted needle.
                const srcRoot = resolve(import.meta.dirname, "..", "..");
                const rv = join(srcRoot, "hooks", "magic-context", "region-volatile.ts");
                const dr = join(srcRoot, "hooks", "magic-context", "decay-render.ts");
                const rvText = readFileSync(rv, "utf8");
                const drText = readFileSync(dr, "utf8");

                // Discovery witness on the REAL tree: stripping the pure-read
                // allowlist surfaces the one genuine deep edge — the volatile
                // closure reaches read-session-chunk.ts (many hops down) and finds
                // its extractToolCallObservation import of tool-drop-target. A
                // 1-hop-only walk would never see it, so this proves transitivity.
                const stripped = runVolatileCensus({ mutatorAllowlist: {} }).violations.join("\n");
                expect(stripped).toContain("read-session-chunk.ts");
                expect(stripped).toContain("extractToolCallObservation");

                const rogues: Array<{
                    label: string;
                    overrides: Map<string, string>;
                    needle: string;
                }> = [
                    // mutator-reach belt (reviewer evades the four-string scan):
                    {
                        label: "direct mutator import (reviewer evade: makeSentinel)",
                        overrides: new Map([
                            [rv, `${rvText}\nimport { makeSentinel } from "./sentinel";\n`],
                        ]),
                        needle: "makeSentinel",
                    },
                    {
                        label: "transitive mutator import through a reachable renderer",
                        overrides: new Map([
                            [
                                dr,
                                `${drText}\nimport { createToolDropTarget } from "./tool-drop-target";\n`,
                            ],
                        ]),
                        needle: "createToolDropTarget",
                    },
                    {
                        label: "barrel re-export of a whole-message sentinel mint",
                        overrides: new Map([
                            [
                                dr,
                                `${drText}\nexport { makeWholeMessageSentinel } from "./sentinel";\n`,
                            ],
                        ]),
                        needle: "makeWholeMessageSentinel",
                    },
                    {
                        label: "side-effect import of a mutator module",
                        overrides: new Map([[rv, `${rvText}\nimport "./sentinel";\n`]]),
                        needle: "[sideeffect]-> sentinel.ts",
                    },
                    // (arm b) dynamic modality, fail-closed:
                    {
                        label: "dynamic import() of a mutator from the lane",
                        overrides: new Map([
                            [
                                rv,
                                `${rvText}\nasync function __r(){ return await import("./tool-drop-target"); }\n`,
                            ],
                        ]),
                        needle: "modality import(./tool-drop-target)",
                    },
                    {
                        label: "createRequire-style require into a mutator",
                        overrides: new Map([
                            [
                                rv,
                                `${rvText}\nconst __rr = createRequire(import.meta.url)("./sentinel");\n`,
                            ],
                        ]),
                        needle: "modality require(./sentinel)",
                    },
                    // (arm c) closed vocabulary catches an unnamed mutator:
                    {
                        label: "seventh-module mutator, named by no deny list",
                        overrides: new Map([
                            [rv, `${rvText}\nimport { plunderParts } from "./part-plunger";\n`],
                            [
                                join(srcRoot, "hooks", "magic-context", "part-plunger.ts"),
                                'export function plunderParts(): string {\n    return "";\n}\n',
                            ],
                        ]),
                        needle: "new reachable file hooks/magic-context/part-plunger.ts",
                    },
                ];
                for (const rogue of rogues) {
                    const violations = runVolatileCensus({ overrides: rogue.overrides }).violations;
                    expect(violations, rogue.label).not.toEqual([]);
                    expect(violations.join("\n"), rogue.label).toContain(rogue.needle);
                }
            });
        });

        describe("#given only a tool invocation without any result", () => {
            describe("#when dropping the call", () => {
                it("#then it reports incomplete and leaves messages unchanged", () => {
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            { type: "tool-invocation", callID: "call-orphan" },
                        ]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "keep" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);

                    const target = createToolDropTarget(
                        "call-orphan",
                        thinkingParts,
                        index,
                        batch,
                        2,
                        sessionKey,
                    );
                    const result = target.drop();

                    expect(result).toBe("incomplete");
                    expect(hasCall(messages, "call-orphan")).toBe(true);
                    expect(thinkingParts[0]?.thinking).toBe("keep");
                });
            });
        });

        describe("#given no matching tool call id exists", () => {
            describe("#when dropping the call", () => {
                it("#then it reports absent without mutation", () => {
                    const messages: MessageLike[] = [
                        message("m-other", "assistant", [
                            { type: "tool-invocation", callID: "call-other" },
                        ]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "unchanged" },
                    ];
                    const index: ToolCallIndex = new Map();
                    const batch = new ToolMutationBatch(messages);

                    const target = createToolDropTarget(
                        "call-missing",
                        thinkingParts,
                        index,
                        batch,
                        3,
                        sessionKey,
                    );
                    const result = target.drop();

                    expect(result).toBe("absent");
                    expect(hasCall(messages, "call-other")).toBe(true);
                    expect(thinkingParts[0]?.thinking).toBe("unchanged");
                });
            });
        });

        describe("#given a complete tool pair with both tool and tool_result outputs", () => {
            describe("#when setContent is called", () => {
                it("#then it updates only result content and supports dropped-content removal", () => {
                    const toolResultPart = {
                        type: "tool_result",
                        tool_use_id: "call-2",
                        content: "old-result",
                    };
                    const toolPart = {
                        type: "tool",
                        callID: "call-2",
                        state: { output: "old-tool" },
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [{ type: "tool_use", id: "call-2" }]),
                        message("m-res", "tool", [toolPart]),
                        message("m-res-2", "assistant", [toolResultPart]),
                        // A later prompt, so this call does not end the conversation
                        // (drop() keeps that one as a skeleton instead of removing it).
                        message("m-next", "user", [{ type: "text", text: "next prompt" }]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "to clear" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget(
                        "call-2",
                        thinkingParts,
                        index,
                        batch,
                        4,
                        sessionKey,
                    );

                    target.setContent("replacement-content");

                    expect(toolPart.state.output).toBe("replacement-content");
                    expect(toolResultPart.content).toBe("replacement-content");
                    expect(hasCall(messages, "call-2")).toBe(true);

                    target.setContent("[dropped §2§]");
                    batch.finalize();

                    // Dropped-content removal is gone: the pair survives in the
                    // full released shape with an empty result slot.
                    expect(hasCall(messages, "call-2")).toBe(true);
                    const token = renderDropToken(4, sessionKey);
                    expect(messages[1]?.parts[0]).toEqual({
                        type: "tool",
                        callID: "call-2",
                        state: { output: "", attachments: [], input: { d: token } },
                    });
                    expect(messages[2]?.parts[0]).toEqual({
                        type: "tool_result",
                        tool_use_id: "call-2",
                        content: "",
                    });
                    // The live result parts keep their set content.
                    expect(toolPart.state.output).toBe("replacement-content");
                    expect(toolResultPart.content).toBe("replacement-content");
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[0]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[0])).toBe(true);
                });
            });
        });

        describe("#given drop is called twice on the same callId", () => {
            describe("#when the second drop runs", () => {
                it("#then it returns absent (idempotent)", () => {
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            { type: "tool-invocation", callID: "call-1" },
                        ]),
                        message("m-tool", "tool", [
                            { type: "tool", callID: "call-1", state: { output: "out" } },
                        ]),
                        // A later prompt, so this call does not end the conversation.
                        message("m-next", "user", [{ type: "text", text: "next prompt" }]),
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-1", [], index, batch, 5, sessionKey);

                    expect(target.drop()).toBe("removed");
                    expect(target.drop()).toBe("absent");
                });
            });
        });

        describe("#given the call whose result ends the conversation", () => {
            describe("#when dropping it", () => {
                it("#then it keeps a skeleton so the request still ends with a tool result", () => {
                    const toolPart = {
                        type: "tool",
                        tool: "bash",
                        callID: "call-last",
                        state: { status: "completed", input: { command: "cat f" }, output: "big" },
                    };
                    const messages: MessageLike[] = [
                        message("m-user", "user", [{ type: "text", text: "go" }]),
                        message("m-last", "assistant", [
                            { type: "step-start" },
                            { type: "text", text: "Reading." },
                            toolPart,
                            { type: "step-finish", reason: "tool-calls" },
                        ]),
                        // A blank pending assistant shell is not what the request ends with.
                        message("m-shell", "assistant", [{ type: "step-start" }]),
                    ];
                    const index: ToolCallIndex = new Map([
                        [
                            "call-last",
                            {
                                occurrences: [
                                    { message: messages[1]!, part: toolPart, kind: "result" },
                                ],
                                hasResult: true,
                            },
                        ],
                    ]);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget(
                        "call-last",
                        [],
                        index,
                        batch,
                        9,
                        sessionKey,
                    );

                    expect(target.drop()).toBe("truncated");
                    batch.finalize();

                    const kept = messages[1]?.parts.find(
                        (part) => (part as { type?: string }).type === "tool",
                    ) as { callID: string; state: { output: string } } | undefined;
                    expect(kept?.callID).toBe("call-last");
                    expect(kept?.state.output).toBe(TOOL_RELEASED_SENTINEL);
                    // The conversation-end skeleton keeps the call's REAL arguments.
                    expect(kept?.state).toEqual({
                        status: "completed",
                        input: { command: "cat f" },
                        output: "",
                    });
                    expect(toolPart.state.output).toBe("big");
                });
            });
        });

        describe("#given a complete tool pair with structured input", () => {
            describe("#when truncate is called", () => {
                it("#then it replaces inputs with the token carrier while releasing result content", () => {
                    const toolResultPart = {
                        type: "tool_result",
                        tool_use_id: "call-3",
                        content: "old-result",
                    };
                    const toolPart = {
                        type: "tool",
                        callID: "call-3",
                        state: {
                            input: {
                                query: "abcdef",
                                short: "abc",
                                files: ["a", "b"],
                                metadata: { nested: true },
                                exact: true,
                                limit: 2,
                            },
                            output: "old-tool",
                        },
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [{ type: "tool_use", id: "call-3" }]),
                        message("m-res", "tool", [toolPart]),
                        message("m-res-2", "assistant", [toolResultPart]),
                    ];
                    const thinkingParts: ThinkingLikePart[] = [
                        { type: "thinking", thinking: "to clear" },
                        { type: "reasoning", text: "trace" },
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget(
                        "call-3",
                        thinkingParts,
                        index,
                        batch,
                        7,
                        sessionKey,
                    );

                    expect(target.truncate()).toBe("truncated");

                    batch.finalize();

                    expect(hasCall(messages, "call-3")).toBe(true);
                    expect(messages).toHaveLength(3);

                    // The wire copies now in the message array carry the full
                    // released shape: carrier args in the first string seat, empty result.
                    const token = renderDropToken(7, sessionKey);
                    const wireToolPart = messages[1]?.parts[0] as {
                        state: Record<string, unknown>;
                    };
                    expect(wireToolPart.state).toEqual({
                        input: { query: token },
                        output: "",
                        attachments: [],
                    });
                    const wireResultPart = messages[2]?.parts[0] as { content: string };
                    expect(wireResultPart.content).toBe("");

                    // ...while the LIVE part objects OpenCode handed us stay
                    // byte-identical: the clamp swaps in a clone and never touches
                    // the originals (mutation-safety guarantee).
                    expect(toolPart.state as Record<string, unknown>).toEqual({
                        input: {
                            query: "abcdef",
                            short: "abc",
                            files: ["a", "b"],
                            metadata: { nested: true },
                            exact: true,
                            limit: 2,
                        },
                        output: "old-tool",
                    });
                    expect(toolResultPart.content).toBe("old-result");
                    expect(wireToolPart).not.toBe(toolPart);
                    expect(wireResultPart).not.toBe(toolResultPart);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[0]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[0])).toBe(true);
                    // A drop takes the reasoning off the wire whole instead of writing "[cleared]" into it.
                    expect(thinkingParts[1]).toEqual({ type: "text", text: "" });
                    expect(isNeutralizedReasoningPart(thinkingParts[1])).toBe(true);
                });

                it("#then replaces reporter-shaped inputs with the token carrier in the first string seat", () => {
                    const token = renderDropToken(431, sessionKey);
                    const cases = [
                        {
                            tool: "bash",
                            input: { command: `which ${"x".repeat(700)}` },
                            legacyFragment: "which...[truncated]",
                            realKeys: ["command"],
                        },
                        {
                            tool: "edit",
                            input: {
                                filePath: "/tmp/example.ts",
                                oldString: `const ${"x".repeat(700)}`,
                                newString: `const ${"y".repeat(700)}`,
                            },
                            legacyFragment: "const...[truncated]",
                            realKeys: ["filePath", "oldString", "newString"],
                        },
                        {
                            tool: "write",
                            input: {
                                filePath: `/tmp/${"x".repeat(700)}`,
                                content: "payload",
                            },
                            legacyFragment: "/tmp/...[truncated]",
                            realKeys: ["filePath", "content"],
                        },
                        {
                            tool: "ctx_memory",
                            input: {
                                action: "write",
                                category: "ARCHITECTURE",
                                content: `write${"x".repeat(700)}`,
                            },
                            legacyFragment: "write...[truncated]",
                            realKeys: ["action", "category", "content"],
                        },
                    ];

                    for (const [index, testCase] of cases.entries()) {
                        const callId = `reporter-${testCase.tool}`;
                        const toolPart = {
                            type: "tool",
                            tool: testCase.tool,
                            callID: callId,
                            state: {
                                status: "completed",
                                input: testCase.input,
                                output: "completed",
                            },
                        };
                        const messages: MessageLike[] = [
                            message(`m-${index}`, "assistant", [toolPart]),
                        ];
                        const target = createToolDropTarget(
                            callId,
                            [],
                            buildIndex(messages),
                            new ToolMutationBatch(messages),
                            431,
                            sessionKey,
                        );

                        expect(target.truncate()).toBe("truncated");
                        const wire = messages[0]?.parts[0] as {
                            state: { input: Record<string, unknown>; output: string };
                        };
                        // The carrier keeps the schema-shaped seat — the FIRST
                        // string-valued key — and fills it with the token.
                        const firstStringKey = testCase.realKeys[0]!;
                        expect(wire.state.input).toEqual({ [firstStringKey]: token });
                        expect(Object.keys(wire.state.input)).toEqual([firstStringKey]);
                        expect(wire.state.output).toBe("");
                        for (const key of testCase.realKeys.slice(1)) {
                            expect(wire.state.input).not.toHaveProperty(key);
                        }
                        const serialized = JSON.stringify(wire.state.input);
                        expect(serialized).not.toContain("[truncated]");
                        expect(serialized).not.toContain(testCase.legacyFragment);
                        // The live input keeps every real value for the host.
                        expect(toolPart.state.input).toEqual(testCase.input);
                    }
                });

                it("#then truncates large inputs before keeping the tool structure", () => {
                    const largeQuery = "x".repeat(600);
                    const toolPart = {
                        type: "tool",
                        callID: "call-4",
                        state: {
                            input: {
                                query: largeQuery,
                                files: ["a", "b"],
                                metadata: { nested: true },
                            },
                            output: "old-tool",
                        },
                    };
                    const messages: MessageLike[] = [
                        message("m-inv", "assistant", [
                            {
                                type: "tool-invocation",
                                callID: "call-4",
                                args: { query: largeQuery },
                            },
                        ]),
                        message("m-res", "tool", [toolPart]),
                    ];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget("call-4", [], index, batch, 9, sessionKey);

                    expect(target.truncate()).toBe("truncated");

                    // The wire copy now in the message array carries the full
                    // released shape...
                    const token = renderDropToken(9, sessionKey);
                    const wireToolPart = messages[1]?.parts[0] as {
                        state: Record<string, unknown>;
                    };
                    expect(wireToolPart.state).toEqual({
                        input: { query: token },
                        output: "",
                        attachments: [],
                    });
                    // The paired invocation's args become the same carrier.
                    const wireInvocation = messages[0]?.parts[0] as {
                        args: Record<string, unknown>;
                    };
                    expect(wireInvocation.args).toEqual({ query: token });

                    // ...while the LIVE part object stays byte-identical (long
                    // prompt intact) so a still-executing tool is never corrupted.
                    expect(toolPart.state as Record<string, unknown>).toEqual({
                        input: {
                            query: largeQuery,
                            files: ["a", "b"],
                            metadata: { nested: true },
                        },
                        output: "old-tool",
                    });
                    expect(wireToolPart).not.toBe(toolPart);
                });
            });
        });

        describe("#given a pending/running OpenCode tool part (no result output yet)", () => {
            describe("#when any drop/clamp selector runs", () => {
                it("#then it is treated as an open arc: never targeted and left byte-identical", () => {
                    const longPrompt = `Fix the auth bug and add coverage. ${"x".repeat(600)}`;
                    const taskPart = {
                        type: "tool",
                        tool: "task",
                        callID: "call-task",
                        state: {
                            status: "running",
                            input: { prompt: longPrompt, subagent_type: "mason" },
                        },
                    };
                    const pristine = JSON.stringify(taskPart);
                    const messages: MessageLike[] = [message("m-task", "assistant", [taskPart])];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget(
                        "call-task",
                        [],
                        index,
                        batch,
                        11,
                        sessionKey,
                    );

                    // Open arc (invocation with no completed result) is excluded
                    // from EVERY selector: canDrop, drop, truncate, editMarker.
                    expect(target.canDrop()).toBe(false);
                    expect(target.truncate()).toBe("incomplete");
                    expect(target.drop()).toBe("incomplete");
                    expect(target.editMarker()).toBe("incomplete");

                    // The live part object is byte-identical and still the same
                    // reference in the wire array.
                    expect(JSON.stringify(taskPart)).toBe(pristine);
                    expect(messages[0]?.parts[0]).toBe(taskPart);
                });
            });
        });

        describe("#given a completed tool part with a long argument (background task shape)", () => {
            describe("#when truncate runs", () => {
                it("#then the wire copy carries the clamp while the live object stays intact", () => {
                    const longPrompt = `Investigate and fix the regression. ${"y".repeat(600)}`;
                    const taskPart = {
                        type: "tool",
                        tool: "task",
                        callID: "call-bg",
                        state: {
                            status: "completed",
                            input: { prompt: longPrompt, subagent_type: "mason" },
                            output: '<task state="running">started</task>',
                        },
                    };
                    const pristine = JSON.stringify(taskPart);
                    const messages: MessageLike[] = [message("m-bg", "assistant", [taskPart])];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget(
                        "call-bg",
                        [],
                        index,
                        batch,
                        12,
                        sessionKey,
                    );

                    expect(target.canDrop()).toBe(true);
                    expect(target.truncate()).toBe("truncated");

                    // The wire copy now in the array carries the full released shape...
                    const wire = messages[0]?.parts[0] as {
                        state: {
                            input: Record<string, unknown>;
                            output: string;
                            attachments: unknown[];
                        };
                    };
                    expect(wire).not.toBe(taskPart);
                    expect(wire.state.output).toBe("");
                    expect(wire.state.attachments).toEqual([]);
                    expect(wire.state.input).toEqual({ prompt: renderDropToken(12, sessionKey) });

                    // ...but the LIVE object OpenCode still holds is byte-identical
                    // to before the reclaim pass — the long prompt is intact, so a
                    // child agent spawning from it is never corrupted.
                    expect(JSON.stringify(taskPart)).toBe(pristine);
                    expect(taskPart.state.input.prompt).toBe(longPrompt);
                });
            });
        });

        describe("#given an errored OpenCode tool part (status error, no output, large input)", () => {
            describe("#when the selectors run", () => {
                it("#then it IS clamp-eligible (closed arm) and the clamp stays on the wire only", () => {
                    const bigContent = "z".repeat(600);
                    const failedWrite = {
                        type: "tool",
                        tool: "write",
                        callID: "call-err",
                        state: {
                            status: "error",
                            error: "permission denied",
                            input: { filePath: "/spec.md", content: bigContent },
                        },
                    };
                    const pristine = JSON.stringify(failedWrite);
                    const messages: MessageLike[] = [message("m-err", "assistant", [failedWrite])];
                    const index = buildIndex(messages);
                    const batch = new ToolMutationBatch(messages);
                    const target = createToolDropTarget(
                        "call-err",
                        [],
                        index,
                        batch,
                        13,
                        sessionKey,
                    );

                    // Errored arm is closed → eligible for every selector (this is
                    // the reclaim the old type-based gate also allowed; the new
                    // gate must NOT leak it).
                    expect(target.canDrop()).toBe(true);
                    expect(target.truncate()).toBe("truncated");

                    // Wire copy carries the full released shape...
                    const wire = messages[0]?.parts[0] as {
                        state: {
                            input: Record<string, unknown>;
                            output: string;
                            attachments: unknown[];
                        };
                    };
                    expect(wire).not.toBe(failedWrite);
                    expect(wire.state.output).toBe("");
                    expect(wire.state.attachments).toEqual([]);
                    expect(wire.state.input).toEqual({
                        filePath: renderDropToken(13, sessionKey),
                    });

                    // ...live object stays byte-identical: reclaimed via a clone,
                    // never by mutating the original part.
                    expect(JSON.stringify(failedWrite)).toBe(pristine);
                    expect(failedWrite.state.input.content).toBe(bigContent);
                });
            });
        });
    });

    describe("hasMeaningfulPart", () => {
        it("returns false for empty text", () => {
            expect(hasMeaningfulPart({ type: "text", text: "" })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "   " })).toBe(false);
        });

        it("returns false for text containing only tag prefixes", () => {
            expect(hasMeaningfulPart({ type: "text", text: "§424§ " })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "§424§" })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "§424§   " })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: "§1§ §2§ " })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: '§15298">§15298§ ' })).toBe(false);
            expect(hasMeaningfulPart({ type: "text", text: '§15298">§ ' })).toBe(false);
        });

        it("returns true for text with actual content", () => {
            expect(hasMeaningfulPart({ type: "text", text: "hello" })).toBe(true);
            expect(hasMeaningfulPart({ type: "text", text: "§424§ hello" })).toBe(true);
            expect(hasMeaningfulPart({ type: "text", text: '§15298">§15298§ hello' })).toBe(true);
        });

        it("returns true for tools", () => {
            expect(hasMeaningfulPart({ type: "tool" })).toBe(true);
            expect(hasMeaningfulPart({ type: "tool_result" })).toBe(true);
        });

        it("returns false for non-record types", () => {
            expect(hasMeaningfulPart(null)).toBe(false);
            expect(hasMeaningfulPart(undefined)).toBe(false);
            expect(hasMeaningfulPart("string")).toBe(false);
            expect(hasMeaningfulPart(123)).toBe(false);
        });

        it("returns false for ignored part types", () => {
            expect(hasMeaningfulPart({ type: "step-start" })).toBe(false);
            expect(hasMeaningfulPart({ type: "step-finish" })).toBe(false);
            expect(hasMeaningfulPart({ type: "thinking" })).toBe(false);
            expect(hasMeaningfulPart({ type: "reasoning" })).toBe(false);
            expect(hasMeaningfulPart({ type: "redacted_thinking" })).toBe(false);
            expect(hasMeaningfulPart({ type: "meta" })).toBe(false);
        });
    });
});

it("reclaim preview counts the retained skeleton without mutating the served parts", () => {
    const messages = [
        message("m", "assistant", [
            {
                type: "tool",
                callID: "c",
                tool: "read",
                state: {
                    input: { path: "sample.txt" },
                    output: "word ".repeat(999),
                    status: "completed",
                },
            },
        ]),
    ];
    const bytes = JSON.stringify(messages);
    const target = createToolDropTarget(
        "c",
        [],
        buildIndex(messages),
        new ToolMutationBatch(messages),
        12,
        sessionKey,
    );
    const full = target.measureReclaim(false);
    const skeleton = target.measureReclaim(true);
    expect(full.beforeTools).toBeGreaterThan(1000);
    expect(full.afterTools).toBe(0);
    expect(skeleton.afterTools).toBeGreaterThan(0);
    expect(skeleton.afterTools).toBeLessThan(skeleton.beforeTools);
    expect(JSON.stringify(messages)).toBe(bytes);
});

describe("released-result slot anti-imitation law", () => {
    it("#then the skeleton releases the result slot to empty content, never imitable bytes", () => {
        expect(TOOL_RELEASED_SENTINEL).toBe("");
        const toolPart = {
            type: "tool",
            callID: "law-empty",
            state: {
                status: "completed",
                input: { command: "ls -la" },
                output: "x".repeat(500),
            },
        };
        const messages: MessageLike[] = [
            message("m-inv", "assistant", [{ type: "tool_use", id: "law-empty" }]),
            message("m-res", "tool", [toolPart]),
        ];
        const batch = new ToolMutationBatch(messages);
        const target = createToolDropTarget(
            "law-empty",
            [],
            buildIndex(messages),
            batch,
            3,
            sessionKey,
        );
        expect(target.drop()).toBe("truncated");
        batch.finalize();
        const kept = messages[1]?.parts.find(
            (part) => (part as { type?: string }).type === "tool",
        ) as { callID: string; state: { output: string; input: unknown } } | undefined;
        expect(kept?.callID).toBe("law-empty");
        expect(kept?.state.output).toBe("");
        // Skeleton-real: arguments stay visible while the result slot carries no bytes.
        expect(kept?.state.input).toEqual({ command: "ls -la" });
        expect(JSON.stringify(messages)).not.toContain('"..."');
    });
});
