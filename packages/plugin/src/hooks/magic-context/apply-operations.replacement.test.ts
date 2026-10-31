/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildReplacementContent } from "./apply-operations";
import { MESSAGE_DROP_PLACEHOLDER, WHOLE_MESSAGE_PLACEHOLDER_TEXT } from "./sentinel";
import { isMarkerOnlyText } from "./strip-content";

describe("buildReplacementContent — one canonical placeholder", () => {
    // The whole point: buildReplacementContent returns the SAME constant bytes
    // for EVERY message (non-tool) drop, on every path, every pass — it reads
    // no tag number, role, content, or window state. Any version that varied
    // the bytes by role/content/window (e.g. a `[truncated §N§]` user-text
    // preview) re-derived a DIFFERENT placeholder across passes, which on a
    // defer pass changed a tail message's bytes and busted the whole
    // prompt-cache prefix after it. These tests lock the byte-identity that
    // makes that class impossible. On this branch the message placeholder is
    // a distinct constant from the tool-result slot: the slot is empty
    // (TOOL_RELEASED_SENTINEL === "" — an imitable constant there leaked into
    // model output as a habit), while message text cannot be emptied on
    // non-Anthropic routes, so it keeps an identifier-free bracketed filler.

    it("is a constant — no tagId, target, or content dependency", () => {
        expect(buildReplacementContent(42)).toBe(MESSAGE_DROP_PLACEHOLDER);
        expect(buildReplacementContent(100413)).toBe(MESSAGE_DROP_PLACEHOLDER);
        expect(buildReplacementContent(7)).toBe(buildReplacementContent(42));
    });

    it("is byte-identical to heuristic-cleanup's message placeholder", () => {
        // heuristic-cleanup.ts calls buildReplacementContent — the two drop
        // paths cannot disagree by construction.
        expect(buildReplacementContent(591)).toBe(MESSAGE_DROP_PLACEHOLDER);
    });

    it("is deterministic across repeated calls (defer-replay stability)", () => {
        const a = buildReplacementContent(592);
        const b = buildReplacementContent(592);
        const c = buildReplacementContent(592);
        expect(a).toBe(b);
        expect(b).toBe(c);
    });

    it("is marker-only text so a fully-dropped non-user message can be sentinelized", () => {
        // stripDroppedPlaceholderMessages neutralizes messages whose every
        // content part is marker-only text (role guard spares user messages).
        expect(isMarkerOnlyText(buildReplacementContent(11))).toBe(true);
    });

    it("stays distinct from the post-neutralization sentinel", () => {
        // If the placeholder equaled WHOLE_MESSAGE_PLACEHOLDER_TEXT, isSentinel
        // would pre-skip dropped messages out of the persisted neutralization
        // set, and hidden-seam removal would diverge across providers.
        expect(buildReplacementContent(11)).not.toBe(WHOLE_MESSAGE_PLACEHOLDER_TEXT);
    });
});

describe("buildReplacementContent — R11 route-gated empty shape, frozen per tag", () => {
    // The bracketed fillers are the R9 imitation class: the census found
    // assistant prose copying "[content omitted]" / "[dropped]" off wire
    // exemplars. Routes measured to accept empty content (anthropic's AI-SDK
    // normalization filters empty text; station returned HTTP 200 for empty
    // user AND empty assistant content, probed 2026-10-31) get the empty
    // shape; strict routes (Kimi `must not be empty`) keep the filler. The
    // chosen shape is FROZEN on the tag at apply time — a later route change
    // must not rewrite bytes that were already served.

    it("empties dropped message text on routes measured to accept empty content", () => {
        expect(buildReplacementContent(42, undefined, "station")).toBe("");
        expect(buildReplacementContent(42, undefined, "anthropic")).toBe("");
    });

    it("keeps the bracketed filler on strict and unknown routes", () => {
        expect(buildReplacementContent(42, undefined, "kimi")).toBe(MESSAGE_DROP_PLACEHOLDER);
        expect(buildReplacementContent(42, undefined, undefined)).toBe(MESSAGE_DROP_PLACEHOLDER);
    });

    it("does not empty a USER-role drop on the filtering adapter", () => {
        // Anthropic's AI-SDK filters empty text parts off the wire entirely:
        // an emptied user message vanishes and its turn anchor with it —
        // the same hazard stripDroppedPlaceholderMessages guards against by
        // never neutralizing user rows. Station passes bytes through
        // (HTTP 200 probed for empty user content), so only assistant-role
        // rows may be emptied on anthropic.
        expect(buildReplacementContent(42, undefined, "anthropic", "user")).toBe(
            MESSAGE_DROP_PLACEHOLDER,
        );
        expect(buildReplacementContent(42, undefined, "anthropic", "assistant")).toBe("");
        expect(buildReplacementContent(42, undefined, "station", "user")).toBe("");
    });

    it("replays the frozen shape regardless of the current route", () => {
        // A tag frozen empty when created serves "" even after a switch onto
        // a strict route; a tag frozen filler serves the filler even after a
        // switch onto an empty-accepting route. Replay never re-decides.
        expect(buildReplacementContent(42, "message_empty", "kimi")).toBe("");
        expect(buildReplacementContent(42, "message_filler", "station")).toBe(
            MESSAGE_DROP_PLACEHOLDER,
        );
    });

    it("legacy pre-R11 rows replay the filler (byte-stable for already-served drops)", () => {
        // Rows persisted before the freeze existed carry the schema default
        // or any tool-side mode; the message branch keeps their bytes.
        expect(buildReplacementContent(42, "full", "station")).toBe(MESSAGE_DROP_PLACEHOLDER);
        expect(buildReplacementContent(42, "erased", "station")).toBe(MESSAGE_DROP_PLACEHOLDER);
    });
});

