/**
 * Dead tag-strip family removal laws (ruling #2812, assembly-v2 dead-code unit).
 *
 * The plugin wire is prefix-free (wire `§N§ ` absent since ctxv12; the field
 * carries no prefix-era stored message bytes), so every OpenCode-side
 * stripTagPrefix call is an identity function on reachable data. These laws
 * pin three things while the removal proceeds:
 *
 * 1. STRIP-IDENTITY — at each surviving OpenCode-side call site's production
 *    composition, the strip call returns its input unchanged on real-shaped
 *    wire data (parts, sources, and sweep decisions are byte-stable).
 * 2. Census — the deleted sinks (tagMessages `skipPrefixInjection` /
 *    `normalizationTargets` / `TagNormalizationTarget`) have no production
 *    callers; `prependTag` keeps zero production callers; the symbols Pi's
 *    tag-era lane imports (ruling C) stay in place with their regex family.
 * 3. Witnesses — a planted prefix-bearing mint trips the existing prefix-free
 *    wire pins, and a planted new caller of the removed sinks is named by the
 *    census predicate (the laws are not vacuous).
 *
 * The census arm is red-first against the pre-deletion tree: the surviving
 * `skipPrefixInjection` pair is ONLY allowed in the Pi-side tagTranscript
 * files (shared/tag-transcript.ts + pi context-handler), which Pi passes at
 * context-handler.ts. Ownership was adjudicated by reading imports.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runMigrations } from "../../features/magic-context/migrations";
import { getSourceContents } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import type { Database as DatabaseType } from "../../shared/sqlite";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { stripTagPrefix } from "./tag-content-primitives";
import { type MessageLike, tagMessages } from "./tag-messages";
import { buildFileSourceContent } from "./tag-part-guards";
import { hasMeaningfulPart } from "./tool-drop-target";
import { classifyToolSweepCandidates } from "./tool-sweep-policy";

const SECTION = "§";

// Real-shaped OpenCode wire data per the prefix-free law: model-authored text
// with the shapes production actually serves — leading digits, numbered
// lists, markdown, code fences, leading newline, mid-text `§`, unicode. No
// string here starts with the line-leading tag-marker shape (that state is
// the planted-rogue arm below, never reachable data).
const REALISTIC_TEXTS = [
    "run the tests and fix the lint errors",
    "99 files are located in folder zzz",
    "2024 roadmap: 1. ship, 2. measure",
    "1. First step\n2. Second step\n3. Third step",
    "#### Deployment notes\n\n- stage the artifact\n- §5 of the guide covers rollback",
    "```ts\nconst x = 42;\n```",
    "\nleading newline, digits 2030 stay\n",
    "I fixed the stray `§` in the changelog mid-text",
    "→ arrow + ünïcödé + 日本語",
];

const REALISTIC_TOOL_OUTPUTS = [
    "1: hello probe (call-0)",
    "total 8\ndrwxr-xr-x  3 user staff   96 Nov  6 09:00 .",
    "test suite: 42 pass, 0 fail",
];

function openTestDb(): DatabaseType {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function makeRealisticMessages(sessionId: string): MessageLike[] {
    return [
        {
            info: { id: "m-user-1", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: REALISTIC_TEXTS[0] }],
        },
        {
            info: { id: "m-assistant-1", role: "assistant", sessionID: sessionId },
            parts: [
                ...REALISTIC_TEXTS.map((text) => ({ type: "text", text })),
                { type: "text", text: " \t " },
            ],
        },
        {
            info: { id: "m-assistant-2", role: "assistant", sessionID: sessionId },
            parts: REALISTIC_TOOL_OUTPUTS.map((output, index) => ({
                type: "tool",
                tool: "read",
                callID: `law-call-${index}`,
                state: {
                    status: "completed",
                    input: { filePath: `/work/law-${index}.txt` },
                    output,
                },
            })),
        },
        {
            info: { id: "m-user-2", role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: "thanks" }],
        },
    ];
}

/** Byte snapshot of every text/tool-output string reachable on the array. */
function snapshot(messages: readonly MessageLike[]): string[] {
    const out: string[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            const p = part as Record<string, unknown>;
            if (typeof p.text === "string") out.push(p.text);
            const state = p.state as { output?: unknown } | undefined;
            if (state && typeof state.output === "string") out.push(state.output);
        }
    }
    return out;
}

