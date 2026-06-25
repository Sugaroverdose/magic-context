/**
 * Pick a readable text color (black or white) for text drawn ON TOP of a given
 * background color.
 *
 * The sidebar header badge previously drew its label with `fg={theme.background}`
 * on a `theme.accent` background. That breaks for themes that set
 * `background: "none"` (transparent) to respect terminal transparency: the
 * resolved background is `RGBA(0,0,0,0)`, so the badge text renders fully
 * transparent and disappears (issue #186). The badge background (`accent`) is
 * always opaque, so deriving the text color from it is transparency-proof.
 *
 * The pick is WHITE-BIASED off the accent's relative luminance: white for any
 * accent in the dark half (luminance < 0.5), black only for genuinely light
 * accents. A strict "higher-contrast-wins" pick (crossover at luminance 0.179)
 * flips ordinary mid-tone accents to black: a typical orange/amber sidebar
 * accent (luminance ~0.3) reads black ~5:1 vs white ~3.7:1, so contrast-wins
 * picks black even though white at ~3.7:1 is perfectly legible for a short bold
 * label. That looks heavy and clashes with the sibling status badges, so we
 * prefer white across the whole dark half and only fall to black once the accent
 * is actually light (pale/pastel/near-white), where white would be unreadable.
 *
 * `RGBA` channels from @opentui/core are normalized 0..1 floats. We accept the
 * minimal `{ r, g, b }` shape so this stays a pure, trivially testable function
 * independent of the native color class.
 */

// Luminance midpoint: accents below this keep white text, accents at/above it
// (light/pastel/near-white) get black. White-biased relative to the strict
// equal-contrast crossover (~0.179) so saturated mid-tone accents stay white.
const LIGHT_ACCENT_LUMINANCE = 0.5;

function srgbChannelToLinear(c: number): number {
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(bg: { r: number; g: number; b: number }): number {
    return (
        0.2126 * srgbChannelToLinear(bg.r) +
        0.7152 * srgbChannelToLinear(bg.g) +
        0.0722 * srgbChannelToLinear(bg.b)
    );
}

export function readableTextColorOn(bg: { r: number; g: number; b: number }): string {
    return relativeLuminance(bg) < LIGHT_ACCENT_LUMINANCE ? "#ffffff" : "#000000";
}
