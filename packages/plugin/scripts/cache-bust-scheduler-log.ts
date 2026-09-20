import { readFileSync } from "node:fs";
import { getMagicContextLogPath } from "../src/shared/data-path";
import type { CacheBustDecisionAttribution } from "./cache-bust-attribution";

/** Scheduler lines cover TS defers that have no durable transform_decisions row. */
export function schedulerLogDecisions(text: string, sessionId: string): CacheBustDecisionAttribution[] {
    const decisions: CacheBustDecisionAttribution[] = [];
    for (const line of text.split("\n")) {
        const match = /^\[([^\]]+)\] \[magic-context\]\[([^\]]+)\] transform scheduler: .*\binputTokens=(\d+)\b.*\bdecision=(execute|defer)\b/.exec(line);
        if (!match || match[2] !== sessionId) continue;
        const timestampMs = Date.parse(match[1]);
        if (!Number.isFinite(timestampMs)) continue;
        decisions.push({ timestampMs, decision: match[4], materialized: false, materializeReason: null,
            emergency: false, droppedTokens: 0, droppedCount: 0, inputTokens: Number(match[3]), flush: false,
            source: "transform scheduler log" });
    }
    return decisions.sort((a, b) => a.timestampMs - b.timestampMs);
}

export function withSchedulerLogFallback(
    decisions: readonly CacheBustDecisionAttribution[],
    sessionId: string,
    logPath: string | null = getMagicContextLogPath("opencode"),
): CacheBustDecisionAttribution[] {
    if (logPath === null) return [...decisions];
    let text: string;
    try { text = readFileSync(logPath, "utf8"); }
    catch { return [...decisions]; }
    const logged = schedulerLogDecisions(text, sessionId);
    const fallback = logged.filter((pass, index) => {
        // A completed row is richer evidence than its scheduler line. Do not let
        // a previous pass's row hide a later defer, even inside the join window.
        const next = logged[index + 1]?.timestampMs ?? Number.POSITIVE_INFINITY;
        return !decisions.some(row => row.timestampMs >= pass.timestampMs && row.timestampMs < next && row.timestampMs - pass.timestampMs <= 30_000);
    });
    return [...decisions, ...fallback];
}