describe("STRIP-IDENTITY: surviving call sites return input unchanged on real-shaped data", () => {
    it("every real-shaped string is a fixed point of stripTagPrefix", () => {
        for (const text of [...REALISTIC_TEXTS, ...REALISTIC_TOOL_OUTPUTS]) {
            expect(stripTagPrefix(text)).toBe(text);
        }
    });

    it("tagMessages walk: parts byte-stable, persisted sources are the full originals", () => {
        const db = openTestDb();
        const sessionId = "ses-strip-law-tagmessages";
        const messages = makeRealisticMessages(sessionId);
        const before = snapshot(messages);

        const result = tagMessages(sessionId, messages, createTagger(), db);
        result.batch.finalize();

        // The strip calls at the whitespace guard, the token-count lambdas,
        // and the source-content site may not touch a single byte.
        expect(snapshot(messages)).toEqual(before);

        // Persistence boundary: source_contents must equal the full original
        // text — a non-identity strip would store a shortened copy.
        const originalByTextPart = new Map<string, string>();
        for (const message of messages) {
            const messageId = message.info.id;
            if (typeof messageId !== "string") continue;
            message.parts.forEach((part, partIndex) => {
                const p = part as Record<string, unknown>;
                if (typeof p.text === "string" && p.text.trim().length > 0) {
                    originalByTextPart.set(`${messageId}:p${partIndex}`, p.text);
                }
            });
        }
        const messageTags = getTagsBySession(db, sessionId).filter((tag) => tag.type === "message");
        expect(messageTags.length).toBeGreaterThan(0);
        const sources = getSourceContents(
            db,
            sessionId,
            messageTags.map((tag) => tag.tagNumber),
        );
        let checked = 0;
        for (const tag of messageTags) {
            const original = originalByTextPart.get(tag.messageId);
            if (original === undefined) continue;
            expect(sources.get(tag.tagNumber), tag.messageId).toBe(original);
            checked += 1;
        }
        expect(checked).toBe(originalByTextPart.size);
    });

    it("tagMessages tool walk: tool outputs byte-stable through the token-count strip", () => {
        const db = openTestDb();
        const sessionId = "ses-strip-law-toolwalk";
        const messages = makeRealisticMessages(sessionId);
        const before = snapshot(messages);
        const result = tagMessages(sessionId, messages, createTagger(), db);
        result.batch.finalize();
        const toolOutputs = snapshot(messages).filter((value) =>
            REALISTIC_TOOL_OUTPUTS.includes(value),
        );
        expect(toolOutputs).toEqual(REALISTIC_TOOL_OUTPUTS);
        expect(snapshot(messages)).toEqual(before);
    });

    it("tool-drop-target guard: verdict equals the naive non-empty check on real data", () => {
        for (const text of [...REALISTIC_TEXTS, ...REALISTIC_TOOL_OUTPUTS]) {
            expect(hasMeaningfulPart({ type: "text", text })).toBe(text.trim().length > 0);
        }
        expect(hasMeaningfulPart({ type: "text", text: "   " })).toBe(false);
    });

    it("tag-part-guards.buildFileSourceContent joins the raw texts unstripped", () => {
        const parts = REALISTIC_TEXTS.map((text) => ({ type: "text", text }));
        expect(buildFileSourceContent(parts)).toBe(REALISTIC_TEXTS.join("\n").trim());
        expect(buildFileSourceContent([{ type: "text", text: "99 files are located" }])).toBe(
            "99 files are located",
        );
    });

    it("tool-sweep-policy: sweep decision is invariant under the identity strip", () => {
        const lastServed = makeRealisticMessages("ses-strip-law-sweep");
        const legacy = makeRealisticMessages("ses-strip-law-sweep");
        const scoped = makeRealisticMessages("ses-strip-law-sweep");
        scoped.pop();
        const matched = classifyToolSweepCandidates(lastServed, { legacy, scoped });
        expect(matched.condition).toBe("matched_old");
        expect(matched.scoped).toBe(false);
        const diverged = classifyToolSweepCandidates(lastServed, { legacy: scoped, scoped });
        expect(diverged.condition).toBe("matched_neither");
        // The whitespace-framing row must not reach the provider under either
        // arm — the guard's emptiness verdict matches the unstripped check.
        const wsOnly = classifyToolSweepCandidates(
            [{ info: { id: "w", role: "assistant" }, parts: [{ type: "text", text: " \t" }] }],
            { legacy: [], scoped: [] },
        );
        expect(wsOnly.lastServedRows).toBe(0);
    });

    it("heuristic-cleanup: real-shaped parts survive the injection-strip walk unchanged", () => {
        const db = openTestDb();
        const sessionId = "ses-strip-law-cleanup";
        const messages = makeRealisticMessages(sessionId);
        const before = snapshot(messages);
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const tagged = tagMessages(sessionId, messages, tagger, db);
        const cleanup = applyHeuristicCleanup(
            sessionId,
            db,
            tagged.targets,
            tagged.messageTagNumbers,
            { protectedTagNumbers: new Set(), protectedCutoff: null },
        );
        tagged.batch.finalize();
        expect(cleanup.droppedTools).toBe(0);
        expect(cleanup.deduplicatedTools).toBe(0);
        expect(cleanup.droppedInjections).toBe(0);
        expect(cleanup.mutatedTextTags).toBe(0);
        expect(cleanup.compressedTextTags).toBe(0);
        expect(snapshot(messages)).toEqual(before);
    });
});

