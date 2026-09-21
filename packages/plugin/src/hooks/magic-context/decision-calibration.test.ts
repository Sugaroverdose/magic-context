import { describe, expect, it } from "bun:test";
import fixture from "../../../../../tests/fixtures/decision-calibration.json";
import { localBudget, providerMass, resolveDecisionCalibration } from "./decision-calibration";

describe("static decision calibration", () => {
    it("calibrates the supplied Fable section fixture independently with one final ceil", () => {
        const seed = resolveDecisionCalibration("anthropic", "claude-fable-5-1");
        expect(
            providerMass(
                { system: fixture.rawSystem, tools: fixture.rawTools, prose: fixture.rawProse },
                seed,
            ),
        ).toBe(fixture.providerMass);
        expect(localBudget(fixture.providerBudget, seed.proseRatio)).toBe(fixture.localBudget);
        expect(seed.source).toBe("seed");
    });
    it("keeps family fallback seeded, not subject to unknown-model fit inflation", () => {
        const seed = resolveDecisionCalibration("anthropic", "claude-fable-5-2");
        expect(seed.source).toBe("family-fallback");
        expect(providerMass({ prose: 1000 }, seed, true)).toBe(1572);
    });
    it("inflates unknown fit mass while keeping eviction budgets neutral", () => {
        const seed = resolveDecisionCalibration("unmeasured", "new-1");
        expect(providerMass({ prose: 1000 }, seed)).toBe(1000);
        expect(providerMass({ prose: 1000 }, seed, true)).toBeGreaterThanOrEqual(2000);
        expect(localBudget(60000, seed.proseRatio)).toBe(60000);
    });
    it("fails closed for invalid component counts and invalid budget ratios", () => {
        const seed = resolveDecisionCalibration("anthropic", "claude-fable-5-1");
        expect(providerMass({ prose: Number.NaN }, seed, true)).toBe(Number.POSITIVE_INFINITY);
        expect(providerMass({ tools: -1 }, seed, true)).toBe(Number.POSITIVE_INFINITY);
        expect(localBudget(100, 0)).toBe(0);
        expect(localBudget(Number.POSITIVE_INFINITY, 1)).toBe(0);
    });
});
