/**
 * cache-analysis.ts — the cache-bust oracle for e2e tests.
 *
 * This is the in-test port of the production diagnostic
 * `packages/plugin/scripts/analyze-cache-busts.ts`. It encodes the SAME
 * definition of "what is a cache bust" so the suite asserts against the exact
 * notion the real wire-diff tool uses — not an ad-hoc per-test prefix loop.
 *
 * The core idea: Anthropic serves a cache hit only up to the longest matching
 * prefix that ends at a `cache_control` breakpoint. So for two consecutive
 * requests in a session, find the FIRST wire-order segment whose content
 * changed. If that divergence lands at/after the final breakpoint, it's the
 * growing tail (a new turn was appended) → STABLE. If it lands BEFORE the final
 * breakpoint, the request rewrote bytes that were supposed to stay cached →
 * BUST.
 *
 * Normalization (measure REAL content drift, not provider/marker noise):
 *   - `cache_control` markers move every turn (OpenCode walks the breakpoint
 *     forward to extend the cached boundary) → stripped before hashing.
 *   - The `cch=<nonce>` billing nonce in the system block is per-request and
 *     Anthropic ignores it for cache-keying → normalized out.
 *   - `§N§` tag prefixes ARE on-wire content the model sees → KEPT. A changed
 *     tag number is a genuine bust we want to catch.
 *
 * Works on the `CapturedRequest` shape both TestHarness and PiTestHarness
 * expose via `mock.requests()`, so OpenCode and Pi suites share one oracle.
 */

import { createHash } from "node:crypto";

type Json = Record<string, unknown>;

export interface WireSegment {
    id: string;
    hash: string;
    bytes: number;
    breakpoint: boolean;
}

export interface WireSnapshot {
    /** Index of this request within the filtered request list. */
    index: number;
    segments: WireSegment[];
}

export type BustVerdict = "BASE" | "SAME" | "STABLE" | "BUST";

export interface PassComparison {
    /** Index of the later request in the pair. */
    index: number;
    verdict: BustVerdict;
    /** Wire-order index of the first diverging segment (-1 if none). */
    divergeIndex: number;
    /** Human-readable id of the first diverging segment. */
    divergeSegmentId: string | null;
    /** Effective cached-prefix bytes (up to the last breakpoint before divergence). */
    cachedPrefixBytes: number;
    /** Segment id of that last breakpoint. */
    cachedPrefixAt: string;
    /** prev/cur snippet of the diverging segment, for failure diagnostics. */
    diff: { prev: string | null; cur: string | null } | null;
}

interface MinimalRequest {
    body: { system?: unknown; messages?: unknown; [k: string]: unknown };
}

function sha(s: string): string {
    return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/** Recursively strip `cache_control` fields — marker movement is not content. */
function stripCacheControl(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripCacheControl);
    if (value && typeof value === "object") {
        const out: Json = {};
        for (const [k, v] of Object.entries(value as Json)) {
            if (k === "cache_control") continue;
            out[k] = stripCacheControl(v);
        }
        return out;
    }
    return value;
}

function hasCacheControl(block: unknown): boolean {
    return !!block && typeof block === "object" && "cache_control" in (block as Json);
}

function messageHasBreakpoint(msg: Json): boolean {
    const content = msg.content;
    if (Array.isArray(content)) return content.some((p) => hasCacheControl(p));
    return hasCacheControl(msg);
}

/** Normalize the per-request billing nonce so it isn't seen as a content change. */
function normalizeSystemText(text: string): string {
    return text.replace(/cch=[^;]*;/g, "cch=<NONCE>;");
}

function blockText(block: unknown): string {
    if (block && typeof block === "object" && typeof (block as Json).text === "string") {
        return (block as Json).text as string;
    }
    return JSON.stringify(stripCacheControl(block));
}

/** Build the wire-order segment list: system blocks first, then every message. */
export function buildSegments(body: MinimalRequest["body"]): WireSegment[] {
    const segs: WireSegment[] = [];
    const system = body.system;
    const sysBlocks = Array.isArray(system) ? system : system != null ? [system] : [];
    sysBlocks.forEach((b, i) => {
        const raw = blockText(b);
        segs.push({
            id: `system[${i}]`,
            hash: sha(normalizeSystemText(raw)),
            bytes: Buffer.byteLength(raw),
            breakpoint: hasCacheControl(b),
        });
    });
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    messages.forEach((m, i) => {
        const norm = JSON.stringify({ role: m.role, content: stripCacheControl(m.content) });
        segs.push({
            id: `message[${i}](${String(m.role)})`,
            hash: sha(norm),
            bytes: Buffer.byteLength(JSON.stringify(m)),
            breakpoint: messageHasBreakpoint(m),
        });
    });
    return segs;
}

/** First wire-order segment index where prev/cur diverge (added/removed/changed). */
function firstDivergence(prev: WireSegment[], cur: WireSegment[]): number {
    const n = Math.min(prev.length, cur.length);
    for (let i = 0; i < n; i += 1) {
        if (prev[i].hash !== cur[i].hash || prev[i].id !== cur[i].id) return i;
    }
    return prev.length === cur.length ? -1 : n;
}

