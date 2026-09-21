import { describe, expect, it } from "bun:test";
import { flattenTheme } from "./sidebar-mount";
import type { V2ResolvedTheme } from "./types";

// Token names copied from the published `@opencode/theme@2.0.11`
// `dist/tui/types.d.ts` (`ResolvedThemeTokens`). An earlier mapping read
// `text.default` / `text.subdued` / `*.default`, which that package never had,
// so every token fell to its hex fallback and headers painted white on light
// themes. This fixture is the real shape; a mapping that reads any other key
// gets the fallback instead of the theme colour and fails below.
const rgba = (r: number, g: number, b: number) => ({ r, g, b, a: 1 });
const hostTheme: V2ResolvedTheme = {
    hue: { accent: { 500: rgba(0.1, 0.2, 0.9) } },
    text: {
        base: rgba(0.05, 0.05, 0.05),
        muted: rgba(0.4, 0.4, 0.4),
        feedback: {
            error: { base: rgba(0.9, 0.1, 0.1) },
            warning: { base: rgba(0.9, 0.6, 0.1) },
            success: { base: rgba(0.1, 0.7, 0.2) },
            info: { base: rgba(0.1, 0.5, 0.9) },
        },
    },
    background: { base: rgba(1, 1, 1) },
    border: { base: rgba(0.7, 0.7, 0.7) },
};

describe("OpenCode 2 theme mapping", () => {
    it("reads the host's resolved tokens, not fallbacks", () => {
        const flat = flattenTheme(hostTheme, "light");
        expect(flat.text).toEqual(hostTheme.text?.base);
        expect(flat.textMuted).toEqual(hostTheme.text?.muted);
        expect(flat.accent).toEqual(hostTheme.hue?.accent?.[500]);
        expect(flat.background).toEqual(hostTheme.background?.base);
        expect(flat.borderActive).toEqual(hostTheme.border?.base);
        expect(flat.error).toEqual(hostTheme.text?.feedback?.error?.base);
        expect(flat.warning).toEqual(hostTheme.text?.feedback?.warning?.base);
        expect(flat.success).toEqual(hostTheme.text?.feedback?.success?.base);
    });

    it("never falls back to white text on a light host", () => {
        const flat = flattenTheme(undefined, "light");
        expect(flat.text).not.toBe("#ffffff");
        expect(flat.background).toBe("#ffffff");
        const dark = flattenTheme(undefined, "dark");
        expect(dark.text).toBe("#ffffff");
    });
});
