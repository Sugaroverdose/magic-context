/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    detectFrictionSignals,
    detectFrustrationMarkers,
    detectRepeatedToolCalls,
    detectRepeatedUserMessages,
    detectToolErrorBurst,
    frustrationMarkerScore,
    type RetrospectiveMessage,
} from "./friction-signals";

const t0 = Date.UTC(2026, 0, 1, 0, 0, 0);

function msg(overrides: Partial<RetrospectiveMessage>): RetrospectiveMessage {
    return {
        ordinal: 1,
        role: "user",
        text: "",
        ts: t0,
        ...overrides,
    };
}

describe("detectRepeatedUserMessages", () => {
    it("detects near-identical consecutive user re-explanations", () => {
        const signals = detectRepeatedUserMessages([
            msg({
                ordinal: 1,
                text: "Please wire retrospective after curate in the dreamer registry.",
            }),
            msg({ ordinal: 2, role: "assistant", text: "Done." }),
            msg({
                ordinal: 3,
                text: "Please wire the retrospective task after curate in the dreamer registry.",
                ts: t0 + 60_000,
            }),
        ]);

        expect(signals).toHaveLength(1);
        expect(signals[0]?.kind).toBe("repeated_user_message");
        expect(signals[0]?.ordinals).toEqual([1, 3]);
    });

    it("ignores short acknowledgements and distant repeats", () => {
        expect(
            detectRepeatedUserMessages([
                msg({ ordinal: 1, text: "yes" }),
                msg({ ordinal: 2, text: "yes" }),
            ]),
        ).toEqual([]);

        expect(
            detectRepeatedUserMessages([
                msg({
                    ordinal: 1,
                    text: "Please explain why this migration changed the schedule.",
                }),
                msg({
                    ordinal: 2,
                    text: "Please explain why this migration changed the schedule.",
                    ts: t0 + 60 * 60 * 1000,
                }),
            ]),
        ).toEqual([]);
    });
});

describe("detectRepeatedToolCalls", () => {
    it("detects one tool repeated at least the threshold in a short window", () => {
        const signals = detectRepeatedToolCalls([
            msg({ ordinal: 1, role: "tool", toolName: "bash", ts: t0 }),
            msg({ ordinal: 2, role: "tool", toolName: "bash", ts: t0 + 1_000 }),
            msg({ ordinal: 3, role: "tool", toolName: "bash", ts: t0 + 2_000 }),
        ]);

        expect(signals).toHaveLength(1);
        expect(signals[0]?.kind).toBe("repeated_tool_call");
        expect(signals[0]?.ordinals).toEqual([1, 2, 3]);
    });

    it("ignores one-off or spread-out tool calls", () => {
        expect(
            detectRepeatedToolCalls([
                msg({ ordinal: 1, role: "tool", toolName: "read", ts: t0 }),
                msg({ ordinal: 2, role: "tool", toolName: "read", ts: t0 + 60_000 }),
            ]),
        ).toEqual([]);

        expect(
            detectRepeatedToolCalls([
                msg({ ordinal: 1, role: "tool", toolName: "read", ts: t0 }),
                msg({ ordinal: 2, role: "tool", toolName: "read", ts: t0 + 20 * 60 * 1000 }),
                msg({ ordinal: 3, role: "tool", toolName: "read", ts: t0 + 40 * 60 * 1000 }),
            ]),
        ).toEqual([]);
    });
});

describe("detectToolErrorBurst", () => {
    it("detects an elevated error rate over tool results", () => {
        const signals = detectToolErrorBurst([
            msg({ ordinal: 1, role: "tool", toolName: "bash", isError: true, ts: t0 }),
            msg({ ordinal: 2, role: "tool", toolName: "bash", isError: false, ts: t0 + 1_000 }),
            msg({ ordinal: 3, role: "tool", toolName: "bash", isError: true, ts: t0 + 2_000 }),
        ]);

        expect(signals).toHaveLength(1);
        expect(signals[0]?.kind).toBe("tool_error_burst");
        expect(signals[0]?.ordinals).toEqual([1, 3]);
    });

    it("requires a recurring burst, not a single failed tool result", () => {
        expect(
            detectToolErrorBurst([
                msg({ ordinal: 1, role: "tool", toolName: "bash", isError: true, ts: t0 }),
                msg({ ordinal: 2, role: "tool", toolName: "read", isError: false, ts: t0 + 1_000 }),
            ]),
        ).toEqual([]);
    });
});

describe("detectFrustrationMarkers", () => {
    it("detects correction/frustration text", () => {
        const signals = detectFrustrationMarkers([
            msg({ ordinal: 1, text: "No, that's wrong — I already asked you to use Pi." }),
        ]);

        expect(signals).toHaveLength(1);
        expect(signals[0]?.kind).toBe("frustration_marker");
        expect(signals[0]?.ordinals).toEqual([1]);
    });

    it("ignores polite one-off negatives without recurring correction markers", () => {
        expect(frustrationMarkerScore("No thanks, that is enough for now.")).toBeLessThan(2);
        expect(detectFrustrationMarkers([msg({ ordinal: 1, text: "No thanks." })])).toEqual([]);
    });
});

describe("detectFrictionSignals", () => {
    it("returns empty for no-friction windows", () => {
        expect(
            detectFrictionSignals([
                msg({ ordinal: 1, text: "Can you add a test for the migration?" }),
                msg({ ordinal: 2, role: "assistant", text: "Yes." }),
                msg({ ordinal: 3, role: "tool", toolName: "read", isError: false }),
            ]),
        ).toEqual([]);
    });

    it("distinguishes recurring friction from one-off noise", () => {
        const recurring = detectFrictionSignals([
            msg({ ordinal: 1, text: "Please preserve the user's dashboard setting in setup." }),
            msg({ ordinal: 2, role: "assistant", text: "Updated." }),
            msg({
                ordinal: 3,
                text: "Please preserve the user dashboard setting during setup.",
                ts: t0 + 30_000,
            }),
        ]);
        const oneOff = detectFrictionSignals([
            msg({ ordinal: 1, text: "Actually, use the shorter schedule." }),
        ]);

        expect(recurring.map((signal) => signal.kind)).toContain("repeated_user_message");
        expect(oneOff).toEqual([]);
    });
});