// ── R11 integration: the shape is decided once at apply and replayed frozen ──
import {
    afterEach,
    beforeEach,
    describe as describe2,
    expect as expect2,
    it as it2,
} from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getTagsBySession,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import type { TagEntry } from "../../features/magic-context/types";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { applyFlushedStatuses, applyPendingOperations } from "./apply-operations";
import type { TagTarget } from "./tag-messages";

describe2("message drop shape freeze (R11)", () => {
    const session = "r11-freeze";
    let db: NonNullable<ReturnType<typeof openDatabase>>;
    let root: string;
    let originalData: string | undefined;
    let originalStorage: string | undefined;

    beforeEach(() => {
        originalData = process.env.XDG_DATA_HOME;
        originalStorage = process.env.MAGIC_CONTEXT_STORAGE_DIR;
        root = createTestTempDirFromPath(join(tmpdir(), "r11-freeze-"));
        process.env.XDG_DATA_HOME = root;
        process.env.MAGIC_CONTEXT_STORAGE_DIR = root;
        db = openDatabase()!;
    });
    afterEach(() => {
        closeDatabase();
        if (originalData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalData;
        if (originalStorage === undefined) delete process.env.MAGIC_CONTEXT_STORAGE_DIR;
        else process.env.MAGIC_CONTEXT_STORAGE_DIR = originalStorage;
        rmSync(root, { recursive: true, force: true });
    });

    function messageTarget(tagNumber: number, captured: { content?: string }) {
        const target: TagTarget = {
            getContent: () => "the original user prose that was dropped",
            setContent: (content: string) => {
                captured.content = content;
                return true;
            },
        };
        return new Map<number, TagTarget>([[tagNumber, target]]);
    }

    function seedMessageTag(tagNumber: number) {
        insertTag(db, session, `msg-${tagNumber}`, "message", 36, tagNumber);
        queuePendingOp(db, session, tagNumber, "drop");
    }

    it2("a new drop on an empty-accepting route serves empty bytes and freezes the shape", () => {
        seedMessageTag(1);
        const captured: { content?: string } = {};
        const mutated = applyPendingOperations(
            session,
            db,
            messageTarget(1, captured),
            new Set(),
            undefined,
            undefined,
            [],
            new Set(),
            undefined,
            undefined,
            "station",
        );
        expect2(mutated).toBe(true);
        expect2(captured.content).toBe("");
        const row = getTagsBySession(db, session).find((t) => t.tagNumber === 1) as TagEntry;
        expect2(row.status).toBe("dropped");
        expect2(row.dropMode).toBe("message_empty");
    });

    it2("a new drop on a strict route serves the filler and freezes THAT shape", () => {
        seedMessageTag(2);
        const captured: { content?: string } = {};
        applyPendingOperations(
            session,
            db,
            messageTarget(2, captured),
            new Set(),
            undefined,
            undefined,
            [],
            new Set(),
            undefined,
            undefined,
            "kimi",
        );
        expect2(captured.content).toBe(MESSAGE_DROP_PLACEHOLDER);
        const row = getTagsBySession(db, session).find((t) => t.tagNumber === 2) as TagEntry;
        expect2(row.dropMode).toBe("message_filler");
    });

    it2(
        "replay serves the frozen bytes on a different route than the one that decided them",
        () => {
            // Frozen empty at apply on station; replayed on a strict route.
            seedMessageTag(3);
            applyPendingOperations(
                session,
                db,
                messageTarget(3, {}),
                new Set(),
                undefined,
                undefined,
                [],
                new Set(),
                undefined,
                undefined,
                "station",
            );
            const replayed: { content?: string } = {};
            const didMutate = applyFlushedStatuses(
                session,
                db,
                messageTarget(3, replayed),
                getTagsBySession(db, session),
            );
            expect2(didMutate).toBe(true);
            expect2(replayed.content).toBe("");
        },
    );

    it2("legacy rows without a frozen shape keep replaying the filler", () => {
        // Pre-R11 byte-stability: a dropped message tag whose drop_mode is the
        // schema default must render exactly what the old build rendered.
        insertTag(db, session, "msg-4", "message", 36, 4);
        const legacyRow = getTagsBySession(db, session).find((t) => t.tagNumber === 4);
        expect2(legacyRow?.dropMode).toBe("full");
        const replayed: { content?: string } = {};
        applyFlushedStatuses(session, db, messageTarget(4, replayed), [
            { ...(legacyRow as TagEntry), status: "dropped" },
        ]);
        expect2(replayed.content).toBe(MESSAGE_DROP_PLACEHOLDER);
    });
});
