/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import {
    type EmergencyDropTag,
    planEmergencyDrop,
    resolveToolTier,
    TARGET_FRACTION,
} from "./emergency-drop";

function tag(
    tagNumber: number,
    toolName: string | null,
    byteSize: number,
    opts: Partial<EmergencyDropTag> = {},
): EmergencyDropTag {
    return {
        tagNumber,
        type: "tool",
        status: "active",
        toolName,
        byteSize,
        reasoningByteSize: 0,
        ...opts,
    };
}

describe("resolveToolTier", () => {
    it("classifies T1 navigation/structure tools", () => {
        for (const name of ["read", "todowrite", "task", "aft_outline", "aft_zoom"]) {
            expect(resolveToolTier(name)).toBe(1);
        }
    });

    it("classifies T2 edit/search tools", () => {
        for (const name of ["edit", "write", "apply_patch", "grep", "glob", "aft_search"]) {
            expect(resolveToolTier(name)).toBe(2);
        }
    });

    it("classifies everything else as T3 (drop-first default)", () => {
        for (const name of ["bash", "ctx_reduce", "aft_inspect", "webfetch", "unknown_tool"]) {
            expect(resolveToolTier(name)).toBe(3);
        }
    });

    it("normalizes mcp_ prefix and case so prefixed names still tier correctly", () => {
        expect(resolveToolTier("mcp_read")).toBe(1);
        expect(resolveToolTier("MCP_Edit")).toBe(2);
        expect(resolveToolTier("Bash")).toBe(3);
    });

    it("treats null tool name as T3", () => {
        expect(resolveToolTier(null)).toBe(3);
    });
});

describe("planEmergencyDrop — guards", () => {
    const base = {
        maxTag: 10,
        protectedTags: 0,
        priorWatermark: 0,
    };

    it("skips when the ceiling is unknown/invalid", () => {
        const plan = planEmergencyDrop({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 100_000,
            ceilingTokens: 0,
        });
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toBe("unknown-ceiling");
    });

    it("no-ops when already at/under target (reclaim <= min)", () => {
        const plan = planEmergencyDrop({
            ...base,
            tags: [tag(1, "bash", 4000)],
            currentTotalInputTokens: 1_000,
            ceilingTokens: 100_000,
        });
        expect(plan.shouldDrop).toBe(false);
    });
});

describe("planEmergencyDrop — target math", () => {
    it("computes target = fixedFloor + 0.30 × (ceiling − fixedFloor)", () => {
        // 10 tags × 4000 bytes × 0.25 = 10000 tail tokens; usage 30000 →
        // fixedFloor = 30000 - 10000 = 20000. ceiling 160000 →
        // workingSpan 140000, target = 20000 + 0.30×140000 = 62000,
        // reclaim = 30000 - 62000 < 0 → no-op (under target).
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 4000));
        const plan = planEmergencyDrop({
            tags,
            maxTag: 10,
            protectedTags: 0,
            priorWatermark: 0,
            currentTotalInputTokens: 30_000,
            ceilingTokens: 160_000,
        });
        expect(TARGET_FRACTION).toBe(0.3);
        expect(plan.shouldDrop).toBe(false); // already under the 62k target
    });

    it("reclaims down toward target, dropping oldest T3 first", () => {
        // 20 tags × 2000 bytes × 0.25 = 10000 tail tokens; usage 10000,
        // fixedFloor ≈ 0, ceiling 6000 → target 1800 → reclaim ≈ 8200.
        const tags = Array.from({ length: 20 }, (_, i) => tag(i + 1, "bash", 2000));
        const plan = planEmergencyDrop({
            tags,
            maxTag: 20,
            protectedTags: 2,
            priorWatermark: 0,
            currentTotalInputTokens: 10_000,
            ceilingTokens: 6_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // oldest first
        expect(plan.tagNumbers[0]).toBe(1);
        // never drops the protected tail (19, 20)
        expect(plan.tagNumbers).not.toContain(19);
        expect(plan.tagNumbers).not.toContain(20);
        // watermark advances to the highest dropped tag
        expect(plan.newWatermark).toBe(Math.max(...plan.tagNumbers));
    });
});

