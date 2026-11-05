/// <reference types="bun-types" />

import { beforeEach, describe, expect, it, mock } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

// ── Closure census for the volatile-segment lane (ruling 3, brace to the
// belt below) ──────────────────────────────────────────────────────────────
// The volatile lane renders head bytes only; it must have no code path into a
// message part-mutation primitive (it can never strip a protected block). The
// four direct-text pins only guard region-volatile.ts's own bytes; a rogue can
// reach a mutator by importing it (directly or through the transitive value
// graph) with a name the text scan never listed. These helpers walk the real
// transitive value-import closure from region-volatile.ts (within src/,
// following re-export barrels; type-only edges are skipped — erased, cannot
// execute) and fail closed on any value binding pulled out of a mutator module
// that is not on the pure-read allowlist. The mutator modules' own internals
// are never audited (they own the primitives by design); we audit only the
// edges the volatile lane makes into them.
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

interface ImportEdge {
    names: string[];
    spec: string;
    isType: boolean;
    kind: "named" | "namespace" | "default" | "star" | "sideeffect";
}

function importEdgesOf(text: string): ImportEdge[] {
    const edges: ImportEdge[] = [];
    let m: RegExpExecArray | null;
    const namedRe =
        /(import|export)\s+(type\s+)?\{([^}]*)\}\s*(?:as\s+\w+\s*)?from\s+["']([^"']+)["']/g;
    while ((m = namedRe.exec(text))) {
        const rawNames = m[3]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const valueNames = rawNames.filter((n) => !n.startsWith("type "));
        edges.push({
            names: valueNames,
            spec: m[4],
            isType: Boolean(m[2]) || rawNames.length === 0 || valueNames.length === 0,
            kind: "named",
        });
    }
    const nsRe = /(?:import|export)\s+\*\s+as\s+\w+\s+from\s+["']([^"']+)["']/g;
    while ((m = nsRe.exec(text)))
        edges.push({ names: ["*"], spec: m[1], isType: false, kind: "namespace" });
    const starRe = /export\s+\*\s+(type\s+)?from\s+["']([^"']+)["']/g;
    while ((m = starRe.exec(text)))
        edges.push({ names: ["*"], spec: m[2], isType: Boolean(m[1]), kind: "star" });
    const defRe = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\})?\s*from\s+["']([^"']+)["']/g;
    while ((m = defRe.exec(text)))
        edges.push({ names: [m[1]], spec: m[2], isType: false, kind: "default" });
    const sideRe = /^[ \t]*import\s+["']([^"']+)["']/gm;
    while ((m = sideRe.exec(text)))
        edges.push({ names: [], spec: m[1], isType: false, kind: "sideeffect" });
    return edges;
}

function volatileSpecToFile(srcRoot: string, fromFile: string, spec: string): string | null {
    if (!spec.startsWith(".")) return null;
    const base = resolve(fromFile, "..", spec);
    for (const c of [
        base,
        `${base}.ts`,
        `${base}.tsx`,
        join(base, "index.ts"),
        join(base, "index.tsx"),
    ]) {
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

function findVolatileMutationReach(
    overrides?: Map<string, string>,
    allowlistOverride?: Record<string, ReadonlySet<string>>,
): string[] {
    const srcRoot = resolve(import.meta.dirname, "..", "..");
    const start = join(srcRoot, "hooks", "magic-context", "region-volatile.ts");
    const read = (p: string): string => overrides?.get(p) ?? readFileSync(p, "utf8");
    const allowlist = allowlistOverride ?? VOLATILE_MUTATOR_ALLOWLIST;
    const rel = (p: string): string => p.slice(srcRoot.length + 1);
    const violations: string[] = [];
    const seen = new Set<string>([start]);
    const queue: string[] = [start];
    while (queue.length > 0) {
        const file = queue.shift() as string;
        for (const edge of importEdgesOf(read(file))) {
            if (edge.isType) continue;
            const target = volatileSpecToFile(srcRoot, file, edge.spec);
            if (!target) continue;
            const basename = target.slice(target.lastIndexOf("/") + 1);
            if (VOLATILE_MUTATOR_BASENAMES.has(basename)) {
                const allowed = allowlist[basename];
                if (edge.kind === "named") {
                    for (const name of edge.names) {
                        if (!allowed?.has(name)) {
                            violations.push(`${rel(file)} -[named ${name}]-> ${basename}`);
                        }
                    }
                } else {
                    violations.push(`${rel(file)} -[${edge.kind}]-> ${basename}`);
                }
                continue; // never audit a mutator module's own internals
            }
            if (!seen.has(target)) {
                seen.add(target);
                queue.push(target);
            }
        }
    }
    return violations;
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
                // BRACES: the real transitive value-import closure (not a string
                // list) reaches no part-mutation export. A rogue cannot evade by
                // importing a mutator under a name the belt never listed, or by
                // smuggling one through a barrel two hops down the graph.
                expect(findVolatileMutationReach()).toEqual([]);
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

            it("REDS under planted part-mutation reach (committed rogue-loop witness)", () => {
                // #2780: a re-runnable witness, not a run-then-delete disclosure.
                // Each rogue is a virtual patch (plant not shipped); the census
                // must turn red and name the smuggled binding. The first is the
                // reviewer's exact evade class (a direct makeSentinel import the
                // four-string belt never listed); the others prove the walk is
                // transitive and barrel-aware, not first-order-only.
                const srcRoot = resolve(import.meta.dirname, "..", "..");
                const rv = join(srcRoot, "hooks", "magic-context", "region-volatile.ts");
                const dr = join(srcRoot, "hooks", "magic-context", "decay-render.ts");
                // Discovery witness on the REAL tree (no injection): stripping the
                // allowlist must surface the one genuine deep edge — the volatile
                // closure reaches read-session-chunk.ts (many hops down) and finds
                // its extractToolCallObservation import of tool-drop-target. A
                // 1-hop-only walk would never see it, so this proves transitivity.
                const stripped = findVolatileMutationReach(undefined, {});
                expect(stripped.join("\n")).toContain("read-session-chunk.ts");
                expect(stripped.join("\n")).toContain("extractToolCallObservation");
                const rogues: Array<{
                    label: string;
                    overrides: Map<string, string>;
                    needle: string;
                }> = [
                    {
                        label: "direct mutator import (reviewer evade: makeSentinel)",
                        overrides: new Map([
                            [
                                rv,
                                `${readFileSync(rv, "utf8")}\nimport { makeSentinel } from "./sentinel";\n`,
                            ],
                        ]),
                        needle: "makeSentinel",
                    },
                    {
                        label: "transitive mutator import through a reachable renderer",
                        overrides: new Map([
                            [
                                dr,
                                `${readFileSync(dr, "utf8")}\nimport { createToolDropTarget } from "./tool-drop-target";\n`,
                            ],
                        ]),
                        needle: "createToolDropTarget",
                    },
                    {
                        label: "barrel re-export of a whole-message sentinel mint",
                        overrides: new Map([
                            [
                                dr,
                                `${readFileSync(dr, "utf8")}\nexport { makeWholeMessageSentinel } from "./sentinel";\n`,
                            ],
                        ]),
                        needle: "makeWholeMessageSentinel",
                    },
                    {
                        label: "side-effect import of a mutator module",
                        overrides: new Map([
                            [rv, `${readFileSync(rv, "utf8")}\nimport "./sentinel";\n`],
                        ]),
                        needle: "[sideeffect]-> sentinel.ts",
                    },
                ];
                for (const rogue of rogues) {
                    const violations = findVolatileMutationReach(rogue.overrides);
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
