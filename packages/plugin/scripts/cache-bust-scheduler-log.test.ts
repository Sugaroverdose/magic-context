import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeOpenCodeCacheBustSession } from "./analyze-cache-busts";
import { nearestCacheBustDecision, type CacheBustDecisionAttribution } from "./cache-bust-attribution";
import { runSentinelOnce } from "./cache-bust-sentinel";
import { schedulerLogDecisions, withSchedulerLogFallback } from "./cache-bust-scheduler-log";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const session = "ses_ckios";
const aTime = Date.parse("2026-09-20T12:48:01.103Z");
const bTime = Date.parse("2026-09-20T12:48:26.943Z");
const log = `[2026-09-20T12:47:52.749Z] [magic-context][${session}] transform scheduler: percentage=75.2% inputTokens=655813 cacheTtl=never lastResponseTime=1789908472447 decision=execute
[2026-09-20T12:48:20.605Z] [magic-context][${session}] transform scheduler: percentage=50.8% inputTokens=443412 cacheTtl=never lastResponseTime=1789908499627 decision=defer
`;
const execute: CacheBustDecisionAttribution = { timestampMs: Date.parse("2026-09-20T12:47:54.609Z"), decision: "execute", materialized: true, materializeReason: "pressure_refold", emergency: false, droppedTokens: 100, droppedCount: 366, inputTokens: 655813, flush: false, source: "transform_decisions" };
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), "scheduler-attribution-")); dirs.push(dir);
    const logPath = join(dir, "mc.log"); writeFileSync(logPath, log);
    for (const [index, timestamp] of [aTime, bTime].entries()) {
        const stem = `${new Date(timestamp).toISOString().replaceAll(":", "-").replace(".", "-")}-00000${index}-${session}`;
        const messages = [{ role: "user", content: [{ type: "text", text: "[Compacted by magic-context — session history is managed by the plugin]" }] }, { role: "assistant", content: [{ type: "text", text: index ? "rewritten tail" : "old tail", cache_control: { type: "ephemeral" } }] }];
        writeFileSync(join(dir, `${stem}.meta.json`), JSON.stringify({ session, createdAt: new Date(timestamp).toISOString() }));
        writeFileSync(join(dir, `${stem}.body.json`), JSON.stringify({ system: [{ type: "text", text: `x-anthropic-billing-header: attempt=${index}` }], messages }));
        writeFileSync(join(dir, `${stem}.response.json`), JSON.stringify({ status: 200, usage: { input_tokens: 2, cache_read_input_tokens: index ? 255750 : 443410, cache_creation_input_tokens: index ? 189320 : 0 } }));
    }
    return { dir, logPath };
}

test("scheduler fallback keeps the priced row and joins the later defer six seconds before B", () => {
    const { logPath } = fixture();
    const decisions = withSchedulerLogFallback([execute], session, logPath);
    expect(decisions).toHaveLength(2);
    expect(nearestCacheBustDecision(decisions, aTime)).toEqual(execute);
    expect(nearestCacheBustDecision(decisions, bTime)?.decision).toBe("defer");
    expect(schedulerLogDecisions(log, "ses_other")).toEqual([]);
    expect(schedulerLogDecisions(log.replaceAll("2026-09-20T", "invalid"), session)).toEqual([]);
    expect(withSchedulerLogFallback([execute], session, `${logPath}.missing`)).toEqual([execute]);
});

test("analyzer and sentinel discriminate unaccounted_defer_pass from no_mc_pass_row", async () => {
    const { dir, logPath } = fixture();
    const options = { sessionId: session, anthropicDir: dir, openaiDir: join(dir, "missing"), decisions: [execute] };
    const without = analyzeOpenCodeCacheBustSession({ ...options, mcLogPath: null });
    expect(without.requests[1]?.divergenceClass).toBe("no_mc_pass_row");
    const withLog = analyzeOpenCodeCacheBustSession({ ...options, mcLogPath: logPath });
    expect(withLog.requests[1]?.divergenceClass).toBe("unaccounted_defer_pass");
    const events: string[] = [];
    await runSentinelOnce({ once: true, send: false, intervalMs: 60000, lookbackMs: 120000, stateFile: join(dir, "state.json"), databasePath: join(dir, "absent.db"), rustStorePath: join(dir, "absent-rust.db"), connectionFile: join(dir, "absent.json"), wakeModuleId: "prefrontal", anthropicDir: dir, openaiDir: join(dir, "missing"), mcLogPath: logPath }, {
        now: () => bTime + 1000,
        listActiveSessions: () => [{ sessionId: session, harness: "opencode", projectPath: "fixture", directory: dir, activityMs: bTime }],
        loadDecisions: () => [execute], stdout: line => events.push(line),
    });
    expect(events.some(line => line.includes('"divergence_class":"unaccounted_defer_pass"'))).toBe(true);
    expect(events.some(line => line.includes('"divergence_class":"no_mc_pass_row"'))).toBe(false);
});