describe("planEmergencyDrop — tier ordering", () => {
    it("drops T3 before T2 before T1", () => {
        // Mix of tiers, all same size. reclaim forces dropping several.
        const tags = [
            tag(1, "read", 4000), // T1
            tag(2, "edit", 4000), // T2
            tag(3, "bash", 4000), // T3
            tag(4, "read", 4000), // T1
            tag(5, "edit", 4000), // T2
            tag(6, "bash", 4000), // T3
        ];
        // tail = 6×1000 = 6000 tokens; usage 6000, ceiling 1000 →
        // target 300 → reclaim ≈ 5700 → must drop almost everything.
        const plan = planEmergencyDrop({
            tags,
            maxTag: 6,
            protectedTags: 0,
            priorWatermark: 0,
            currentTotalInputTokens: 6_000,
            ceilingTokens: 1_000,
        });
        expect(plan.shouldDrop).toBe(true);
        // T3 (3, 6) come first in eviction order.
        const firstTwo = plan.tagNumbers.slice(0, 2).sort((a, b) => a - b);
        expect(firstTwo).toEqual([3, 6]);
    });

    it("reserves the newest 20% of T1/T2 tiers (ceil), never T3", () => {
        // 10 T2 edits. reserve = ceil(0.2×10) = 2 newest (tags 9,10).
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "edit", 8000));
        const plan = planEmergencyDrop({
            tags,
            maxTag: 10,
            protectedTags: 0,
            priorWatermark: 0,
            currentTotalInputTokens: 20_000, // tail = 10×2000 = 20000
            ceilingTokens: 1_000, // target ≈ 300 → reclaim huge
        });
        expect(plan.shouldDrop).toBe(true);
        // newest 2 of the T2 tier are reserved.
        expect(plan.tagNumbers).not.toContain(9);
        expect(plan.tagNumbers).not.toContain(10);
        // older ones are evictable.
        expect(plan.tagNumbers).toContain(1);
    });

    it("a tiny T1/T2 tier reserves all of it (ceil keeps >=1)", () => {
        const tags = [tag(1, "read", 8000), tag(2, "bash", 8000)];
        // tail 4000 tokens, usage 4000, ceiling 500 → reclaim huge.
        const plan = planEmergencyDrop({
            tags,
            maxTag: 2,
            protectedTags: 0,
            priorWatermark: 0,
            currentTotalInputTokens: 4_000,
            ceilingTokens: 500,
        });
        // T1 read (tag 1) is the entire T1 tier → reserved (ceil(0.2×1)=1).
        expect(plan.tagNumbers).not.toContain(1);
        // T3 bash is fully depletable.
        expect(plan.tagNumbers).toContain(2);
    });
});

describe("planEmergencyDrop — watermark idempotence (no oscillation)", () => {
    it("only considers tags above the prior watermark", () => {
        const tags = Array.from({ length: 10 }, (_, i) => tag(i + 1, "bash", 4000));
        const plan = planEmergencyDrop({
            tags,
            maxTag: 10,
            protectedTags: 0,
            priorWatermark: 5, // tags 1-5 already dropped in a prior pass
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        // none of the already-watermarked tags are reselected.
        for (const n of [1, 2, 3, 4, 5]) {
            expect(plan.tagNumbers).not.toContain(n);
        }
        expect(Math.min(...plan.tagNumbers)).toBeGreaterThan(5);
    });

    it("no-ops with no new candidates above the watermark", () => {
        const tags = Array.from({ length: 5 }, (_, i) => tag(i + 1, "bash", 4000));
        const plan = planEmergencyDrop({
            tags,
            maxTag: 5,
            protectedTags: 0,
            priorWatermark: 5, // everything already dropped
            currentTotalInputTokens: 10_000,
            ceilingTokens: 1_000,
        });
        expect(plan.shouldDrop).toBe(false);
        expect(plan.reason).toBe("no-new-candidates");
        expect(plan.newWatermark).toBe(5); // unchanged
    });

    it("ignores already-dropped tags even below the watermark", () => {
        const tags = [
            tag(1, "bash", 4000, { status: "dropped" }),
            tag(2, "bash", 4000),
            tag(3, "bash", 4000),
        ];
        const plan = planEmergencyDrop({
            tags,
            maxTag: 3,
            protectedTags: 0,
            priorWatermark: 0,
            currentTotalInputTokens: 3_000,
            ceilingTokens: 200,
        });
        expect(plan.tagNumbers).not.toContain(1);
    });
});
