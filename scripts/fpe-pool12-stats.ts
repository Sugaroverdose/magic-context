import { createHash } from "node:crypto"
import {
    deriveKey,
    fpeGate,
    renderDropToken,
} from "../packages/plugin/src/hooks/magic-context/fpe.ts"

const key = deriveKey("stats-session")
const MAX_TAG = 20000

// 1) format uniqueness over 4000 tags (v1 baseline: 972/1000)
const sigs = new Set<string>()
for (let t = 1; t <= 4000; t++) {
    const tok = renderDropToken(t, key)
    sigs.add(`${tok.length}|${[...tok].filter((c) => !/[a-z0-9]/.test(c)).join("")}`)
}
console.log(`format signatures: ${sigs.size}/4000 unique`)

// 2) noise accept-surface: random garble from the census typographic band, gate-accepted fraction
const BAND: number[] = []
for (let cp = 0x2000; cp <= 0x2bff; cp++) BAND.push(cp)
for (let cp = 0xb7; cp <= 0xbf; cp++) BAND.push(cp)
const band = BAND.map((cp) => String.fromCodePoint(cp))
let seed = 12345
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const alnum = "abcdefghijklmnopqrstuvwxyz0123456789"
const accept = (gatePoolGlyphs: number) => {
    let accepted = 0
    for (let i = 0; i < 200000; i++) {
        const glyphs = band.slice(0, gatePoolGlyphs) // gate pool subset for control arms
        const L = 8 + Math.floor(rnd() * 2)
        let v = ""
        for (let c = 0; c < L; c++) {
            v += alnum[Math.floor(rnd() * alnum.length)]
            if (rnd() < 0.3) v += glyphs[Math.floor(rnd() * glyphs.length)]
        }
        const r = fpeGate(v, key, L)
        if (r.matched && r.tagId >= 1 && r.tagId <= MAX_TAG) accepted++
    }
    return accepted
}
// arms: v1 pool (5 glyphs) vs new pool (12) — band positions chosen so both arms draw census-real glyphs
const a5 = accept(5)
seed = 12345
const a12 = accept(12)
console.log(`gate-accepted garble (200k draws): pool5=${a5} pool12=${a12} ratio=${(a12 / Math.max(a5, 1)).toFixed(2)}x`)

// 3) determinism: cross-process hash
let h = createHash("sha256")
for (let t = 1; t <= 500; t++) h.update(renderDropToken(t, key))
console.log(`render hash (cross-process comparable): ${h.digest("hex").slice(0, 16)}`)
