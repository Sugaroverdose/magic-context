import { Database } from "bun:sqlite"

const db = new Database(`${process.env.HOME}/.local/share/cortexkit/magic-context/context.db`, { readonly: true })
const rows = db.query("SELECT content FROM message_history_fts WHERE content IS NOT NULL").all() as Array<{
    content: string
}>
let total = 0
const hist = new Map<number, number>()
for (const r of rows) {
    total += r.content.length
    for (const ch of r.content) {
        const cp = ch.codePointAt(0)!
        if (cp >= 0x2000 && cp <= 0x2bff) hist.set(cp, (hist.get(cp) ?? 0) + 1)
        if (cp > 0x7f && cp < 0x2000 && cp >= 0xb7 && cp <= 0xbf) hist.set(cp, (hist.get(cp) ?? 0) + 1)
    }
}
const pool = [0xb7, 0x2022, 0x2219, 0x2e31, 0x2023]
const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1])
console.log(`corpus=${(total / 1e6).toFixed(1)}M chars, ${rows.length} rows`)
console.log("CURRENT POOL ranks:")
for (const p of pool) {
    const rank = sorted.findIndex(([cp]) => cp === p) + 1
    const n = hist.get(p) ?? 0
    const nfc = String.fromCodePoint(p) === String.fromCodePoint(p).normalize("NFC")
    console.log(`  U+${p.toString(16).toUpperCase()} n=${n} rank=${rank}/${sorted.length} nfc=${nfc}`)
}
console.log("TOP 30 non-pool candidates (range U+2000-U+2BFF, NFC-stable, printable):")
let shown = 0
for (const [cp, n] of sorted) {
    if (pool.includes(cp)) continue
    if (cp < 0x2000) continue
    if (/\s/.test(String.fromCodePoint(cp))) continue
    const ch = String.fromCodePoint(cp)
    if (ch.normalize("NFC") !== ch || ch.normalize("NFKC") !== ch) continue
    console.log(`  U+${cp.toString(16).toUpperCase()} n=${n} ratio=${(n / (total / 1e6)).toFixed(3)}/Mch`)
    if (++shown >= 30) break
}
const sumPool = pool.reduce((a, p) => a + (hist.get(p) ?? 0), 0)
console.log(`SUM freq current 5: ${sumPool} (${(sumPool / (total / 1e6)).toFixed(2)}/Mch)`)
