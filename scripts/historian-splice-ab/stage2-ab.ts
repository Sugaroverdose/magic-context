/**
 * STAGE 2 — real-window A/B with real historian model calls.
 * Windows come from artifacts/census/census.json (top affected windows per
 * fired class + clean controls). Arms: unsanitized x2 (within-arm control
 * pair) and sanitized x1. All arms get byte-identical auxiliary blocks; only
 * the chunk (production builder per arm) and the arm's own prompt builder vary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadArms } from "./arms";
import { fitSessionWindow } from "./fit";
import { callHistorian, responseText } from "./model";
import { ARTIFACTS_DIR, censusJsonPath } from "./paths";
import { openHostDbRo } from "./db";

interface CensusRecord {
    sessionId: string;
    offset: number;
    endBase: number;
    diff: { linesBase: number; diffLines: number; classes: Record<string, number> };
}

const REQUIRED_CLASSES = [
    "keyArg-fold",
    "text-fold",
    "per-part-commits",
    "tc-hash-preservation",
    "tc-compaction-bypass",
    "defang-envelope",
    "defang-marker",
    "defang-media",
];

function selectWindows(records: CensusRecord[]): { affected: CensusRecord[]; clean: CensusRecord[] } {
    const affected: CensusRecord[] = [];
    const seen = new Set<string>();
    const push = (r: CensusRecord) => {
        const k = `${r.sessionId}:${r.offset}`;
        if (!seen.has(k)) {
            seen.add(k);
            affected.push(r);
        }
    };
    for (const cls of REQUIRED_CLASSES) {
        const withCls = records
            .filter((r) => (r.diff.classes[cls] ?? 0) > 0)
            .sort((a, b) => b.diff.diffLines - a.diff.diffLines);
        if (withCls[0]) push(withCls[0]);
    }
    const top = [...records]
        .filter((r) => r.diff.diffLines > 0)
        .sort((a, b) => b.diff.diffLines - a.diff.diffLines);
    for (const r of top) {
        if (affected.length >= 9) break;
        push(r);
    }
    const clean = records
        .filter((r) => r.diff.diffLines === 0 && r.diff.linesBase >= 120 && !seen.has(`${r.sessionId}:${r.offset}`))
        .sort((a, b) => b.diff.linesBase - a.diff.linesBase)
        .slice(0, 3);
    return { affected, clean };
}

const FACT_PATTERNS: Array<[string, RegExp]> = [
    ["path", /(?:\/|\.\.\/)[A-Za-z0-9_@.\/-]{4,}/g],
    ["backtick", /`[^`\n]{3,80}`/g],
    ["hex", /\b[0-9a-f]{7,40}\b/g],
    ["quoted", /"[^"\n]{10,120}"/g],
    ["number", /\b\d[\d,.]{2,}(?:%|[KMB]|\.\d+)?\b/g],
];

export function extractFacts(text: string): Map<string, string> {
    const facts = new Map<string, string>();
    for (const [kind, re] of FACT_PATTERNS) {
        for (const m of text.matchAll(re)) {
            const v = m[0].trim();
            if (v.length < 4) continue;
            facts.set(`${kind}:${v.toLowerCase()}`, v);
        }
    }
    return facts;
}

function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function wordCounts(s: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const w of norm(s).split(/[^a-z0-9_./:@#$-]+/).filter(Boolean)) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
}

/** Word-multiset cosine similarity over normalized summary text. */
function similarity(a: string, b: string): number {
    const ca = wordCounts(a);
    const cb = wordCounts(b);
    let dot = 0;
    for (const [w, n] of ca) dot += n * (cb.get(w) ?? 0);
    let na = 0;
    for (const n of ca.values()) na += n * n;
    let nb = 0;
    for (const n of cb.values()) nb += n * n;
    return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function fabricatedMarkers(summary: string): string[] {
    return [...summary.matchAll(/\[\d+(?:-\d+)?\]\s*(?:U|A):/g)].map((m) => m[0]);
}

async function main() {
    const limit = Number(process.argv[2] ?? 0);
    const arms = await loadArms();
    const census = JSON.parse(readFileSync(censusJsonPath(ARTIFACTS_DIR), "utf8")) as { records: CensusRecord[] };
    const { affected, clean } = selectWindows(census.records);
    const selected = [...affected.slice(0, limit || 99), ...clean];
    console.log(`selected ${selected.length} windows (${affected.length} affected, ${clean.length} clean)`);

    const host = openHostDbRo();
    const dirs = new Map<string, string>();
    for (const row of host.query(`SELECT id, directory FROM session`).all() as Array<{ id: string; directory: string }>)
        dirs.set(row.id, row.directory);
    host.close();

    const outDir = join(ARTIFACTS_DIR, "stage2");
    mkdirSync(outDir, { recursive: true });
    const results: unknown[] = [];
    for (const w of selected) {
        const tag = `${w.sessionId}-${w.offset}-${w.endBase}`;
        const directory = dirs.get(w.sessionId) ?? process.cwd();
        const fit = await fitSessionWindow({
            sessionId: w.sessionId,
            directory,
            chunkStart: w.offset,
            lastOrdinal: w.endBase,
            modelKey: "station/qwen3.8-flash-next",
            maxOutputTokens: 16384,
        });
        const summaries: Record<string, string> = {};
        const chunkHashes: Record<string, string> = {};
        const callTimes: Record<string, string> = {};
        const chunkTexts: Record<string, string> = {};
        for (const run of [1, 2]) {
            const arm = arms.unsanitized;
            const chunk = arm.readSessionChunk(w.sessionId, fit.chunkTokens, w.offset, w.endBase + 1, {});
            const prompt = arm.buildCompartmentAgentPrompt({
                seedExamples: fit.seedExamples,
                sessionReferences: fit.sessionReferences,
                projectMemory: fit.projectMemory,
                inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
                memoryEnabled: true,
            });
            const rec = await callHistorian({ arm: "unsanitized", tag, variant: `r${run}`, system: arm.COMPARTMENT_AGENT_SYSTEM_PROMPT, prompt });
            summaries[`unsanitized-r${run}`] = responseText(rec);
            chunkHashes[`unsanitized-r${run}`] = `${rec.hash}@r${run}`;
            callTimes[`unsanitized-r${run}`] = rec.meta.createdAt;
            chunkTexts.unsanitized = chunk.text;
        }
        {
            const arm = arms.sanitized;
            const chunk = arm.readSessionChunk(w.sessionId, fit.chunkTokens, w.offset, w.endBase + 1, {});
            const prompt = arm.buildCompartmentAgentPrompt({
                seedExamples: fit.seedExamples,
                sessionReferences: fit.sessionReferences,
                projectMemory: fit.projectMemory,
                inputSource: `Messages ${chunk.startIndex}-${chunk.endIndex}:\n\n${chunk.text}`,
                memoryEnabled: true,
            });
            const rec = await callHistorian({ arm: "sanitized", tag, variant: "r1", system: arm.COMPARTMENT_AGENT_SYSTEM_PROMPT, prompt });
            summaries.sanitized = responseText(rec);
            chunkHashes.sanitized = `${rec.hash}@r1`;
            callTimes.sanitized = rec.meta.createdAt;
            chunkTexts.sanitized = chunk.text;
        }
        const controlDrift = similarity(summaries["unsanitized-r1"], summaries["unsanitized-r2"]);
        const crossDrift1 = similarity(summaries["unsanitized-r1"], summaries.sanitized);
        const crossDrift2 = similarity(summaries["unsanitized-r2"], summaries.sanitized);
        // Deterministic chunk-level fact equivalence (PASS-3 ground truth): a
        // fact present in the base chunk but absent from the sanitized chunk
        // even after whitespace-fold + defang-char normalization is REAL loss
        // (no model noise involved).
        const foldFacts = (s: string) => norm(s.replace(/\\/g, ""));
        const baseChunkFacts = extractFacts(chunkTexts.unsanitized ?? "");
        const sanChunkNorm = foldFacts(chunkTexts.sanitized ?? "");
        const chunkLost: string[] = [];
        for (const [, v] of baseChunkFacts) if (!sanChunkNorm.includes(foldFacts(v))) chunkLost.push(v);
        // Summary-level: real loss requires presence in BOTH control runs
        // (facts that only one unsanitized run mentioned are model noise).
        const fUnsan1 = extractFacts(summaries["unsanitized-r1"]);
        const fUnsan2 = extractFacts(summaries["unsanitized-r2"]);
        const fSan = extractFacts(summaries.sanitized);
        const sanNorm = foldFacts(summaries.sanitized);
        const unsan1Norm = foldFacts(summaries["unsanitized-r1"]);
        const unsan2Norm = foldFacts(summaries["unsanitized-r2"]);
        const lostBySan: string[] = [];
        const noiseOnly: string[] = [];
        const gainedBySan: string[] = [];
        for (const [, v] of fUnsan1) {
            const inR2 = unsan2Norm.includes(foldFacts(v));
            const inSan = sanNorm.includes(foldFacts(v));
            if (!inSan && inR2) lostBySan.push(v);
            if (!inR2) noiseOnly.push(v);
        }
        for (const [, v] of fSan) if (!unsan1Norm.includes(foldFacts(v)) && !unsan2Norm.includes(foldFacts(v))) gainedBySan.push(v);
        const row = {
            window: tag,
            classes: w.diff.classes,
            diffLines: w.diff.diffLines,
            chunkHashes,
            callTimes,
            markers: {
                unsanitized: fabricatedMarkers(summaries["unsanitized-r1"]).length,
                sanitized: fabricatedMarkers(summaries.sanitized).length,
            },
            drift: { withinArmControl: controlDrift, cross1: crossDrift1, cross2: crossDrift2 },
            chunkFactAudit: { baseFacts: baseChunkFacts.size, lostCount: chunkLost.length, lost: chunkLost.slice(0, 20) },
            summaryFactAudit: {
                unsanCount: fUnsan1.size,
                sanCount: fSan.size,
                lostBySan: lostBySan.slice(0, 40),
                lostCount: lostBySan.length,
                modelNoiseFloor: noiseOnly.length,
                gainedBySan: gainedBySan.slice(0, 40),
                gainedCount: gainedBySan.length,
            },
        };
        results.push(row);
        console.log(
            `window ${tag} control=${controlDrift.toFixed(3)} cross=${crossDrift1.toFixed(3)}/${crossDrift2.toFixed(3)} markers ${row.markers.unsanitized}/${row.markers.sanitized} lost=${lostBySan.length} gained=${gainedBySan.length}`,
        );
        writeFileSync(join(outDir, "analysis.json"), JSON.stringify(results, null, 2));
    }
    writeFileSync(join(outDir, "analysis.json"), JSON.stringify(results, null, 2));
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
