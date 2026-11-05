import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ARTIFACTS_DIR, STATION_BASE_URL, STATION_MODEL, HISTORIAN_SAMPLING } from "./paths";

const AUTH = join(process.env.HOME ?? "", ".local/share/opencode/auth.json");

function stationKey(): string {
    const auth = JSON.parse(readFileSync(AUTH, "utf8"));
    const entry = auth.station;
    if (!entry || entry.type !== "api" || !entry.key) throw new Error("station api key not found");
    return entry.key;
}

export interface CallRecord {
    hash: string;
    request: { model: string; messages: Array<{ role: string; content: string }>; temperature: number; top_p: number; max_tokens: number };
    response: unknown;
    meta: { arm: string; tag: string; variant?: string; createdAt: string; usage?: unknown; cached?: boolean };
}

export function callHash(req: CallRecord["request"]): string {
    return createHash("sha256").update(JSON.stringify(req)).digest("hex").slice(0, 32);
}

/** Content-hash idempotent historian call. Full prompt + response persisted under artifacts/calls/.
 * `variant` lets the SAME prompt be sampled more than once (within-arm control
 * pair): responses are stored per (hash, variant), so r1 and r2 are genuinely
 * independent model calls while the prompt artifact stays deduped by hash. */
export async function callHistorian(args: {
    arm: string;
    tag: string;
    system: string;
    prompt: string;
    variant?: string;
}): Promise<CallRecord> {
    const request: CallRecord["request"] = {
        model: STATION_MODEL,
        messages: [
            { role: "system", content: args.system },
            { role: "user", content: args.prompt },
        ],
        temperature: HISTORIAN_SAMPLING.temperature,
        top_p: HISTORIAN_SAMPLING.top_p,
        max_tokens: HISTORIAN_SAMPLING.max_tokens,
    };
    const hash = callHash(request);
    const dir = join(ARTIFACTS_DIR, "calls", hash);
    const suffix = args.variant ? `-${args.variant}` : "";
    const resFile = join(dir, `response${suffix}.json`);
    const recFile = join(dir, `record${suffix}.json`);
    if (existsSync(resFile)) {
        const rec: CallRecord = JSON.parse(readFileSync(recFile, "utf8"));
        rec.meta.cached = true;
        return rec;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "request.json"), JSON.stringify(request, null, 2));
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(`${STATION_BASE_URL}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${stationKey()}` },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(600_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`);
            const response = await res.json();
            const rec: CallRecord = {
                hash,
                request,
                response,
                meta: {
                    arm: args.arm,
                    tag: args.tag,
                    variant: args.variant,
                    createdAt: new Date().toISOString(),
                    usage: (response as { usage?: unknown }).usage,
                },
            };
            writeFileSync(resFile, JSON.stringify(response, null, 2));
            writeFileSync(recFile, JSON.stringify(rec, null, 2));
            return rec;
        } catch (e) {
            lastError = e;
            await new Promise((r) => setTimeout(r, 30_000));
        }
    }
    writeFileSync(join(dir, `error${suffix}.json`), JSON.stringify({ error: String(lastError), meta: { arm: args.arm, tag: args.tag } }, null, 2));
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function responseText(rec: CallRecord): string {
    const r = rec.response as { choices?: Array<{ message?: { content?: string } }> };
    return r.choices?.[0]?.message?.content ?? "";
}
