/**
 * STAGE 1b — wire-protocol exposure scan. For the same census windows, count
 * lines in the UNSANITIZED chunk that violate the one-line-per-block wire
 * protocol (lines not starting with [N] / [N-M]) and marker-shaped fake turn
 * lines. This measures the real-data exposure the splice sanitizer closes.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadArms } from "./arms";
import { censusSessions, openHostDbRo } from "./db";
import { fitSessionWindow } from "./fit";
import { ARTIFACTS_DIR, STATION_MODEL_KEY } from "./paths";

const BLOCK_LINE = /^\[(\d+(?:-\d+)?)\]\s+(U|A|TC|M):/;

async function main() {
    const arms = await loadArms();
    const sessions = censusSessions(40);
    let brokenBase = 0;
    let brokenSan = 0;
    let markerShapedBase = 0;
    let markerShapedSan = 0;
    const examples: unknown[] = [];
    for (const s of sessions) {
        const fit = await fitSessionWindow({
            sessionId: s.id,
            directory: s.directory,
            chunkStart: 1,
            lastOrdinal: s.raw_count,
            modelKey: STATION_MODEL_KEY,
            maxOutputTokens: 16384,
        });
        let offset = 1;
        let windows = 0;
        while (offset <= s.raw_count && windows < 60) {
            const base = arms.unsanitized.readSessionChunk(s.id, fit.chunkTokens, offset, s.raw_count + 1, {});
            if (!base.text || base.messageCount === 0) break;
            const san = arms.sanitized.readSessionChunk(s.id, fit.chunkTokens, offset, base.endIndex + 1, {});
            const bl = base.text.split("\n");
            const sl = (san.text ?? "").split("\n");
            const bBroken = bl.filter((l) => !BLOCK_LINE.test(l));
            const sBroken = sl.filter((l) => !BLOCK_LINE.test(l));
            brokenBase += bBroken.length;
            brokenSan += sBroken.length;
            const bMarker = bl.filter((l) => /^\[\d+(?:-\d+)?\]\s+(U|A):/.test(l) === false && /\] (U|A):/.test(l));
            markerShapedBase += bMarker.length;
            markerShapedSan += sl.filter((l) => /\] (U|A)\\?:/.test(l) && !/^\[\d+(?:-\d+)?\]\s+(U|A):/.test(l)).length;
            if (bBroken.length && examples.length < 10)
                examples.push({ session: s.id, offset, sample: bBroken.slice(0, 3).map((x) => x.slice(0, 200)) });
            offset = base.endIndex + 1;
            windows++;
        }
    }
    const out = { brokenBase, brokenSan, markerShapedBase, markerShapedSan, examples };
    mkdirSync(join(ARTIFACTS_DIR, "census"), { recursive: true });
    writeFileSync(join(ARTIFACTS_DIR, "census", "wire-exposure.json"), JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ brokenBase, brokenSan, markerShapedBase, markerShapedSan }, null, 2));
    for (const e of examples as Array<{ session: string; offset: number; sample: string[] }>)
        console.log(e.session, e.offset, JSON.stringify(e.sample).slice(0, 300));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
