import { describe, expect, test } from "bun:test";
import type { Compartment } from "../../features/magic-context/compartment-storage";
import { parseRecompArgs } from "./command-handler";
import { snapRangeToCompartments } from "./compartment-runner-partial-recomp";

// Helper: build a minimal Compartment stub for tests.
function compartment(sequence: number, start: number, end: number): Compartment {
    return {
        id: sequence,
        sessionId: "ses-test",
        sequence,
        startMessage: start,
        endMessage: end,
        startMessageId: `msg-${start}`,
        endMessageId: `msg-${end}`,
        title: `compartment ${sequence}`,
        content: `content ${sequence}`,
        createdAt: 0,
    };
}

describe("parseRecompArgs", () => {
    test("empty input returns full recomp", () => {
        expect(parseRecompArgs("")).toEqual({ kind: "full" });
        expect(parseRecompArgs("   ")).toEqual({ kind: "full" });
        expect(parseRecompArgs("\t\n")).toEqual({ kind: "full" });
    });

    test("valid range returns partial with parsed bounds", () => {
        const result = parseRecompArgs("1-11322");
        expect(result).toEqual({
            kind: "partial",
            range: { start: 1, end: 11322 },
        });
    });

    test("valid range with whitespace", () => {
        expect(parseRecompArgs("500 - 1000")).toEqual({
            kind: "partial",
            range: { start: 500, end: 1000 },
        });
        expect(parseRecompArgs("  1-2  ")).toEqual({
            kind: "partial",
            range: { start: 1, end: 2 },
        });
    });

    test("equal start and end is valid (single-message range)", () => {
        expect(parseRecompArgs("42-42")).toEqual({
            kind: "partial",
            range: { start: 42, end: 42 },
        });
    });

    test("malformed inputs return error", () => {
        expect(parseRecompArgs("abc")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1-")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("-10")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1-2-3")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("1 2")).toMatchObject({ kind: "error" });
    });

    test("start < 1 returns error", () => {
        expect(parseRecompArgs("0-10")).toMatchObject({ kind: "error" });
    });

    test("end < start returns error", () => {
        expect(parseRecompArgs("10-5")).toMatchObject({ kind: "error" });
        expect(parseRecompArgs("100-99")).toMatchObject({ kind: "error" });
    });
});

describe("snapRangeToCompartments", () => {
    const threeCompartments: Compartment[] = [
        compartment(1, 1, 100),
        compartment(2, 101, 500),
        compartment(3, 501, 1000),
    ];

    test("empty compartments returns error", () => {
        const result = snapRangeToCompartments([], { start: 1, end: 10 });
        expect(result).toMatchObject({ error: expect.stringContaining("No compartments") });
    });

    test("range start < 1 returns error", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 0, end: 50 });
        expect(result).toMatchObject({ error: expect.stringContaining("Start must be >= 1") });
    });

    test("end < start returns error", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 50, end: 10 });
        expect(result).toMatchObject({ error: expect.stringContaining("End must be >= start") });
    });

    test("range entirely after last compartment returns error", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 1500, end: 2000 });
        expect(result).toMatchObject({
            error: expect.stringContaining("starts after the last compartment"),
        });
    });

    test("range exactly matches one compartment boundary", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 1, end: 100 });
        expect(result).toMatchObject({
            snapStart: 1,
            snapEnd: 100,
        });
        if ("priorCompartments" in result) {
            expect(result.priorCompartments).toHaveLength(0);
            expect(result.rangeCompartments).toHaveLength(1);
            expect(result.rangeCompartments[0].sequence).toBe(1);
            expect(result.tailCompartments).toHaveLength(2);
        }
    });

    test("range within single compartment snaps to that compartment's full bounds", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 50, end: 75 });
        expect(result).toMatchObject({
            snapStart: 1,
            snapEnd: 100,
        });
        if ("rangeCompartments" in result) {
            expect(result.rangeCompartments).toHaveLength(1);
            expect(result.priorCompartments).toHaveLength(0);
            expect(result.tailCompartments).toHaveLength(2);
        }
    });

    test("range spans multiple compartments snaps outward", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 50, end: 600 });
        expect(result).toMatchObject({
            snapStart: 1, // expanded out to compartment 1's start
            snapEnd: 1000, // expanded out to compartment 3's end (since 600 falls within compartment 3)
        });
        if ("rangeCompartments" in result) {
            expect(result.rangeCompartments).toHaveLength(3);
            expect(result.priorCompartments).toHaveLength(0);
            expect(result.tailCompartments).toHaveLength(0);
        }
    });

    test("range fully inside middle compartment", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 200, end: 400 });
        expect(result).toMatchObject({
            snapStart: 101,
            snapEnd: 500,
        });
        if ("rangeCompartments" in result) {
            expect(result.rangeCompartments).toHaveLength(1);
            expect(result.rangeCompartments[0].sequence).toBe(2);
            expect(result.priorCompartments).toHaveLength(1);
            expect(result.tailCompartments).toHaveLength(1);
        }
    });

    test("range spans compartment boundary (e.g. 80-150)", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 80, end: 150 });
        expect(result).toMatchObject({
            snapStart: 1, // compartment 1 contains message 80
            snapEnd: 500, // compartment 2 contains message 150
        });
        if ("rangeCompartments" in result) {
            expect(result.rangeCompartments).toHaveLength(2);
            expect(result.priorCompartments).toHaveLength(0);
            expect(result.tailCompartments).toHaveLength(1);
        }
    });

    test("out-of-order input is still handled (sort by sequence)", () => {
        const shuffled = [threeCompartments[2], threeCompartments[0], threeCompartments[1]];
        const result = snapRangeToCompartments(shuffled, { start: 200, end: 400 });
        expect(result).toMatchObject({
            snapStart: 101,
            snapEnd: 500,
        });
    });

    test("range touches the very last compartment's end exactly", () => {
        const result = snapRangeToCompartments(threeCompartments, { start: 900, end: 1000 });
        expect(result).toMatchObject({
            snapStart: 501,
            snapEnd: 1000,
        });
        if ("priorCompartments" in result) {
            expect(result.priorCompartments).toHaveLength(2);
            expect(result.tailCompartments).toHaveLength(0);
        }
    });
});
