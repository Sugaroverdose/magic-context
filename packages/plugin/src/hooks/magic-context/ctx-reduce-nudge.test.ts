import { describe, expect, it } from "bun:test";
import {
    buildChannel1Reminder,
    buildChannel2Reminder,
    CHANNEL1_SENTINEL,
    CHANNEL2_MIN_RECLAIMABLE,
    CHANNEL2_USABLE_FRACTION,
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

describe("shouldTriggerChannel2 — ceiling (reclaimable ≥ usable/3)", () => {
    it("fires when reclaimable is at least a third of the usable working range", () => {
        // usable=90k → third=30k; reclaimable=30k ⇒ fire
        expect(shouldTriggerChannel2({ reclaimableTokens: 30_000, usableTokens: 90_000 })).toBe(
            true,
        );
    });
    it("the AFT regression: 54k reclaimable on a wide 1M session does NOT fire", () => {
        // Big-context session: usable is large (lots of working room), so 54k is
        // well under a third — the old absolute-40k gate wrongly fired here.
        expect(shouldTriggerChannel2({ reclaimableTokens: 54_000, usableTokens: 300_000 })).toBe(
            false,
        );
    });
    it("the SAME 54k on a tight 120k usable session DOES fire (size-relative)", () => {
        // usable=120k → third=40k; 54k ≥ 40k ⇒ fire. One rule, both contexts.
        expect(shouldTriggerChannel2({ reclaimableTokens: 54_000, usableTokens: 120_000 })).toBe(
            true,
        );
    });
    it("stays quiet below the absolute reclaimable floor regardless of ratio", () => {
        // usable tiny (near threshold) → ratio satisfied, but pile is trivial.
        expect(
            shouldTriggerChannel2({
                reclaimableTokens: CHANNEL2_MIN_RECLAIMABLE - 1,
                usableTokens: 1_000,
            }),
        ).toBe(false);
    });
    it("escalates when at/over threshold (usable ≤ 0) with a real pile", () => {
        expect(shouldTriggerChannel2({ reclaimableTokens: 50_000, usableTokens: 0 })).toBe(true);
    });
    it("uses the 1/3 fraction constant", () => {
        expect(CHANNEL2_USABLE_FRACTION).toBeCloseTo(1 / 3, 5);
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