// ── Census scanner (entry-law shape): production rows across BOTH lanes ────

const PKG_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const PLUGIN_SRC = join(PKG_ROOT, "src");
const PI_SRC = resolve(PKG_ROOT, "..", "pi-plugin", "src");
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".codegraph"]);
const TS_EXT = /\.(ts|tsx|mts|cts|mjs|cjs)$/;

function collect(dir: string, out: string[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collect(full, out);
        else if (TS_EXT.test(name)) out.push(full);
    }
}

function productionRows(
    extraDirs: Array<{ dir: string; prefix: string }> = [],
): Array<{ rel: string; text: string }> {
    const rows: Array<{ rel: string; text: string }> = [];
    const emit = (file: string, rel: string) => {
        if (file.endsWith(".test.ts")) return;
        rows.push({ rel, text: readFileSync(file, "utf8") });
    };
    for (const [root, prefix] of [
        [PLUGIN_SRC, "plugin/"],
        [PI_SRC, "pi-plugin/"],
    ] as const) {
        const files: string[] = [];
        collect(root, files);
        for (const file of files) emit(file, `${prefix}${file.slice(root.length + 1)}`);
    }
    for (const { dir, prefix } of extraDirs) {
        const planted: string[] = [];
        collect(dir, planted);
        for (const file of planted) emit(file, `${prefix}${file.slice(dir.length + 1)}`);
    }
    return rows;
}

function referencing(rows: ReturnType<typeof productionRows>, pattern: RegExp): string[] {
    return rows.filter((row) => pattern.test(row.text)).map((row) => row.rel);
}

