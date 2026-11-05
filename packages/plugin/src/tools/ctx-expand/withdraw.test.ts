/**
 * Stamp-withdraw laws (ctx_expand regret-signal closure).
 *
 * Field telemetry: the model re-issues an identical (tool,input) call for
 * content whose OWN earlier ctx_reduce stamp is still queued in pending_ops
 * and has not landed. ctx_expand already recovers from the raw store but
 * touches nothing, so the queued stamp lands at the next boundary anyway.
 * These laws pin the withdrawal: an expand whose resolved target carries a
 * PENDING agent stamp (operation "drop") deletes exactly that queue row via
 * the storage layer's sanctioned delete, echoes one canonical line per slot,
 * and never touches system-origin rows ("auto_drop"), landed tags, or any
 * byte of the served wire.
 *
 * The central property (round-1 adjudication): withdraw covers EXACTLY the
 * tags the render path serves — one shared resolver (resolveTagRender, the
 * same code renderItemByTag runs), no parallel rules. Where the renderer
 * would serve content, expand withdraws; where the renderer emits an error
 * string (owner unknown, owner/part gone, locator unresolvable), expand
 * refuses the withdrawal and echoes nothing.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { replaceAllCompartments } from "../../features/magic-context/compartment-storage";
import { runMigrations } from "../../features/magic-context/migrations";
import {
    type ContextDatabase,
    getPendingOps,
    getTagById,
    getTagsBySession,
    queuePendingOp,
    updateTagDropMode,
    updateTagStatus,
} from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getTagNumberByMessageId } from "../../features/magic-context/storage-tags";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage, TagEntry } from "../../features/magic-context/types";
import { setRawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import { createTransform } from "../../hooks/magic-context/transform";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createCtxReduceTools } from "../ctx-reduce/tools";
import { stampWithdrawnLine } from "./constants";
import { resolveTagRender } from "./render";
import { createCtxExpandTools } from "./tools";

const SESSION = "ses-withdraw";

function toolPart(callID: string, output: string, input: Record<string, unknown>) {
    return { type: "tool", tool: "read", callID, state: { input, output } };
}

interface FixtureMessage {
    ordinal: number;
    id: string;
    role: string;
    parts: unknown[];
}

function fixtureMessages(): FixtureMessage[] {
    return [
        {
            ordinal: 1,
            id: "one",
            role: "user",
            parts: [{ type: "text", text: "original text" }],
        },
        {
            ordinal: 2,
            id: "two",
            role: "assistant",
            parts: [toolPart("call-a", "output A", { filePath: "a.txt" })],
        },
        {
            ordinal: 3,
            id: "three",
            role: "user",
            parts: [{ type: "text", text: "middle text" }],
        },
        {
            ordinal: 4,
            id: "four",
            role: "assistant",
            parts: [toolPart("call-b", "output B", { command: "ls" })],
        },
    ];
}

interface WithdrawTags {
    messageTag: number;
    tagA: number;
    tagB: number;
    orphanA: number;
    ghostTool: number;
    fileTag: number;
    oobTextTag: number;
}

function makeFixture(): { db: Database; cleanup: () => void; tags: WithdrawTags } {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    const tagger = createTagger();
    const tags: WithdrawTags = {
        messageTag: tagger.assignTag(SESSION, "one:p0", "message", 10, db),
        tagA: tagger.assignToolTag(SESSION, "call-a", "two", 10, db),
        tagB: tagger.assignToolTag(SESSION, "call-b", "four", 10, db),
        // Legacy tool tag without a persisted owner (pre tag-owner-fix).
        orphanA: tagger.assignToolTag(SESSION, "call-orphan", "ghost", 10, db),
        // Tool tag whose owner message is gone from stored history.
        ghostTool: tagger.assignToolTag(SESSION, "call-ghost", "nope", 10, db),
        // :fileN-style locator: survives neither :pN nor :mc-text-v1: strip,
        // so the owner lookup fails.
        fileTag: tagger.assignTag(SESSION, "three:file1", "file", 10, db),
        // :pN locator past the message's part count: the owner resolves but
        // the part does not.
        oobTextTag: tagger.assignTag(SESSION, "one:p9", "message", 10, db),
    };
    db.prepare("UPDATE tags SET tool_owner_message_id = NULL WHERE tag_number = ?").run(
        tags.orphanA,
    );
    const cleanup = setRawMessageProvider(SESSION, {
        readMessages: () => fixtureMessages() as never,
    });
    return { db, cleanup, tags };
}

function expand(db: Database, args: Record<string, unknown>): Promise<string> {
    return createCtxExpandTools({ db }).ctx_expand.execute(args, {
        sessionID: SESSION,
    } as never);
}

function pendingTagIds(db: Database): number[] {
    return getPendingOps(db, SESSION).map((op) => op.tagId);
}

describe("W1 pre-land withdraw", () => {
    it("tag mode: deletes the queued agent stamp, echoes the canonical line, leaves the tag untouched", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            const before = getTagById(db, SESSION, tags.tagA) as TagEntry;
            const response = await expand(db, { tag: tags.tagA });
            expect(response).toContain("output A");
            expect(response).toContain(`stamp withdrawn: ${tags.tagA} stays in context`);
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
            const after = getTagById(db, SESSION, tags.tagA) as TagEntry;
            expect(after).toEqual(before);
            expect(after.status).toBe("active");
        } finally {
            cleanup();
            db.close();
        }
    });

    it("message mode: withdrawing by ordinal keys the line on the ordinal", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            const response = await expand(db, { message: 2 });
            expect(response).toContain("output A");
            expect(response).toContain("stamp withdrawn: 2 stays in context");
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("range mode: withdraws every pending agent stamp in the resolved span, one line per slot", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            queuePendingOp(db, SESSION, tags.tagB, "drop");
            queuePendingOp(db, SESSION, tags.messageTag, "drop");
            const response = await expand(db, { start: 1, end: 4 });
            expect(response).toContain("stamp withdrawn: 1 stays in context");
            expect(response).toContain("stamp withdrawn: 2 stays in context");
            expect(response).toContain("stamp withdrawn: 4 stays in context");
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("live-tail clamp path still withdraws: an entirely-tail range cancels the queue row with the existing echo", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            replaceAllCompartments(db, SESSION, [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 1,
                    startMessageId: "one",
                    endMessageId: "one",
                    title: "Early work",
                    content: "Summary",
                },
            ]);
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            const response = await expand(db, { start: 2, end: 4 });
            expect(response).toContain("entirely within the live tail");
            expect(response).toContain("stamp withdrawn: 2 stays in context");
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("partial-clamp range withdraws only through the effective end", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            replaceAllCompartments(db, SESSION, [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 2,
                    startMessageId: "one",
                    endMessageId: "two",
                    title: "Early work",
                    content: "Summary",
                },
            ]);
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            queuePendingOp(db, SESSION, tags.tagB, "drop");
            const response = await expand(db, { start: 1, end: 4 });
            expect(response).toContain("stamp withdrawn: 2 stays in context");
            expect(response).not.toContain("stamp withdrawn: 4 stays in context");
            expect(pendingTagIds(db)).toEqual([tags.tagB]);
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("W2 system-origin rows are not revocable", () => {
    it("a queued auto_drop row survives the expand and no withdrawal is claimed", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.tagA, "auto_drop");
            const response = await expand(db, { tag: tags.tagA });
            expect(response).toContain("output A");
            expect(response).not.toContain("stamp withdrawn");
            const ops = getPendingOps(db, SESSION);
            expect(ops).toHaveLength(1);
            expect(ops[0]!.operation).toBe("auto_drop");
        } finally {
            cleanup();
            db.close();
        }
    });

    it("co-queued drop + auto_drop on one tag: only the agent row is deleted", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            queuePendingOp(db, SESSION, tags.tagA, "auto_drop");
            const response = await expand(db, { tag: tags.tagA });
            expect(response).toContain(`stamp withdrawn: ${tags.tagA} stays in context`);
            // Per-slot: one line even though two rows matched the tag.
            expect(response.split("stamp withdrawn").length - 1).toBe(1);
            const ops = getPendingOps(db, SESSION);
            expect(ops).toHaveLength(1);
            expect(ops[0]!.operation).toBe("auto_drop");
        } finally {
            cleanup();
            db.close();
        }
    });

    it("a stamp on a non-active tag is left alone (apply already moved it)", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            updateTagStatus(db, SESSION, tags.tagA, "dropped");
            updateTagDropMode(db, SESSION, tags.tagA, "full");
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            const response = await expand(db, { tag: tags.tagA });
            expect(response).not.toContain("stamp withdrawn");
            expect(pendingTagIds(db)).toEqual([tags.tagA]);
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("Renderer-parity property (D1+D3+D5): withdraw iff the renderer serves", () => {
    /**
     * The whole tag population, every row queued as an agent stamp: for each
     * tag, the withdraw decision must equal resolveTagRender's ok/error — the
     * exact branch renderItemByTag takes. Two-sided: served → row gone + echo;
     * renderer error → row intact + exact error text + no echo.
     */
    it("tag lane: the withdraw decision equals the renderer's ok/error for every tag", async () => {
        const { db, cleanup } = makeFixture();
        try {
            const all = getTagsBySession(db, SESSION);
            expect(all.length).toBe(7);
            for (const tag of all) queuePendingOp(db, SESSION, tag.tagNumber, "drop");
            for (const tag of all) {
                const resolution = resolveTagRender(SESSION, tag);
                const wasPending = pendingTagIds(db).includes(tag.tagNumber);
                expect(wasPending).toBe(true);
                const response = await expand(db, { tag: tag.tagNumber });
                if (resolution.ok) {
                    expect(
                        response.includes(`stamp withdrawn: ${tag.tagNumber} stays in context`),
                        `tag ${tag.tagNumber} serves but did not withdraw`,
                    ).toBe(true);
                    expect(
                        pendingTagIds(db).includes(tag.tagNumber),
                        `tag ${tag.tagNumber} served yet kept its queued stamp`,
                    ).toBe(false);
                } else {
                    expect(response, `tag ${tag.tagNumber}`).toBe(resolution.error);
                    expect(response).not.toContain("stamp withdrawn");
                    expect(
                        pendingTagIds(db).includes(tag.tagNumber),
                        `tag ${tag.tagNumber} refused yet its row was deleted`,
                    ).toBe(true);
                }
            }
        } finally {
            cleanup();
            db.close();
        }
    });

    it("ordinal lane: the withdraw decision equals the renderer's ok/error per address", async () => {
        const { db, cleanup } = makeFixture();
        try {
            const all = getTagsBySession(db, SESSION);
            for (const tag of all) queuePendingOp(db, SESSION, tag.tagNumber, "drop");
            // Served addresses from the shared resolver: which ordinals carry
            // the content of a resolvable, stamped tag.
            const idByOrdinal = new Map(
                fixtureMessages().map((message) => [message.ordinal, message.id]),
            );
            for (const [ordinal, id] of idByOrdinal) {
                const serves = all.some((tag) => {
                    const resolution = resolveTagRender(SESSION, tag);
                    return resolution.ok && resolution.servedMessageIds.has(id);
                });
                const response = await expand(db, { message: ordinal });
                const echoed = response.includes(`stamp withdrawn: ${ordinal} stays in context`);
                expect(echoed, `ordinal ${ordinal}`).toBe(serves);
            }
        } finally {
            cleanup();
            db.close();
        }
    });

    it("law (i): ownerless tool tag refuses in BOTH lanes — renderer text, row intact, no echo", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.orphanA, "drop");
            const refusal = await expand(db, { tag: tags.orphanA });
            expect(refusal).toBe(
                `Tag ${tags.orphanA}'s tool owner is unknown; its original call cannot be resolved safely.`,
            );
            expect(refusal).not.toContain("stamp withdrawn");
            const ranged = await expand(db, { start: 1, end: 4 });
            expect(ranged).not.toContain("stamp withdrawn");
            expect(pendingTagIds(db)).toEqual([tags.orphanA]);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("ghost owner: tool tag whose owner message is gone refuses in both lanes", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.ghostTool, "drop");
            const refusal = await expand(db, { tag: tags.ghostTool });
            expect(refusal).toBe(
                `Tag ${tags.ghostTool}'s original tool owner is no longer in stored history.`,
            );
            expect(refusal).not.toContain("stamp withdrawn");
            const ranged = await expand(db, { start: 1, end: 4 });
            expect(ranged).not.toContain("stamp withdrawn");
            expect(pendingTagIds(db)).toEqual([tags.ghostTool]);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("law (iii): :fileN-style unresolvable locator refuses in both lanes", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.fileTag, "drop");
            const refusal = await expand(db, { tag: tags.fileTag });
            expect(refusal).toBe(
                `Tag ${tags.fileTag}'s original text is no longer in stored history.`,
            );
            expect(refusal).not.toContain("stamp withdrawn");
            // The ordinal 3 lane must not match a tag whose owner lookup fails.
            const ranged = await expand(db, { start: 1, end: 4 });
            expect(ranged).not.toContain("stamp withdrawn: 3 stays in context");
            expect(pendingTagIds(db)).toEqual([tags.fileTag]);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("out-of-range :pN locator: part gone → refusal, row intact, no echo", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.oobTextTag, "drop");
            const refusal = await expand(db, { tag: tags.oobTextTag });
            expect(refusal).toBe(
                `Tag ${tags.oobTextTag}'s original text part is no longer in stored history.`,
            );
            expect(refusal).not.toContain("stamp withdrawn");
            const ranged = await expand(db, { start: 1, end: 4 });
            expect(ranged).not.toContain("stamp withdrawn");
            expect(pendingTagIds(db)).toEqual([tags.oobTextTag]);
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("Split-result sibling coverage (plugin-side mirror of Pi law (ii))", () => {
    // OpenCode-shaped fixtures carry tool output INLINE, so resolveTagRender's
    // sibling walk never fires there. This fixture is Pi-shaped: the
    // invocation and the result are separate raw messages. The sibling-ordinal
    // law is what catches a mutant that hardcodes servedMessageIds to the
    // owner set alone: the walk still renders, but the ordinal lane stops
    // matching the sibling — output served, stamp NOT revoked.
    function makeSplitFixture(): { db: Database; cleanup: () => void; splitTag: number } {
        const db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        const tagger = createTagger();
        const splitTag = tagger.assignToolTag(SESSION, "call-split", "sp-call", 10, db);
        const cleanup = setRawMessageProvider(SESSION, {
            readMessages: () =>
                [
                    {
                        ordinal: 1,
                        id: "sp-user",
                        role: "user",
                        parts: [{ type: "text", text: "before the call" }],
                    },
                    {
                        ordinal: 2,
                        id: "sp-call",
                        role: "assistant",
                        parts: [
                            {
                                type: "tool_use",
                                name: "read",
                                id: "call-split",
                                input: { f: "s.txt" },
                            },
                        ],
                    },
                    {
                        ordinal: 3,
                        id: "sp-result",
                        role: "user",
                        parts: [
                            {
                                type: "tool_result",
                                tool_use_id: "call-split",
                                content: "split output B",
                            },
                        ],
                    },
                ] as never,
        });
        return { db, cleanup, splitTag };
    }

    it("tag mode: the sibling walk serves the result content and the stamp withdraws", async () => {
        const { db, cleanup, splitTag } = makeSplitFixture();
        try {
            queuePendingOp(db, SESSION, splitTag, "drop");
            const response = await expand(db, { tag: splitTag });
            expect(response).toContain("split output B");
            expect(response).toContain(`stamp withdrawn: ${splitTag} stays in context`);
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("sibling ordinal: expand at the RESULT message serves the output AND revokes the stamp", async () => {
        const { db, cleanup, splitTag } = makeSplitFixture();
        try {
            queuePendingOp(db, SESSION, splitTag, "drop");
            const response = await expand(db, { message: 3 });
            expect(response).toContain("split output B");
            expect(response).toContain("stamp withdrawn: 3 stays in context");
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("range across invocation+result withdraws once, keyed on the first visited address", async () => {
        const { db, cleanup, splitTag } = makeSplitFixture();
        try {
            queuePendingOp(db, SESSION, splitTag, "drop");
            const response = await expand(db, { start: 1, end: 3 });
            const echoLines = response
                .split("\n")
                .filter((line) => line.startsWith("stamp withdrawn:"));
            expect(echoLines).toEqual(["stamp withdrawn: 2 stays in context"]);
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("Serve-narrowing asymmetry (intentional): withdrawn is a strict subset of served", () => {
    // The `tag.status === "active"` gate in withdraw.ts narrows below what the
    // renderer serves: renderItemByTag serves any tag whose OWNER resolves,
    // regardless of tag status. Withdrawal additionally requires the row to
    // still be a live model intent (status active) — a tag the system has
    // moved (dropped/compacted) has apply state beyond the queue row and is
    // never revoked, even though the renderer would happily serve it. This
    // asymmetry is a design decision, not an oversight; these rows reddening
    // on a status-keying mutant is the point.
    it("compacted owner message: renderer serves, withdraw refuses, row intact, no echo", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            updateTagStatus(db, SESSION, tags.tagA, "compacted");
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            const resolution = resolveTagRender(
                SESSION,
                getTagById(db, SESSION, tags.tagA) as TagEntry,
            );
            expect(resolution.ok).toBe(true); // the renderer would serve
            const response = await expand(db, { tag: tags.tagA });
            expect(response).toContain("output A"); // and it does
            expect(response).not.toContain("stamp withdrawn"); // but withdraw refuses
            expect(pendingTagIds(db)).toEqual([tags.tagA]);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("dropped (landed) tag: renderer serves, withdraw refuses, row intact, no echo", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            updateTagStatus(db, SESSION, tags.tagA, "dropped");
            updateTagDropMode(db, SESSION, tags.tagA, "full");
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            const resolution = resolveTagRender(
                SESSION,
                getTagById(db, SESSION, tags.tagA) as TagEntry,
            );
            expect(resolution.ok).toBe(true);
            const response = await expand(db, { tag: tags.tagA });
            expect(response).toContain("output A");
            expect(response).not.toContain("stamp withdrawn");
            expect(pendingTagIds(db)).toEqual([tags.tagA]);
            // Same asymmetry in the ordinal lane: the address renders the
            // content but the non-active tag's row survives.
            const ranged = await expand(db, { start: 1, end: 4 });
            expect(ranged).not.toContain("stamp withdrawn");
            expect(pendingTagIds(db)).toEqual([tags.tagA]);
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("W3 post-land path unchanged", () => {
    // Golden of today's recovery, pinned before the feature and re-pinned
    // green after it: the landed tag recovers byte-for-byte as before, with
    // no withdrawal vocabulary in the response.
    it("landed tag: tag-mode recovery is the pinned golden", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            updateTagStatus(db, SESSION, tags.tagA, "dropped");
            updateTagDropMode(db, SESSION, tags.tagA, "full");
            const response = await expand(db, { tag: tags.tagA });
            expect(response).toBe(
                [
                    "  [tool: read #call-a]",
                    '  input: {"filePath":"a.txt"}',
                    "  output:",
                    "output A",
                ].join("\n"),
            );
        } finally {
            cleanup();
            db.close();
        }
    });

    it("landed tag: message-mode recovery is the pinned golden", async () => {
        const { db, cleanup } = makeFixture();
        try {
            const response = await expand(db, { message: 2 });
            expect(response).toBe(
                [
                    "[2] A (assistant) — full recovery:",
                    "",
                    "  [tool: read #call-a]",
                    '  input: {"filePath":"a.txt"}',
                    "  output:",
                    "output A",
                ].join("\n"),
            );
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("W4 per-slot echo and template census", () => {
    it("mixed range: withdrawn slot gets the line, untouched and landed slots do not", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            queuePendingOp(db, SESSION, tags.tagA, "drop");
            // ordinal 3 carries no tag at all; ordinal 4's tag is landed.
            updateTagStatus(db, SESSION, tags.tagB, "dropped");
            updateTagDropMode(db, SESSION, tags.tagB, "full");
            const response = await expand(db, { start: 1, end: 4 });
            const echoLines = response
                .split("\n")
                .filter((line) => line.startsWith("stamp withdrawn:"));
            expect(echoLines).toEqual(["stamp withdrawn: 2 stays in context"]);
        } finally {
            cleanup();
            db.close();
        }
    });

    it("every echo line matches the single canonical template", () => {
        expect(stampWithdrawnLine(137)).toBe("stamp withdrawn: 137 stays in context");
        const template = /^stamp withdrawn: \d+ stays in context$/;
        expect(stampWithdrawnLine(7)).toMatch(template);
    });

    it("census: the template phrase exists exactly once across all production sources, and a planted rogue string reddens the scanner", () => {
        const sources = productionSources(WIDE_CENSUS_ROOTS);
        expect(Object.keys(sources).length).toBeGreaterThan(100);
        const findings = findTemplateViolations(sources);
        expect(findings).toEqual([]);
        // The scanner actually detects a rogue response string.
        const rogue = findTemplateViolations({
            "packages/plugin/src/evil/rogue.ts": 'return "stamp withdrawn: " + n + " vanished";',
        });
        expect(rogue).toEqual(["packages/plugin/src/evil/rogue.ts"]);
    });

    it("census: the tool lane speaks no SQL — queue deletions go through the storage layer's sanctioned helpers", () => {
        const toolLane = [
            ...Object.entries(productionSources(["packages/plugin/src/tools/ctx-expand"])),
            ...Object.entries(
                productionSources(["packages/pi-plugin/src/tools"], (name) =>
                    name.startsWith("ctx-expand"),
                ),
            ),
        ];
        expect(toolLane.length).toBeGreaterThan(2);
        for (const [file, text] of toolLane) {
            expect(text, file).not.toMatch(/(FROM|INTO|UPDATE)\s+pending_ops/);
            expect(text, file).not.toContain("db.prepare");
        }
    });
});

describe("Producer census (D4): the operation vocabulary withdraw's filter relies on", () => {
    const BLESSED: Record<
        string,
        { ops?: string[]; calls?: number; inserts?: number; insertOps?: string[] }
    > = {
        "packages/plugin/src/tools/ctx-reduce/tools.ts": {
            ops: ["drop", "drop"],
            calls: 2,
        },
        // v2 tree: the Pi ctx-reduce lane still carries its seed shape (one
        // queue site); the assembly-era three-site Pi re-implementation is
        // the Unit 7 mirror's subject, not this census's operand.
        "packages/pi-plugin/src/tools/ctx-reduce.ts": {
            ops: ["drop"],
            calls: 1,
        },
        "packages/plugin/src/hooks/magic-context/compartment-runner-drop-queue.ts": {
            ops: ["auto_drop", "auto_drop"],
            calls: 2,
        },
        "packages/plugin/src/features/magic-context/storage-ops.ts": {
            inserts: 1,
            insertOps: [],
        },
        "packages/plugin/src/features/magic-context/storage-clone.ts": {
            inserts: 1,
            insertOps: [],
        },
        "packages/plugin/src/features/magic-context/storage.ts": {},
        "packages/plugin/src/features/magic-context/reduce-resolver.ts": {},
        "packages/plugin/scripts/bench-store-generation-rebase.ts": {
            inserts: 1,
            insertOps: ["drop"],
        },
        "packages/plugin/scripts/self-tag-trial/engine.ts": {
            ops: ["drop"],
            calls: 1,
        },
        "packages/e2e-tests/scripts/ckios-reasoning-only-probe.ts": {
            ops: ["drop"],
            calls: 1,
        },
        "packages/e2e-tests/scripts/pure-replay-differential.ts": {
            ops: ["drop"],
            calls: 1,
        },
        "packages/e2e-tests/src/live-providers/runner.ts": {
            inserts: 1,
            insertOps: ["drop"],
        },
        "packages/e2e-tests/src/repro/reasoning-removal-real-host.ts": {
            inserts: 1,
            insertOps: ["drop"],
        },
    };

    it("every queuePendingOp caller and pending_ops writer is a blessed producer with a vocabulary literal", () => {
        const found = scanQueueProducers(productionSources(PRODUCER_CENSUS_ROOTS));
        const foundFiles = Object.keys(found).sort();
        const blessedFiles = Object.keys(BLESSED).sort();
        expect(foundFiles, "producer file set drifted").toEqual(blessedFiles);
        const allOps: Array<[string, string]> = [];
        for (const [file, report] of Object.entries(found)) {
            const expected = BLESSED[file]!;
            expect(report.ops.sort(), `${file} queuePendingOp literals`).toEqual(
                [...(expected.ops ?? [])].sort(),
            );
            expect(report.calls, `${file} queuePendingOp call sites`).toBe(expected.calls ?? 0);
            expect(report.inserts, `${file} direct INSERTs`).toBe(expected.inserts ?? 0);
            expect(report.insertOps.sort(), `${file} INSERT operation literals`).toEqual(
                [...(expected.insertOps ?? [])].sort(),
            );
            // Every blessed producer inlines its operation string: nothing may
            // hide behind a variable, member, or template at the operation
            // position (that is where a novel op would sneak past closure).
            expect(report.unresolved, `${file} non-literal operation args`).toEqual([]);
            for (const op of [...report.ops, ...report.insertOps]) allOps.push([file, op]);
        }
        // The vocabulary closure: nothing outside the two blessed operations.
        for (const [file, op] of allOps) {
            expect(["drop", "auto_drop"], `${file} wrote novel op "${op}"`).toContain(op);
        }
        // Provenance closure: agent stamps come only from the blessed tool
        // lanes (plus harness fixtures); system rows only from the
        // compartment runner's drop queue. Per-site counts are pinned by the
        // per-file assertions above; here the file SET.
        const dropWriters = [
            ...new Set(allOps.filter(([, op]) => op === "drop").map(([file]) => file)),
        ].sort();
        expect(dropWriters).toEqual(
            [
                "packages/e2e-tests/scripts/ckios-reasoning-only-probe.ts",
                "packages/e2e-tests/scripts/pure-replay-differential.ts",
                "packages/e2e-tests/src/live-providers/runner.ts",
                "packages/e2e-tests/src/repro/reasoning-removal-real-host.ts",
                "packages/pi-plugin/src/tools/ctx-reduce.ts",
                "packages/plugin/scripts/bench-store-generation-rebase.ts",
                "packages/plugin/scripts/self-tag-trial/engine.ts",
                "packages/plugin/src/tools/ctx-reduce/tools.ts",
            ].sort(),
        );
        const autoWriters = [
            ...new Set(allOps.filter(([, op]) => op === "auto_drop").map(([file]) => file)),
        ].sort();
        expect(autoWriters).toEqual([
            "packages/plugin/src/hooks/magic-context/compartment-runner-drop-queue.ts",
        ]);
    });

    it("a planted rogue producer with a novel operation string reddens the scanner", () => {
        const rogue = scanQueueProducers({
            "evil/rogue.ts":
                'queuePendingOp(db, sessionId, 7, "retract");\n' +
                "db.prepare(\"INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, 'retract', 1, 'x')\");",
        });
        expect(rogue["evil/rogue.ts"]!.ops).toEqual(["retract"]);
        expect(rogue["evil/rogue.ts"]!.insertOps).toEqual(["retract"]);
        const violations = validateQueueProducers(rogue, BLESSED);
        expect(violations.length).toBeGreaterThan(0);
    });

    it("a const-bearing producer is LOUD: the scanner reports the unreadable operation position, never silently drops it", () => {
        // Red-first pin for the scanner's literal-only limitation: a producer
        // that templates or const-folds its operation string must redden via
        // the unresolved channel (the vocabulary closure degrades to
        // count-based exactly there, so it may not be silent).
        const constRogue = scanQueueProducers({
            "evil/const-rogue.ts":
                'const STAMP_OP = "drop";\n' +
                "queuePendingOp(db, sessionId, 7, STAMP_OP);\n" +
                "const AUTO = `auto_drop`;\n" +
                'db.prepare("INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, AUTO, 1)");',
        });
        const report = constRogue["evil/const-rogue.ts"]!;
        expect(report.ops).toEqual([]); // the literal channel genuinely sees nothing
        expect(report.insertOps).toEqual([]);
        expect(report.unresolved).toEqual(['operation arg "STAMP_OP"', 'operation value "AUTO"']);
        const violations = validateQueueProducers(constRogue, {
            "evil/const-rogue.ts": { calls: 1, inserts: 1 },
        });
        expect(violations).toEqual([
            'evil/const-rogue.ts: non-literal operation (operation arg "STAMP_OP")',
            'evil/const-rogue.ts: non-literal operation (operation value "AUTO")',
        ]);
        // Control of the control: a blessed-shaped literal call stays silent.
        const clean = scanQueueProducers({
            "evil/clean.ts": 'queuePendingOp(db, sessionId, 7, "drop", 1);',
        });
        expect(clean["evil/clean.ts"]!.unresolved).toEqual([]);
        expect(
            validateQueueProducers(clean, { "evil/clean.ts": { ops: ["drop"], calls: 1 } }),
        ).toEqual([]);
    });
});

describe("D6: the chunk-empty branch speaks the effective end", () => {
    it("a clamped range reports the clamped end in the empty-chunk message", async () => {
        const { db, cleanup } = makeFixture();
        try {
            replaceAllCompartments(db, SESSION, [
                {
                    sequence: 1,
                    startMessage: 1,
                    endMessage: 5,
                    startMessageId: "one",
                    endMessageId: "five",
                    title: "Early work",
                    content: "Summary",
                },
            ]);
            const response = await expand(db, { start: 5, end: 7 });
            expect(response).toBe(
                "No messages found in range 5-5. The range may be outside this session's history.",
            );
        } finally {
            cleanup();
            db.close();
        }
    });
});

describe("W5 zero served bytes: the wire is byte-identical across the withdraw", () => {
    it("defer passes replay the same wire with the stamp queued and after withdrawal", async () => {
        const temp = createTestTempDir("ctx-expand-withdraw-wire-", "");
        const previousData = process.env.XDG_DATA_HOME;
        const previousCache = process.env.XDG_CACHE_HOME;
        process.env.XDG_DATA_HOME = temp.dir;
        process.env.XDG_CACHE_HOME = temp.dir;
        try {
            const db = new Database(join(temp.dir, "context.db")) as Database;
            initializeDatabase(db);
            runMigrations(db);
            const wireMessages = () =>
                [
                    {
                        info: { id: "one", role: "user", sessionID: SESSION },
                        parts: [{ type: "text", text: "original text" }],
                    },
                    {
                        info: { id: "two", role: "assistant", sessionID: SESSION },
                        parts: [toolPart("call-a", "output A", { filePath: "a.txt" })],
                    },
                    {
                        info: { id: "three", role: "user", sessionID: SESSION },
                        parts: [{ type: "text", text: "middle text" }],
                    },
                ] as never[];
            const cleanup = setRawMessageProvider(SESSION, {
                readMessages: () => fixtureMessages() as never,
            });
            const decision: "execute" | "defer" = "defer";
            const transform = createTransform({
                tagger: createTagger(),
                scheduler: { shouldExecute: () => decision },
                contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                    [
                        SESSION,
                        {
                            usage: { percentage: 30, inputTokens: 60_000 },
                            updatedAt: Date.now(),
                        },
                    ],
                ]),
                db: db as unknown as ContextDatabase,
                historyRefreshSessions: new Set(),
                deferredHistoryRefreshSessions: new Set(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                clearReasoningAge: 1000,
                protectedTokens: 0,
                historianRunnable: false,
                liveModelBySession: new Map([
                    [SESSION, { providerID: "anthropic", modelID: "claude-opus-4-1" }],
                ]),
            });
            const run = async () => {
                const output = { messages: structuredClone(wireMessages()) };
                await transform({}, output);
                return JSON.stringify(output.messages);
            };
            await run(); // seed pass: the tagger registers the tool tag
            const toolTagNumber = getTagNumberByMessageId(db, SESSION, "call-a");
            expect(toolTagNumber).not.toBeNull();
            queuePendingOp(db, SESSION, toolTagNumber!, "drop");
            const withStamp = await run();
            const withdrawn = await expand(db, { message: 2 });
            expect(withdrawn).toContain("stamp withdrawn: 2 stays in context");
            expect(getPendingOps(db, SESSION)).toHaveLength(0);
            const afterWithdraw = await run();
            expect(afterWithdraw).toBe(withStamp);
            expect(afterWithdraw).toContain("output A");
            cleanup();
            db.close();
        } finally {
            if (previousData === undefined) delete process.env.XDG_DATA_HOME;
            else process.env.XDG_DATA_HOME = previousData;
            if (previousCache === undefined) delete process.env.XDG_CACHE_HOME;
            else process.env.XDG_CACHE_HOME = previousCache;
            temp.cleanup();
        }
    }, 30_000);
});

describe("W6 withdraw-then-restamp is a plain new stamp", () => {
    it("reduce, expand-withdraw, reduce again: one fresh row, no residue", async () => {
        const { db, cleanup, tags } = makeFixture();
        try {
            const reduce = createCtxReduceTools({ db, protectedSet: new Set() }).ctx_reduce;
            const ctx = { sessionID: SESSION, directory: process.cwd() } as never;
            await reduce.execute({ drop: String(tags.tagA) }, ctx);
            const firstRows = getPendingOps(db, SESSION);
            expect(firstRows).toHaveLength(1);
            expect(firstRows[0]!.tagId).toBe(tags.tagA);
            expect(firstRows[0]!.operation).toBe("drop");

            await expand(db, { tag: tags.tagA });
            expect(getPendingOps(db, SESSION)).toHaveLength(0);

            await reduce.execute({ drop: String(tags.tagA) }, ctx);
            const second = getPendingOps(db, SESSION);
            expect(second).toHaveLength(1);
            expect(second[0]!.tagId).toBe(tags.tagA);
            expect(second[0]!.operation).toBe("drop");
            expect(second[0]!.id).toBeGreaterThan(firstRows[0]!.id);
            const tag = getTagById(db, SESSION, tags.tagA) as TagEntry;
            expect(tag.status).toBe("active");
        } finally {
            cleanup();
            db.close();
        }
    });
});

const REPO_ROOT = join(import.meta.dir, "../../../../../");

const CENSUS_DENY = new Set([".git", "node_modules", "dist", ".codegraph", "target"]);
const CENSUS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs"];

const WIDE_CENSUS_ROOTS = ["packages/plugin/src", "packages/pi-plugin/src"];
const PRODUCER_CENSUS_ROOTS = ["packages", "crates", "scripts"];

function productionSources(
    roots: readonly string[],
    fileFilter?: (name: string) => boolean,
): Record<string, string> {
    const sources: Record<string, string> = {};
    const walk = (relative: string): void => {
        let entries: string[];
        try {
            entries = readdirSync(join(REPO_ROOT, relative));
        } catch {
            return;
        }
        for (const name of entries) {
            if (CENSUS_DENY.has(name)) continue;
            const path = relative ? `${relative}/${name}` : name;
            if (statSync(join(REPO_ROOT, path)).isDirectory()) {
                walk(path);
                continue;
            }
            if (!CENSUS_EXTENSIONS.some((ext) => name.endsWith(ext))) continue;
            if (name.endsWith(".test.ts")) continue;
            if (fileFilter && !fileFilter(name)) continue;
            sources[path] = readFileSync(join(REPO_ROOT, path), "utf8");
        }
    };
    for (const root of roots) walk(root);
    return sources;
}

const TEMPLATE_OWNER = "packages/plugin/src/tools/ctx-expand/constants.ts";

function findTemplateViolations(sources: Record<string, string>): string[] {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
        const occurrences = text.split("stamp withdrawn:").length - 1;
        if (occurrences > 1) offenders.push(file);
        else if (occurrences === 1 && file !== TEMPLATE_OWNER) offenders.push(file);
    }
    return offenders.sort();
}

interface ProducerReport {
    ops: string[];
    calls: number;
    inserts: number;
    insertOps: string[];
    /**
     * Operation arguments the scanner could not read as a plain quoted
     * literal (identifier, member expression, template, etc.). Vocabulary
     * closure is only honest while every producer inlines its operation
     * string; a non-literal arg is LOUD here (the law asserts this array is
     * empty for every blessed file) instead of silently dropping the site
     * from the op set. Placeholders (?) are exempt: they carry no literal at
     * the write site by design (storage-ops parameterizes; the callers of
     * that function are themselves scanned).
     */
    unresolved: string[];
}

/** Balanced-paren span starting at the open paren index; -1 if unbalanced. */
function spanEnd(text: string, openIndex: number): number {
    let depth = 0;
    for (let i = openIndex; i < text.length; i++) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") {
            depth--;
            if (depth === 0) return i;
        }
    }
    return -1;
}

function splitArguments(span: string): string[] {
    let depth = 0;
    let current = "";
    const args: string[] = [];
    for (const ch of span) {
        if (ch === "(" || ch === "[") depth++;
        else if (ch === ")" || ch === "]") depth--;
        if (ch === "," && depth === 0) {
            args.push(current);
            current = "";
        } else current += ch;
    }
    args.push(current);
    return args;
}

const QUOTED_LITERAL = /^[`"']([a-zA-Z_]+)[`"']$/;

function literalOp(arg: string | undefined): string | null {
    const literal = arg ? QUOTED_LITERAL.exec(arg.trim()) : null;
    return literal?.[1] ?? null;
}

/**
 * Extract operation literals from a call's argument list. `columnList` mode
 * (INSERT ... VALUES) reads the value at the "operation" column position;
 * call mode reads the operation position (index 3). Anything at the
 * operation position that is neither a quoted literal nor a `?` placeholder
 * is reported as unresolved.
 */
function operationArguments(
    span: string,
    columnList: string | undefined,
): { ops: string[]; unresolved: string[] } {
    const args = splitArguments(span);
    const ops: string[] = [];
    const unresolved: string[] = [];
    if (columnList) {
        const columns = columnList.split(",").map((column) => column.trim().toLowerCase());
        const position = columns.indexOf("operation");
        if (position >= 0 && position < args.length) {
            const arg = args[position]!.trim();
            const literal = literalOp(arg);
            if (literal) ops.push(literal);
            else if (arg !== "" && arg !== "?") unresolved.push(`operation value "${arg}"`);
        }
        return { ops, unresolved };
    }
    if (args.length < 4) {
        unresolved.push(`call has ${args.length} args (< 4, operation position unreadable)`);
        return { ops, unresolved };
    }
    const arg = args[3]!.trim();
    const literal = literalOp(arg);
    if (literal) ops.push(literal);
    else if (arg !== "" && arg !== "?") unresolved.push(`operation arg "${arg}"`);
    return { ops, unresolved };
}

function scanQueueProducers(sources: Record<string, string>): Record<string, ProducerReport> {
    const reports: Record<string, ProducerReport> = {};
    for (const [file, text] of Object.entries(sources)) {
        const ops: string[] = [];
        let calls = 0;
        let inserts = 0;
        const insertOps: string[] = [];
        const unresolved: string[] = [];
        const callPattern = /queuePendingOp\s*\(/g;
        for (let match = callPattern.exec(text); match; match = callPattern.exec(text)) {
            const before = text.slice(0, match.index).trimEnd();
            if (before.endsWith("function")) continue; // the storage-layer definition
            const open = text.indexOf("(", match.index);
            const end = spanEnd(text, open);
            if (end < 0) continue;
            calls++;
            const parsed = operationArguments(text.slice(open + 1, end), undefined);
            ops.push(...parsed.ops);
            unresolved.push(...parsed.unresolved);
        }
        const insertPattern = /INSERT\s+INTO\s+pending_ops\s*\(([^)]*)\)\s*VALUES\s*\(/gi;
        for (let match = insertPattern.exec(text); match; match = insertPattern.exec(text)) {
            inserts++;
            const open = match.index + match[0].length - 1;
            const end = spanEnd(text, open);
            if (end < 0) continue;
            const parsed = operationArguments(text.slice(open + 1, end), match[1]);
            insertOps.push(...parsed.ops);
            unresolved.push(...parsed.unresolved);
        }
        if (calls > 0 || inserts > 0 || /queuePendingOp\b/.test(text)) {
            reports[file] = { ops, calls, inserts, insertOps, unresolved };
        }
    }
    return reports;
}

function validateQueueProducers(
    found: Record<string, ProducerReport>,
    blessed: Record<
        string,
        { ops?: string[]; calls?: number; inserts?: number; insertOps?: string[] }
    >,
): string[] {
    const violations: string[] = [];
    for (const [file, report] of Object.entries(found)) {
        const expected = blessed[file];
        if (!expected) {
            violations.push(`${file}: unblessed queue producer`);
            continue;
        }
        if (report.ops.some((op) => op !== "drop" && op !== "auto_drop")) {
            violations.push(`${file}: novel queuePendingOp operation literal`);
        }
        if (report.insertOps.some((op) => op !== "drop" && op !== "auto_drop")) {
            violations.push(`${file}: novel INSERT operation literal`);
        }
        for (const entry of report.unresolved) {
            violations.push(`${file}: non-literal operation (${entry})`);
        }
    }
    return violations;
}
