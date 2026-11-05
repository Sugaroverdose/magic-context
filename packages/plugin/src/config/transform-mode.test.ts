import { describe, expect, it } from "bun:test";

import { RUST_BOOT_REFUSAL_WARNING, resolveTransformMode } from "./transform-mode";

describe("resolveTransformMode", () => {
    it("refuses rust identically when it lacks user-level subc (args no longer decide)", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierHasSubc: false,
                compactionEnabled: true,
            }),
        ).toEqual({
            mode: "ts",
            warnings: [RUST_BOOT_REFUSAL_WARNING],
        });
    });

    it("refuses rust even when trusted user-level subc is present (Unit 1 boot refusal)", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierHasSubc: true,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "ts", warnings: [RUST_BOOT_REFUSAL_WARNING] });
    });

    it("keeps ts without warnings when ts is configured", () => {
        expect(
            resolveTransformMode({
                configured: "ts",
                userTierHasSubc: false,
                compactionEnabled: true,
            }),
        ).toEqual({ mode: "ts", warnings: [] });
    });

    it("refuses rust in the default compaction-on mode with the named warning", () => {
        const result = resolveTransformMode({
            configured: "rust",
            userTierHasSubc: true,
            compactionEnabled: true,
        });

        expect(result.mode).toBe("ts");
        expect(result.warnings).toEqual([RUST_BOOT_REFUSAL_WARNING]);
    });

    it("refuses rust identically when compaction is off (no compaction arm)", () => {
        expect(
            resolveTransformMode({
                configured: "rust",
                userTierHasSubc: true,
                compactionEnabled: false,
            }),
        ).toEqual({
            mode: "ts",
            warnings: [RUST_BOOT_REFUSAL_WARNING],
        });
    });
});
