import { describe, expect, it } from "bun:test";
import {
    buildChannel1Reminder,
    buildChannel2Reminder,
    CHANNEL1_SENTINEL,
    CHANNEL2_CEIL_UNDROPPED,
    CHANNEL2_PRESSURE_NEAR,
    computePressure,
    computeTailToolTokens,
    decideChannel1,
    shouldTriggerChannel2,
} from "./ctx-reduce-nudge";
import type { MessageLike } from "./tag-messages";

function toolMsg(output: string): MessageLike {
    return {
        info: { id: "m", role: "assistant" },
        parts: [{ type: "tool", state: { output } }],
    } as unknown as MessageLike;
}

const BUDGET = 100_000;

describe("computeTailToolTokens", () => {
    it("sums non-dropped tool output, excludes sentinels", () => {
        const big = "x".repeat(40_000); // ~10k tokens
        const msgs = [toolMsg(big), toolMsg("[dropped §5§]"), toolMsg("[truncated]")];
        const tokens = computeTailToolTokens(msgs);
        expect(tokens).toBeGreaterThan(9_000);
        expect(tokens).toBeLessThan(11_000);
    });
    it("ignores non-tool parts", () => {
        const msg = {
            info: { id: "m", role: "user" },
            parts: [{ type: "text", text: "x".repeat(40_000) }],
        } as unknown as MessageLike;
        expect(computeTailToolTokens([msg])).toBe(0);
    });
});

describe("decideChannel1 — trajectories", () => {
    const base = { historyBudgetTokens: BUDGET, lastNudgeUndropped: 0, hasRecentReduce: false };

    it("early reading: large undropped, low pressure → silent", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 40_000, pressure: 0.3 });
        // severity = 0.4 * 0.3 = 0.12 < 0.35, and ceil override needs pressure>=0.5
        expect(d.fire).toBe(false);
    });
    it("disciplined small working set at high pressure → silent", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 9_000, pressure: 0.9 });
        expect(d.fire).toBe(false); // below floor
    });
    it("small unreduced pile, not pressured → silent (ratio would over-nudge)", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 12_000, pressure: 0.3 });
        // severity = 0.12 * 0.3 = 0.036 → silent
        expect(d.fire).toBe(false);
    });
    it("undisciplined + pressured → urgent", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 90_000, pressure: 0.9 });
        // severity = 0.9 * 0.9 = 0.81 ≥ 0.65
        expect(d.fire).toBe(true);
        expect(d.level).toBe("urgent");
    });
    it("moderate, modest pressure → gentle", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 40_000, pressure: 0.6 });
        // severity = 0.4 * 0.6 = 0.24 → gentle band [0.2,0.4)
        expect(d.fire).toBe(true);
        expect(d.level).toBe("gentle");
    });
    it("moderate-high → firm", () => {
        const d = decideChannel1({ ...base, undroppedTokens: 50_000, pressure: 0.8 });
        // severity = 0.5 * 0.8 = 0.40 ≥ 0.4 → firm
        expect(d.fire).toBe(true);
        expect(d.level).toBe("firm");
    });
    it("post-ctx_reduce suppression: never fire on a reduce turn", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 90_000,
            pressure: 0.9,
            hasRecentReduce: true,
        });
        expect(d.fire).toBe(false);
    });
    it("cadence: does not re-fire until undropped grows another interval", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 55_000,
            pressure: 0.9,
            lastNudgeUndropped: 50_000,
        });
        // grew only 5k < 10k interval → silent
        expect(d.fire).toBe(false);
    });
    it("cadence re-arms after a reduce drops undropped below last mark", () => {
        const d = decideChannel1({
            ...base,
            undroppedTokens: 30_000,
            pressure: 0.9,
            lastNudgeUndropped: 80_000,
        });
        // undropped fell below last mark → reset to 0 → 30k ≥ 0+10k.
        // severity = 0.3 * 0.9 = 0.27 ≥ 0.2 → gentle, fires again.
        expect(d.fire).toBe(true);
        expect(d.nextLastNudge).toBe(30_000);
    });
});

describe("computePressure", () => {
    it("derives pressure from prospective input + turn tokens", () => {
        const p = computePressure({
            lastInputTokens: 120_000,
            turnToolTokens: 10_000,
            contextLimit: 200_000,
            executeThresholdPercentage: 65,
        });
        // usage% = 130000/200000*100 = 65; pressure = 65/65 = 1.0
        expect(p).toBeCloseTo(1.0, 2);
    });
    it("returns 0 on unknown limit (cold start)", () => {
        expect(
            computePressure({
                lastInputTokens: 0,
                turnToolTokens: 0,
                contextLimit: 0,
                executeThresholdPercentage: 65,
            }),
        ).toBe(0);
    });
});

describe("buildChannel1Reminder", () => {
    it("wraps in the versioned sentinel and reports the amount", () => {
        const r = buildChannel1Reminder("firm", 42_000);
        expect(r).toContain(CHANNEL1_SENTINEL);
        expect(r).toContain("</system-reminder>");
        expect(r).toContain("~42k");
    });
});

describe("shouldTriggerChannel2 — ceiling", () => {
    it("fires only when pressure is near threshold AND a large pile remains", () => {
        expect(
            shouldTriggerChannel2({
                undroppedTokens: CHANNEL2_CEIL_UNDROPPED,
                pressure: CHANNEL2_PRESSURE_NEAR,
            }),
        ).toBe(true);
    });
    it("stays quiet when pressure is below the near-threshold", () => {
        expect(shouldTriggerChannel2({ undroppedTokens: 100_000, pressure: 0.7 })).toBe(false);
    });
    it("stays quiet when the reclaimable pile is below the ceiling floor", () => {
        expect(shouldTriggerChannel2({ undroppedTokens: 20_000, pressure: 1.0 })).toBe(false);
    });
    it("early reading (low pressure, large pile) does NOT trigger the ceiling", () => {
        expect(shouldTriggerChannel2({ undroppedTokens: 80_000, pressure: 0.4 })).toBe(false);
    });
});

describe("buildChannel2Reminder", () => {
    it("is a plain system-reminder and reports the amount", () => {
        const r = buildChannel2Reminder(55_000);
        expect(r).toContain("<system-reminder>");
        expect(r).toContain("</system-reminder>");
        expect(r).toContain("~55k");
        expect(r).toContain("ctx_reduce");
    });
});
