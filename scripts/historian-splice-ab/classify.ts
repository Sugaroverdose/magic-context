const WS = /[\s\u0085]+/g;
export const foldWs = (s: string) => s.replace(WS, " ").trim();
const undefang = (s: string) => s.replace(/\\([:>])/g, "$1");
const hasDefang = (s: string) => /(\] (?:U|A|TC|M))\\:|(\[media)\\:|<[^\s<>]*\\>/.test(s);
const HEX_TOKEN = /(^|[\s(,;:[[]])[0-9a-f]{7,40}($|[\s,;:)\]}])/;
const ORD_PREFIX = /^\[(\d+(?:-\d+)?)\]/;

export type DiffClass =
    | "keyArg-fold"
    | "text-fold"
    | "defang-marker"
    | "defang-media"
    | "defang-envelope"
    | "commit-strip-redefang"
    | "per-part-commits"
    | "tc-hash-preservation"
    | "tc-compaction-bypass"
    | "structural"
    | "other";

export interface WindowDiff {
    linesBase: number;
    linesSan: number;
    identicalLines: number;
    diffLines: number;
    classes: Partial<Record<DiffClass, number>>;
    samples: Array<{ class: DiffClass; base: string; san: string }>;
}

function firstDiffPos(a: string, b: string): number {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    return i;
}

function inTcSegment(b: string, pos: number): boolean {
    const at = b.lastIndexOf("TC: ", pos);
    if (at < 0) return false;
    const between = b.slice(at, pos);
    return !between.includes(" / ") || at === 0 || b.slice(0, at).endsWith(" / ");
}

function foldClass(b: string, s: string): DiffClass {
    const pos = firstDiffPos(b, s);
    return inTcSegment(b, pos) ? "keyArg-fold" : "text-fold";
}

function stripHexTokens(s: string): string {
    return s
        .replace(/commits:\s*(?:[0-9a-f]{7,40}\s*,?\s*)+/g, "commits:")
        .replace(/(^|[\s(,;:[@])[0-9a-f]{7,40}(?=$|[\s,;:)\]}])/g, "$1 ")
        .replace(/commits:\s*/g, "")
        // Collapse residue left where a compacted hash token used to sit:
        // empty (), dangling comma/colon, doubled punctuation. Mirrors
        // compactTextForSummary's own cleanup so per-part vs join-compact
        // re-extraction reduces to the same string when only the hash MOVED.
        .replace(/[（(]\s*[)）]/g, "")
        .replace(/\s+,/g, ",")
        .replace(/,\s*,+/g, ",")
        .replace(/\s*([,.;:])/g, "$1")
        .replace(/\s+/g, " ")
        .trim();
}

export function classifyPair(b: string, s: string): DiffClass {
    const fb = foldWs(b);
    const fs = foldWs(s);
    const defanged = hasDefang(s);
    if (fb === fs && !defanged) return foldClass(b, s);
    if (defanged && foldWs(undefang(s)) === fb) {
        const pos = firstDiffPos(b, s);
        if (/(\[media)\\:/.test(s)) return "defang-media";
        if (/(\] (?:U|A|TC|M))\\:/.test(s)) {
            const strippedHash = HEX_TOKEN.test(b) && !HEX_TOKEN.test(s);
            return strippedHash ? "commit-strip-redefang" : "defang-marker";
        }
        void pos;
        return "defang-envelope";
    }
    // Per-part compaction (R3-4): the ONLY remaining difference is which hex
    // commit tokens survive in the joined line (extracted per-part vs whole).
    const hb = stripHexTokens(fb);
    const hs = stripHexTokens(fs);
    const pos0 = firstDiffPos(b, s);
    if (hb === hs) return inTcSegment(b, pos0) ? "tc-hash-preservation" : "per-part-commits";
    const pb = hb.replace(/\s+([,.;:])/g, "$1");
    const ps = hs.replace(/\s+([,.;:])/g, "$1");
    if (pb === ps) return inTcSegment(b, pos0) ? "tc-compaction-bypass" : "text-fold";
    return "other";
}

function diffWindowSample(b: string, s: string, max = 300): { base: string; san: string } {
    const pos = firstDiffPos(b, s);
    const from = Math.max(0, pos - 60);
    return { base: b.slice(from, from + max), san: s.slice(from, from + max) };
}

export function diffChunkText(baseText: string, sanText: string): WindowDiff {
    const bLines = baseText.split("\n");
    const sPool: string[] = sanText.split("\n");
    const out: WindowDiff = {
        linesBase: bLines.length,
        linesSan: sPool.length,
        identicalLines: 0,
        diffLines: 0,
        classes: {},
        samples: [],
    };
    const leftover: string[] = [];
    for (const b of bLines) {
        const at = sPool.indexOf(b);
        if (at >= 0) {
            sPool.splice(at, 1);
            out.identicalLines++;
        } else leftover.push(b);
    }
    for (const b of leftover) {
        out.diffLines++;
        const key = b.match(ORD_PREFIX)?.[1] ?? "?";
        let at = sPool.findIndex((c) => (c.match(ORD_PREFIX)?.[1] ?? "?") === key);
        if (at < 0) at = sPool.findIndex((c) => b.length >= 40 && c.startsWith(b.slice(0, 40)));
        if (at < 0) {
            out.classes.structural = (out.classes.structural ?? 0) + 1;
            continue;
        }
        const s = sPool[at];
        sPool.splice(at, 1);
        const cls = classifyPair(b, s);
        out.classes[cls] = (out.classes[cls] ?? 0) + 1;
        if (out.samples.length < 6) out.samples.push({ class: cls, ...diffWindowSample(b, s) });
    }
    return out;
}
