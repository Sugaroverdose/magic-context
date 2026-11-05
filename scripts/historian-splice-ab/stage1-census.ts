/**
 * STAGE 1 — impact census. Builds historian chunks for every eligible session
 * window from the real host DB with BOTH production arms and classifies diffs.
 * No model calls. Output: artifacts/census/census.json + console summary.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadArms } from "./arms";
import { censusSessions } from "./db";
import { fitSessionWindow, requestedChunkTokensFor } from "./fit";
import { diffChunkText, type DiffClass, type WindowDiff } from "./classify";
import { ARTIFACTS_DIR, STATION_MODEL_KEY, HISTORIAN_SAMPLING } from "./paths";

interface WindowRecord {
    sessionId: string;
    offset: number;
    endBase: number;
    endSan: number;
    diff: WindowDiff;
}

async function main() {
    const arms = await loadArms();
    const limit = Number(process.argv[2] ?? 0); let sessions = censusSessions(40); if (limit) sessions = sessions.slice(0, limit);
    console.log(`census sessions (raw>=40): ${sessions.length}, total raw messages: ${sessions.reduce((s, x) => s + x.raw_count, 0)}`);
    const requested = await requestedChunkTokensFor(STATION_MODEL_KEY);
    console.log(`requested chunkTokens (local estimate): ${requested}`);

    const records: WindowRecord[] = [];
    let done = 0;
    for (const s of sessions) {
        done++;
        const fit = await fitSessionWindow({
            sessionId: s.id,
            directory: s.directory,
            chunkStart: 1,
            lastOrdinal: s.raw_count,
            modelKey: STATION_MODEL_KEY,
            maxOutputTokens: HISTORIAN_SAMPLING.max_tokens,
        });
        const budget = fit.chunkTokens;
        let offset = 1;
        let windows = 0;
        while (offset <= s.raw_count && windows < 60) {
            const base = arms.unsanitized.readSessionChunk(s.id, budget, offset, s.raw_count + 1, {});
            if (!base.text || base.messageCount === 0) break;
            const san = arms.sanitized.readSessionChunk(s.id, budget, offset, base.endIndex + 1, {});
            records.push({
                sessionId: s.id,
                offset,
                endBase: base.endIndex,
                endSan: san.endIndex,
                diff: diffChunkText(base.text ?? "", san.text ?? ""),
            });
            offset = base.endIndex + 1;
            windows++;
        }
        if (done % 10 === 0) console.log(`  ${done}/${sessions.length} sessions, ${records.length} windows`);
    }

    const totals: Record<string, number> = {
        sessions: sessions.length,
        windows: records.length,
        linesBase: 0,
        identicalLines: 0,
        diffLines: 0,
    };
    const classTotals: Partial<Record<DiffClass, number>> = {};
    for (const r of records) {
        totals.linesBase += r.diff.linesBase;
        totals.identicalLines += r.diff.identicalLines;
        totals.diffLines += r.diff.diffLines;
        for (const [k, v] of Object.entries(r.diff.classes))
            classTotals[k as DiffClass] = (classTotals[k as DiffClass] ?? 0) + (v ?? 0);
    }
    const dir = join(ARTIFACTS_DIR, "census");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "census.json"), JSON.stringify({ totals, classTotals, records }, null, 2));
    console.log("TOTALS", JSON.stringify(totals));
    console.log("CLASSES", JSON.stringify(classTotals));
    const top = [...records]
        .filter((r) => r.diff.diffLines > 0)
        .sort((a, b) => b.diff.diffLines - a.diff.diffLines)
        .slice(0, 15);
    console.log("TOP WINDOWS:");
    for (const t of top)
        console.log(`  ${t.sessionId} ${t.offset}-${t.endBase} diff=${t.diff.diffLines} classes=${JSON.stringify(t.diff.classes)}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
