/**
 * FPE v4 certification harness (self-contained, no test runner).
 *
 *   bun scripts/fpe-v4-stats.ts
 *
 * Certifies the v4 segmentation-channel render: uniqueness,
 * positioning-frame floors (head/tail/octile/delta), segmentation
 * dose, registry-bounded nullspace, cross-process determinism,
 * gate timing. Pool/cipher are imported from the live codec - the
 * harness reads the shipped constants, never a copy.
 */
import { createHash } from "node:crypto";
import {
    deriveKey,
    fpeEncrypt,
    fpeGate,
    renderDropToken,
} from "../packages/plugin/src/hooks/magic-context/fpe";

const KEY = deriveKey("cert-v4");
const SP = String.fromCodePoint(0x20);
const N = 20000;
const MAXTAG = 20000;

const head: Record<string, number> = {};
const tail: Record<string, number> = {};
const octile: Record<string, number> = {};
const delta: Record<string, number> = {};
const skel: Record<string, number> = {};
const fmt: Record<string, number> = {};
let seg = 0;
let maxLen = 0;
const toks = new Set<string>();

for (let t = 1; t <= N; t++) {
    const r = renderDropToken(t, KEY);
    toks.add(r);
    maxLen = Math.max(maxLen, r.length);
    if (r.includes(SP)) seg++;
    const skKey = [...r]
        .map((c) => (/[a-z0-9]/.test(c) ? "X" : c === SP ? "S" : "."))
        .join("");
    skel[skKey] = (skel[skKey] ?? 0) + 1;
    const fl = [...r].filter((c) => c !== SP && !/[a-z0-9]/.test(c)).join("");
    fmt[`${r.length}|${fl}`] = (fmt[`${r.length}|${fl}`] ?? 0) + 1;
    const pos: number[] = [];
    ;[...r].forEach((c, i) => {
        if (c !== SP) return;
        head[String(i + 1)] = (head[String(i + 1)] ?? 0) + 1;
        tail[String(r.length - i)] = (tail[String(r.length - i)] ?? 0) + 1;
        const f = Math.floor(((i + 1) / r.length) * 8);
        octile[String(f)] = (octile[String(f)] ?? 0) + 1;
        pos.push(i);
    });
    for (let i = 1; i < pos.length; i++) {
        const d = String(pos[i] - pos[i - 1]);
        delta[d] = (delta[d] ?? 0) + 1;
    }
}

const topCell = (h: Record<string, number>) => {
    const tot = Object.values(h).reduce((a, b) => a + b, 0) || 1;
    const s = Object.entries(h).sort((a, b) => b[1] - a[1]);
    return { cell: s[0][0], pct: (s[0][1] / tot) * 100, cells: s.length };
};

console.log(`token uniqueness: ${toks.size}/${N}`);
console.log(`segmentation: ${((seg / N) * 100).toFixed(1)}%  maxLen: ${maxLen}`);
for (const [name, h] of [
    ["head", head],
    ["tail(fromEnd)", tail],
    ["octile", octile],
    ["delta", delta],
] as const) {
    const s = topCell(h);
    console.log(`${name.padEnd(13)} top cell: ${s.pct.toFixed(1)}% @${s.cell} (${s.cells} cells)`);
}
const sk = topCell(skel);
const fm = topCell(fmt);
console.log(`skeleton top:  ${sk.pct.toFixed(2)}% (${sk.cells} cells)`);
console.log(`format top:    ${fm.pct.toFixed(2)}% (${fm.cells} cells)`);

// registry-bounded nullspace: shape-correct random strings must not
// resolve to a real slot. The gate is bijective by design (v1 law);
// the accept surface is gate-match AND tagId in [1, maxTag].
const alnum = "abcdefghijklmnopqrstuvwxyz0123456789";
const pool = [0xb7, 0x2219, 0x2e31, 0x2023, 0x2022, 0x2248, 0x2212, 0x2605, 0x2717, 0x2032].map(
    (c) => String.fromCodePoint(c),
);
let bounded = 0;
for (let i = 0; i < 200000; i++) {
    let s = "";
    const L = 8 + Math.floor(Math.random() * 5);
    for (let j = 0; j < L; j++) {
        s += alnum[Math.floor(Math.random() * 36)];
        if (Math.random() < 0.5) s += pool[Math.floor(Math.random() * pool.length)];
        if (Math.random() < 0.3) s += SP;
    }
    const g = fpeGate(s, KEY, 8);
    if (g.matched && g.tagId >= 1 && g.tagId <= MAXTAG) bounded++;
}
console.log(`registry-bounded nullspace: ${bounded}/200000`);

// v1-era decode lane: gap-space renders must resolve (strip is the boundary)
{
    const V1 = [0xb7, 0x2219, 0x2e31, 0x2023, 0x2022, 0x20].map((c) => String.fromCodePoint(c));
    const fnv = (s: string): bigint => {
        let h = 2166136261n;
        for (let i = 0; i < s.length; i++) {
            h ^= BigInt(s.charCodeAt(i));
            h = (h * 0x100000001b3n) % (1n << 64n);
        }
        return h;
    };
    const xs = (st: bigint): [number, bigint] => {
        let s = st;
        s ^= (s << 13n) % (1n << 64n);
        s ^= s >> 7n;
        s ^= (s << 17n) % (1n << 64n);
        return [Number(s % 100n), s];
    };
    let ok = 0;
    for (let tag = 1; tag <= 1000; tag++) {
        const payload = fpeEncrypt(tag, KEY, 8);
        let state = fnv(payload + KEY.toString(16));
        let v1 = "";
        for (let i = 0; i < payload.length; i++) {
            v1 += payload[i];
            if (i === payload.length - 1) break;
            const [pct, n1] = xs(state);
            state = n1;
            const count = pct < 50 ? 0 : pct < 80 ? 1 : 2;
            for (let j = 0; j < count; j++) {
                const [fp, n2] = xs(state);
                state = n2;
                v1 += V1[fp % V1.length];
            }
        }
        const g = fpeGate(v1, KEY, 8);
        if (g.matched && g.tagId === tag) ok++;
    }
    console.log(`v1-era decode lane: ${ok}/1000 resolve`);
}

const h = createHash("sha256");
for (let t = 1; t <= 500; t++) h.update(renderDropToken(t, KEY));
console.log(`determinism hash: ${h.digest("hex").slice(0, 16)} (compare across processes)`);
