import { Database } from "bun:sqlite"
import { deriveKey, renderDropToken } from "../packages/plugin/src/hooks/magic-context/fpe.ts"

const db = new Database(`${process.env.HOME}/.local/share/cortexkit/magic-context/context.db`, { readonly: true })
const sessionId = process.argv[2]
if (!sessionId) throw new Error("usage: fpe-pool12-cost.ts <session-id>")
const key = deriveKey(sessionId)
const tags = [1, 500, 2000, 19820]
const renders = tags.map((t) => renderDropToken(t, key))
for (const r of renders) console.log(`len=${r.length} chars`)

const POST = async (prompt: string): Promise<number> => {
    const res = await fetch("http://127.0.0.1:8091/v1/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, max_tokens: 1, n: 1 }),
    })
    const j = (await res.json()) as { usage?: { prompt_tokens: number } }
    return j.usage?.prompt_tokens ?? -1
}
const base = await POST("x")
console.log(`baseline x=${base}`)
for (const [i, r] of renders.entries()) {
    const a = await POST(`x ${r}`)
    const b = await POST("x")
    console.log(`tag ${tags[i]}: ${a - b} tokens for ${r.length} chars`)
}
