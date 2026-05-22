import type { Database } from "../../shared/sqlite";

export interface WorkMetrics {
    newWorkTokens: number;
    totalInputTokens: number;
}

export interface PiSessionEntry {
    role?: unknown;
    usage?: unknown;
    message?: unknown;
}

interface WorkMetricsRow {
    new_work_tokens?: number | null;
    total_input_tokens?: number | null;
}

interface PiUsage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
}

const OPEN_CODE_WORK_METRICS_SQL = `
WITH ordered AS (
  SELECT
    json_extract(data, '$.agent') AS agent,
    time_created,
    COALESCE(json_extract(data, '$.tokens.input'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.write'), 0) AS cur_prompt,
    COALESCE(json_extract(data, '$.tokens.output'), 0) AS cur_output,
    LAG(
      COALESCE(json_extract(data, '$.tokens.input'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.read'), 0)
      + COALESCE(json_extract(data, '$.tokens.cache.write'), 0),
      1, 0
    ) OVER (PARTITION BY json_extract(data, '$.agent') ORDER BY time_created) AS prev_prompt
  FROM message
  WHERE session_id = ?
    AND json_extract(data, '$.role') = 'assistant'
    AND data IS NOT NULL
),
deltas AS (
  SELECT agent, MAX(0, cur_prompt - prev_prompt) AS delta, cur_output,
         ROW_NUMBER() OVER (PARTITION BY agent ORDER BY time_created DESC) AS rn
  FROM ordered
),
flagged AS (
  SELECT
    agent, cur_prompt, prev_prompt, time_created,
    SUM(CASE WHEN cur_prompt < prev_prompt THEN 1 ELSE 0 END)
      OVER (PARTITION BY agent ORDER BY time_created
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS phase_id
  FROM ordered
),
phase_peaks AS (
  SELECT agent, phase_id, MAX(cur_prompt) AS phase_peak
  FROM flagged
  WHERE prev_prompt > 0 OR phase_id = 0
  GROUP BY agent, phase_id
),
metric_a AS (
  SELECT COALESCE(SUM(delta), 0)
       + COALESCE(SUM(CASE WHEN rn = 1 THEN cur_output ELSE 0 END), 0) AS new_work
  FROM deltas
),
metric_b AS (
  SELECT COALESCE(SUM(phase_peak), 0) AS total_input FROM phase_peaks
)
SELECT metric_a.new_work AS new_work_tokens,
       metric_b.total_input AS total_input_tokens
FROM metric_a, metric_b`;

function asNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getPiUsage(entry: unknown): PiUsage | null {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    const message =
        record.message && typeof record.message === "object"
            ? (record.message as Record<string, unknown>)
            : record;
    if (message.role !== "assistant") return null;
    if (!message.usage || typeof message.usage !== "object") return null;
    const usage = message.usage as Record<string, unknown>;
    return {
        input: asNumber(usage.input),
        output: asNumber(usage.output),
        cacheRead: asNumber(usage.cacheRead ?? usage.cache_read),
        cacheWrite: asNumber(usage.cacheWrite ?? usage.cache_write),
    };
}

export function computeOpenCodeWorkMetrics(openCodeDb: Database, sessionId: string): WorkMetrics {
    const row = openCodeDb
        .prepare(OPEN_CODE_WORK_METRICS_SQL)
        .get(sessionId) as WorkMetricsRow | null;
    return {
        newWorkTokens: Math.max(0, Math.floor(row?.new_work_tokens ?? 0)),
        totalInputTokens: Math.max(0, Math.floor(row?.total_input_tokens ?? 0)),
    };
}

export function computePiWorkMetrics(sessionEntries: PiSessionEntry[] | unknown[]): WorkMetrics {
    let previousPrompt = 0;
    let phasePeak = 0;
    let newWorkTokens = 0;
    let totalInputTokens = 0;
    let lastOutput = 0;
    let sawAssistant = false;

    for (const entry of sessionEntries) {
        const usage = getPiUsage(entry);
        if (!usage) continue;
        const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
        if (sawAssistant && prompt < previousPrompt) {
            totalInputTokens += phasePeak;
            phasePeak = prompt;
        } else {
            phasePeak = Math.max(phasePeak, prompt);
        }
        newWorkTokens += Math.max(0, prompt - previousPrompt);
        previousPrompt = prompt;
        lastOutput = usage.output;
        sawAssistant = true;
    }

    if (sawAssistant) {
        totalInputTokens += phasePeak;
        newWorkTokens += lastOutput;
    }

    return { newWorkTokens, totalInputTokens };
}
