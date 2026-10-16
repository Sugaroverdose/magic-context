/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { buildReplacementContent } from "./apply-operations";
import { isMarkerOnlyText } from "./strip-content";
import { TOOL_RELEASED_SENTINEL, WHOLE_MESSAGE_PLACEHOLDER_TEXT } from "./sentinel";

describe("buildReplacementContent — one canonical placeholder", () => {
    // The whole point: buildReplacementContent returns the SAME constant bytes
    // for EVERY message (non-tool) drop, on every path, every pass — it reads
    // no tag number, role, content, or window state. Any version that varied
    // the bytes by role/content/window (e.g. a `[truncated §N§]` user-text
    // preview) re-derived a DIFFERENT placeholder across passes, which on a
    // defer pass changed a tail message's bytes and busted the whole
    // prompt-cache prefix after it. These tests lock the byte-identity that
    // makes that class impossible. On this branch the bytes are also the
    // identifier-free `...` filler: the released-tag numeral pattern must not
    // be a permanently resident string in the transcript.

    it("is a constant — no tagId, target, or content dependency", () => {
        expect(buildReplacementContent(42)).toBe(TOOL_RELEASED_SENTINEL);
        expect(buildReplacementContent(100413)).toBe(TOOL_RELEASED_SENTINEL);
        expect(buildReplacementContent(7)).toBe(buildReplacementContent(42));
    });

    it("is byte-identical to heuristic-cleanup's message placeholder", () => {
        // heuristic-cleanup.ts calls buildReplacementContent — the two drop
        // paths cannot disagree by construction.
        expect(buildReplacementContent(591)).toBe(TOOL_RELEASED_SENTINEL);
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