/** Effective cached prefix = bytes up to the last breakpoint strictly before divergence. */
function cachedPrefixBytes(segs: WireSegment[], divergeIdx: number): { bytes: number; at: string } {
    let bytes = 0;
    let lastBreakpointBytes = 0;
    let lastBreakpointId = "(none)";
    const limit = divergeIdx < 0 ? segs.length : divergeIdx;
    for (let i = 0; i < segs.length; i += 1) {
        if (i < limit && segs[i].breakpoint) {
            lastBreakpointBytes = bytes + segs[i].bytes;
            lastBreakpointId = segs[i].id;
        }
        bytes += segs[i].bytes;
    }
    return { bytes: lastBreakpointBytes, at: lastBreakpointId };
}

function lastBreakpointIndex(segs: WireSegment[]): number {
    let last = -1;
    for (let i = 0; i < segs.length; i += 1) if (segs[i].breakpoint) last = i;
    return last;
}

function rawSegmentText(body: MinimalRequest["body"], idx: number): string | null {
    const system = body.system;
    const sysBlocks = Array.isArray(system) ? system : system != null ? [system] : [];
    if (idx < sysBlocks.length) return blockText(sysBlocks[idx]);
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    const mIdx = idx - sysBlocks.length;
    const m = messages[mIdx];
    if (!m) return null;
    return JSON.stringify({ role: m.role, content: stripCacheControl(m.content) });
}

/**
 * Compare each consecutive pair of requests and verdict every transition.
 * `requests` should already be filtered to the main-agent requests in order.
 */
export function analyzePasses(requests: MinimalRequest[]): PassComparison[] {
    const out: PassComparison[] = [];
    const snaps = requests.map((r) => buildSegments(r.body));
    for (let k = 0; k < snaps.length; k += 1) {
        if (k === 0) {
            out.push({
                index: 0,
                verdict: "BASE",
                divergeIndex: -1,
                divergeSegmentId: null,
                cachedPrefixBytes: 0,
                cachedPrefixAt: "(base)",
                diff: null,
            });
            continue;
        }
        const prev = snaps[k - 1];
        const cur = snaps[k];
        const idx = firstDivergence(prev, cur);
        if (idx === -1) {
            out.push({
                index: k,
                verdict: "SAME",
                divergeIndex: -1,
                divergeSegmentId: null,
                cachedPrefixBytes: cachedPrefixBytes(cur, -1).bytes,
                cachedPrefixAt: cachedPrefixBytes(cur, -1).at,
                diff: null,
            });
            continue;
        }
        // The cache was WRITTEN during the previous request, at the previous
        // request's cache_control breakpoints. So the reusable cached prefix for
        // this transition is bounded by PREV's last breakpoint — not cur's.
        // OpenCode walks the breakpoint forward to the last 1-2 messages every
        // turn, so cur's last breakpoint sits AHEAD of freshly-appended tail
        // content; comparing against it would mis-flag benign tail growth as a
        // bust. The correct invariant: everything up to and including prev's
        // last breakpoint must stay byte-identical in cur.
        //   STABLE: first divergence is strictly AFTER prev's last breakpoint
        //           (only uncached tail changed, or pure append).
        //   BUST:   first divergence is at/before prev's last breakpoint
        //           (content that was cached got rewritten).
        // prevLastBreakpoint === -1 means prev cached nothing → no bust possible.
        const prevLastBreakpoint = lastBreakpointIndex(prev);
        const verdict: BustVerdict = idx > prevLastBreakpoint ? "STABLE" : "BUST";
        const cp = cachedPrefixBytes(cur, idx);
        const seg = cur[idx] ?? prev[idx];
        out.push({
            index: k,
            verdict,
            divergeIndex: idx,
            divergeSegmentId: seg?.id ?? `seg[${idx}]`,
            cachedPrefixBytes: cp.bytes,
            cachedPrefixAt: cp.at,
            diff:
                verdict === "BUST"
                    ? {
                          prev: rawSegmentText(requests[k - 1].body, idx)?.slice(0, 400) ?? null,
                          cur: rawSegmentText(requests[k].body, idx)?.slice(0, 400) ?? null,
                      }
                    : null,
        });
    }
    return out;
}

/** All comparisons that the oracle classifies as a real cache bust. */
export function findBusts(requests: MinimalRequest[]): PassComparison[] {
    return analyzePasses(requests).filter((c) => c.verdict === "BUST");
}

/** Filter to main-agent requests (those carrying the Magic Context system block). */
export function mainAgentRequests<T extends MinimalRequest>(requests: T[]): T[] {
    return requests.filter((r) => {
        const sys = r.body.system;
        if (sys === undefined || sys === null) return false;
        const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
        return asString.includes("## Magic Context");
    });
}

/** Compact, human-readable bust report for test failure messages. */
export function formatBustReport(comparisons: PassComparison[]): string {
    const lines: string[] = [];
    for (const c of comparisons) {
        if (c.verdict === "BUST") {
            lines.push(
                `  BUST @pass ${c.index}: first divergence ${c.divergeSegmentId} ` +
                    `(before final breakpoint; cached prefix collapsed to ${c.cachedPrefixAt}, ${c.cachedPrefixBytes.toLocaleString()}B)`,
            );
            if (c.diff) {
                lines.push(`    prev: ${c.diff.prev ?? "—"}`);
                lines.push(`    cur:  ${c.diff.cur ?? "—"}`);
            }
        }
    }
    return lines.length ? lines.join("\n") : "  (no busts)";
}
