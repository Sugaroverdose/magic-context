/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    makeWholeMessageSentinel,
    modelAcceptsEmptyContent,
    routeAcceptsEmptyDroppedContent,
    routeAcceptsEmptyDroppedMessage,
    TOOL_RELEASED_SENTINEL,
    WHOLE_MESSAGE_PLACEHOLDER_TEXT,
} from "./sentinel";

// Unit 5 (coordinator dispatch rulings 2+4): the release-path vocabulary —
// the empty tool-result slot and the route gates that decide when a dropped
// message may be served as "". The canonical [dropped §N§] string (ARCHITECTURE
// invariant 2) is untouched by this file: no law here mints or replaces a
// placeholder STRING; the empty shape is an absence, and the bracketed
// shapes are the pre-existing sentinel pair.

describe("TOOL_RELEASED_SENTINEL (released tool-result slot)", () => {
    it("is the empty string — the slot carries no imitable bytes", () => {
        expect(TOOL_RELEASED_SENTINEL).toBe("");
    });

    it("is distinct from the whole-message placeholder pair", () => {
        expect(TOOL_RELEASED_SENTINEL).not.toBe(WHOLE_MESSAGE_PLACEHOLDER_TEXT);
    });
});

describe("routeAcceptsEmptyDroppedContent (Unit 5 station widening)", () => {
    it("accepts anthropic and station", () => {
        expect(routeAcceptsEmptyDroppedContent("anthropic")).toBe(true);
        expect(routeAcceptsEmptyDroppedContent("station")).toBe(true);
    });

    it("rejects strict validators and unknown providers", () => {
        expect(routeAcceptsEmptyDroppedContent("openai")).toBe(false);
        expect(routeAcceptsEmptyDroppedContent("moonshot")).toBe(false);
        expect(routeAcceptsEmptyDroppedContent(undefined)).toBe(false);
    });

    it("is strictly wider than modelAcceptsEmptyContent", () => {
        for (const provider of ["anthropic", "station", "openai", undefined]) {
            if (modelAcceptsEmptyContent(provider)) {
                expect(routeAcceptsEmptyDroppedContent(provider)).toBe(true);
            }
        }
        // The widening is exactly station: no other known provider crosses.
        expect(routeAcceptsEmptyDroppedContent("station")).toBe(true);
        expect(modelAcceptsEmptyContent("station")).toBe(false);
    });
});

describe("routeAcceptsEmptyDroppedMessage (role-aware anchor guard)", () => {
    it("anthropic may only empty assistant rows (adapter filters would erase the anchor)", () => {
        expect(routeAcceptsEmptyDroppedMessage("anthropic", "assistant")).toBe(true);
        expect(routeAcceptsEmptyDroppedMessage("anthropic", "user")).toBe(false);
    });

    it("station transmits bytes as given — every role is safe (HTTP-200 probed 2026-10-31)", () => {
        expect(routeAcceptsEmptyDroppedMessage("station", "assistant")).toBe(true);
        expect(routeAcceptsEmptyDroppedMessage("station", "user")).toBe(true);
    });

    it("strict validators reject every role", () => {
        expect(routeAcceptsEmptyDroppedMessage("moonshot", "assistant")).toBe(false);
        expect(routeAcceptsEmptyDroppedMessage(undefined, "assistant")).toBe(false);
    });
});

describe("makeWholeMessageSentinel gate (reconciled with the Unit 4 recognizer)", () => {
    it("mints the empty text on empty-accepting routes", () => {
        expect(makeWholeMessageSentinel("anthropic").text).toBe("");
        expect(makeWholeMessageSentinel("station").text).toBe("");
    });

    it("mints the bracketed filler on strict routes", () => {
        expect(makeWholeMessageSentinel("openai").text).toBe(WHOLE_MESSAGE_PLACEHOLDER_TEXT);
        expect(makeWholeMessageSentinel(undefined).text).toBe(WHOLE_MESSAGE_PLACEHOLDER_TEXT);
    });
});