describe("census: the deleted family stays deleted; Pi-owned symbols stay owned", () => {
    const rows = productionRows();

    it("no production file references normalizationTargets/TagNormalizationTarget", () => {
        expect(referencing(rows, /normalizationTargets|TagNormalizationTarget/)).toEqual([]);
    });

    it("skipPrefixInjection survives ONLY in the Pi-side tagTranscript pair (ruling C)", () => {
        expect(referencing(rows, /skipPrefixInjection/).sort()).toEqual([
            "pi-plugin/context-handler.ts",
            "plugin/shared/tag-transcript.ts",
        ]);
    });

    it("the OpenCode tagging path (tag-messages/transform) carries no prefix-injection machinery", () => {
        for (const rel of [
            "plugin/hooks/magic-context/tag-messages.ts",
            "plugin/hooks/magic-context/transform.ts",
        ]) {
            const row = rows.find((r) => r.rel === rel);
            expect(row, `${rel} must exist`).toBeDefined();
            expect(row?.text).not.toMatch(/skipPrefixInjection|normalizationTargets/);
        }
    });

    it("prependTag has zero production callers outside its definition site", () => {
        const named = referencing(rows, /prependTag/).filter(
            (rel) => rel !== "plugin/hooks/magic-context/tag-content-primitives.ts",
        );
        expect(named).toEqual([]);
    });

    it("Pi tag-era lane dependencies are intact (ruling C retention guards)", () => {
        const primitives = rows.find(
            (r) => r.rel === "plugin/hooks/magic-context/tag-content-primitives.ts",
        );
        expect(primitives?.text).toContain("export function stripTagPrefix");
        expect(primitives?.text).toContain("export function prependTag");
        expect(primitives?.text).toContain("export function peelLeadingMcTagNotation");
        expect(primitives?.text).toContain("export function stripPersistedAssistantText");
        // The three regex shapes stripTagPrefix runs: canonical, malformed
        // hybrid, dangling-open. The plugin wire is prefix-free, but Pi's
        // data legitimately carries prefixes — these must not be silently
        // deleted from the shared function.
        expect(primitives?.text).toContain("^(?:§\\d+§\\s*)+");
        expect(primitives?.text).toContain('^(?:§\\d+">§(?:\\d+§)?\\s*)+');
        expect(primitives?.text).toContain("\\u00a7\\d+(?!\\.\\d)[^\\s\\u00a7\\w.]?");
        const contextHandler = rows.find((r) => r.rel === "pi-plugin/context-handler.ts");
        expect(contextHandler?.text).toContain(
            'import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-content-primitives"',
        );
        const temporal = rows.find((r) => r.rel === "pi-plugin/temporal-awareness-pi.ts");
        expect(temporal?.text).toContain("peelLeadingMcTagNotation");
        const cleanupPi = rows.find((r) => r.rel === "pi-plugin/heuristic-cleanup-pi.ts");
        expect(cleanupPi?.text).toContain(
            'import { stripTagPrefix } from "@magic-context/core/hooks/magic-context/tag-part-guards"',
        );
    });
});

describe("witnesses: the laws have teeth", () => {
    it("witness (wire): a planted prefix-bearing mint survives to the provider array and trips the prefix-free pins", () => {
        const db = openTestDb();
        const sessionId = "ses-strip-law-rogue-mint";
        // Simulates a rogue production mint that re-materializes the wire
        // prefix on an assistant text part (the deleted prependTag shape).
        const messages: MessageLike[] = [
            {
                info: { id: "m-user", role: "user", sessionID: sessionId },
                parts: [{ type: "text", text: "ship it" }],
            },
            {
                info: { id: "m-assistant", role: "assistant", sessionID: sessionId },
                parts: [{ type: "text", text: `${SECTION}7${SECTION} planted-rogue-mint body` }],
            },
        ];
        const result = tagMessages(sessionId, messages, createTagger(), db);
        result.batch.finalize();
        const wire = messages
            .flatMap((message) => message.parts)
            .map((part) => (part as { text?: string }).text ?? "")
            .join("\n");
        // The rogue prefix reaches the served array unsanitized — exactly the
        // state the existing prefix-free wire pins fail on
        // (transform-compaction-off.test.ts `expect(wire).not.toMatch(/§\d+§/)`,
        // the transform.test.ts served-digest pin, and the region goldens).
        // The witness is green while those laws have teeth: it reddens if the
        // wire path ever sanitizes the shape away and the pins go blind.
        expect(wire).toMatch(/\u00a7\d+\u00a7/);
    });

    it("witness (census): a planted new caller of the removed sinks is named by the predicate", () => {
        const { dir } = createTestTempDir("mc-strip-law-rogue-caller-");
        try {
            writeFileSync(
                join(dir, "rogue_caller.ts"),
                [
                    'import { tagMessages } from "./tag-messages";',
                    "declare const session: string;",
                    "declare const messages: Parameters<typeof tagMessages>[1];",
                    "declare const tagger: Parameters<typeof tagMessages>[2];",
                    "declare const db: Parameters<typeof tagMessages>[3];",
                    "const result = tagMessages(session, messages, tagger, db, {",
                    "    skipPrefixInjection: true,",
                    "});",
                    "export const sinks = result.normalizationTargets.length;",
                ].join("\n"),
                "utf8",
            );
            const planted = productionRows([{ dir, prefix: "planted/" }]);
            const named = referencing(planted, /normalizationTargets|skipPrefixInjection/);
            expect(named).toContain("planted/rogue_caller.ts");
        } finally {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
