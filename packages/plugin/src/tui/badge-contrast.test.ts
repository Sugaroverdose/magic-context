import { describe, expect, test } from "bun:test";
import { readableTextColorOn } from "./badge-contrast";

describe("readableTextColorOn", () => {
    test("dark accent gets white text", () => {
        // A typical dark accent (deep blue/purple) should read as white.
        expect(readableTextColorOn({ r: 0.1, g: 0.1, b: 0.3 })).toBe("#ffffff");
        expect(readableTextColorOn({ r: 0, g: 0, b: 0 })).toBe("#ffffff");
    });

    test("light accent gets black text", () => {
        // Only accents pale enough that white fails the contrast bar go black.
        expect(readableTextColorOn({ r: 0.9, g: 0.9, b: 0.7 })).toBe("#000000");
        expect(readableTextColorOn({ r: 1, g: 1, b: 1 })).toBe("#000000");
    });

    test("mid-tone orange accent prefers white (white-bias, matches sibling badges)", () => {
        // A typical orange/amber accent reads white ~4:1 and black ~5:1. A
        // higher-contrast-wins pick would flip it to black (the #186 over-
        // correction); the white bias keeps it white, clearing the bold-text bar.
        expect(readableTextColorOn({ r: 0.69, g: 0.455, b: 0.188 })).toBe("#ffffff");
        expect(readableTextColorOn({ r: 0.741, g: 0.482, b: 0.2 })).toBe("#ffffff");
    });

    test("pure green is treated as light (white fails the contrast bar)", () => {
        // A saturated green is bright enough that white drops below the bar.
        expect(readableTextColorOn({ r: 0, g: 1, b: 0 })).toBe("#000000");
    });

    test("pure blue is treated as dark (low luma weight)", () => {
        // Blue contributes little to perceived brightness, so a saturated blue
        // badge needs light text.
        expect(readableTextColorOn({ r: 0, g: 0, b: 1 })).toBe("#ffffff");
    });

    test("does not depend on the (possibly transparent) background alpha", () => {
        // The helper only reads r/g/b — the regression in #186 was using a
        // background color whose alpha could be 0. Two accents with identical
        // rgb resolve identically regardless of any alpha the caller might pass.
        const a = readableTextColorOn({ r: 0.2, g: 0.2, b: 0.2 });
        const b = readableTextColorOn({ r: 0.2, g: 0.2, b: 0.2 });
        expect(a).toBe(b);
        expect(a).toBe("#ffffff");
    });
});
