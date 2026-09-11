/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiTestHarness } from "../src/pi-harness";
import { buildMockHistorianPayload } from "../src/mock-historian";

/**
 * Pi short-context overflow survival guard.
 *
 * # Why this test is structured the way it is
 *
 * OpenCode's equivalent test (short-context-overflow.test.ts) verifies that
 * heuristic cleanup drops tags under 85% force-materialization. The drops it
 * counts are message-type tags created when OpenCode strips
 * `<system-reminder>`-wrapped user prompts that OpenCode injects on every
 * turn. Pi RPC mode does NOT wrap user prompts in system-reminders, so a
 * pure-text Pi session simply has no message tags to drop — Pi's heuristic
 * cleanup correctly drops only `type='tool'` tags, and tool tags only exist
 * when the agent actually invokes tools.
 *
 * Building a Pi e2e that exercises tool drops requires the agent loop to
 * actually run a tool, await its result, and continue — which Pi's RPC
 * `prompt` command serializes per session (a follow-up `prompt` while the
 * agent is mid-tool-execution returns "Agent is already processing").
 *
 * What this test verifies:
 *   - Pi survives 30 back-to-back 20KB-reply turns with a slow historian
 *   - Pi telemetry reaches the derived 85% force band while the historian is busy
 *   - The scheduler queues force-band drops and usage falls
 *   - No turns error out and every provider request remains below the model window
 *
 * Queued drop materialization is covered by `pi-drops.test.ts`; the completed
 * tool-output force episode is covered separately below. Pi historian publication is covered by
 * `pi-historian-success.test.ts`, and Pi compaction-marker writing (the
 * X1 fix) is covered by `pi-deferred-compaction-marker.test.ts`. The
 * production wire dump from the user's stuck Anthropic Auth session
 * confirmed the X1/X2 fix in `55ebb14` resolves the actual tool-tag
 * accumulation symptom that prevented JSONL trimming.
 */

const HISTORIAN_MARKER = "the hippocampus of a long-running coding agent";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    if (sys === undefined || sys === null) return false;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    const filler = "abcdefghij0123456789".repeat(200);
    const reps = Math.max(1, Math.floor(targetBytes / filler.length));
    return header + filler.repeat(reps);
}

let h: PiTestHarness;

beforeAll(async () => {
    h = await PiTestHarness.create({
        modelContextLimit: 128_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            historian: { model: "anthropic/claude-haiku-4-5" },
            dreamer: { disable: true, model: "anthropic/claude-haiku-4-5" },
            memory: { auto_search: { enabled: false }, git_commit_indexing: { enabled: false } },
            embedding: { provider: "off" },
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

describe("pi short context accumulating overflow", () => {
    it("emergency bypass keeps a 128K Pi session under 100% with slow historian", async () => {
        h.mock.reset();

        h.mock.addMatcher((body) => {
            if (!isHistorian(body)) return null;
            const msgs = body.messages as Array<{ content?: unknown }> | undefined;
            const flat = JSON.stringify(msgs ?? []);
            const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
            const start = rangeHdr ? Number(rangeHdr[1]) : 0;
            const end = rangeHdr ? Number(rangeHdr[2]) : 0;
            return {
                text: buildMockHistorianPayload({
                    start,
                    end,
                    title: "Pi build-up",
                    body: "Summary.",
                }),
                usage: {
                    input_tokens: 500,
                    output_tokens: 50,
                    cache_creation_input_tokens: 500,
                    cache_read_input_tokens: 0,
                },
                delayMs: 3_000,
            };
        });

        // Plain text matcher. See header comment for why this test
        // doesn't try to exercise tool drops in Pi RPC mode.
        let mainCalls = 0;
        h.mock.addMatcher((body) => {
            if (isHistorian(body)) return null;
            mainCalls++;
            const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
            const reply = bigReplyText(mainCalls, 20_000);
            return {
                text: reply,
                usage: {
                    input_tokens: approxInputTokens,
                    output_tokens: Math.floor(reply.length / 4),
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            };
        });

        let sessionId: string | null = null;
        const turnUsage: number[] = [];
        const schedulerUsage: number[] = [];
        const historianInProgress: number[] = [];
        const turnErrors: Array<{ turn: number; error: string }> = [];
        const turns = 30;

        for (let i = 1; i <= turns; i++) {
            const reqBefore = h.mock.requests().length;
            try {
                const turn = await h.sendPrompt(`user turn ${i}: continue.`, {
                    timeoutMs: 60_000,
                    continueSession: true,
                });
                sessionId = sessionId ?? turn.sessionId;
            } catch (err) {
                turnErrors.push({
                    turn: i,
                    error: err instanceof Error ? err.message : String(err),
                });
                const state = await h.getState().catch(() => null);
                if (state && typeof state.sessionId === "string") sessionId = sessionId ?? state.sessionId;
            }
            const reqs = h.mock.requests().slice(reqBefore);
            const mainReq = reqs.find((r) => !isHistorian(r.body) &&
                JSON.stringify(r.body.messages).includes(`user turn ${i}: continue.`));
            if (!mainReq) turnErrors.push({ turn: i, error: "No mock provider request for submitted user turn" });
            const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
            turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
            if (sessionId) {
                const meta = h
                    .contextDb()
                    .prepare(
                        "SELECT last_context_percentage, compartment_in_progress FROM session_meta WHERE session_id = ?",
                    )
                    .get(sessionId) as
                    | {
                          last_context_percentage: number;
                          compartment_in_progress: number;
                      }
                    | undefined;
                if (!meta) throw new Error(`missing Pi session metadata for ${sessionId}`);
                schedulerUsage.push(Math.round(meta.last_context_percentage * 10) / 10);
                historianInProgress.push(meta.compartment_in_progress);
            }
        }

        const historianRequests = h.mock.requests().filter((r) => isHistorian(r.body));
        const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
        const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
        const forceBandSeen = schedulerUsage.some((usage) => usage >= 85);
        const historianBusyAtForceBand = schedulerUsage.some(
            (usage, index) => usage >= 85 && historianInProgress[index] === 1,
        );
        const forceDropDecision = h
            .contextDb()
            .prepare(
                "SELECT 1 FROM transform_decisions WHERE session_id = ? AND input_tokens >= ? AND decision = 'execute' AND dropped_count > 0 LIMIT 1",
            )
            .get(sessionId!, 128_000 * 0.85);
        console.log(
            `[PI-OVERFLOW-GUARD] historians=${historianRequests.length} peak=${peakObservedPct}% final=${finalPct}% scheduler_peak=${Math.max(...schedulerUsage)}% force_band=${forceBandSeen} historian_busy=${historianBusyAtForceBand} force_drop=${Boolean(forceDropDecision)}`,
        );
        console.log(`[PI-OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
        if (turnErrors.length > 0) {
            console.log(
                `[PI-OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                turnErrors.map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`).join(" | "),
            );
        }

        expect(sessionId).toBeTruthy();
        expect(turnErrors).toEqual([]);
        expect(historianRequests.length).toBeGreaterThan(0);
        h.assertHistorianRequestsUseMock();
        expect(forceBandSeen).toBe(true);
        expect(historianBusyAtForceBand).toBe(true);
        expect(forceDropDecision).toBeTruthy();
        expect(peakObservedPct).toBeLessThan(100);
        expect(finalPct).toBeLessThan(peakObservedPct);

        // A published compartment proves that the delayed historian response was
        // valid; the force-band sample above proves cleanup did not wait for it.
        const compartmentCount = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS c FROM compartments WHERE session_id = ?")
            .get(sessionId!) as { c: number };
        const meta = h
            .contextDb()
            .prepare("SELECT last_context_percentage, last_input_tokens FROM session_meta WHERE session_id = ?")
            .get(sessionId!) as { last_context_percentage: number; last_input_tokens: number } | undefined;
        expect(compartmentCount.c).toBeGreaterThan(0);
        expect(meta?.last_context_percentage).toBeLessThan(100);
        expect(meta?.last_input_tokens).toBeGreaterThan(0);
    }, 240_000);

    it("arms the force episode after reclaiming a completed tool-output batch", async () => {
        const toolHarness = await PiTestHarness.create({
            modelContextLimit: 128_000,
            magicContextConfig: {
                execute_threshold_percentage: 40,
                protected_tokens: 4_000,
                dreamer: { disable: true },
            },
        });

        try {
            const outputPath = join(toolHarness.env.workdir, "force-episode-output.txt");
            writeFileSync(
                outputPath,
                Array.from(
                    { length: 2_000 },
                    (_, index) => `force episode tool output line ${index + 1}: ${"x".repeat(80)}`,
                ).join("\n"),
            );
            toolHarness.mock.reset();
            toolHarness.mock.addMatcher((body) => {
                if (!isHistorian(body)) return null;
                return {
                    text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 0,
                        cache_read_input_tokens: 0,
                    },
                };
            });

            const callId = "toolu_pi_force_episode_output";
            let mainStage = 0;
            toolHarness.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                if (mainStage === 0) {
                    if (!JSON.stringify(body.tools ?? []).includes('"name":"read"')) return null;
                    mainStage = 1;
                    return {
                        content: [
                            {
                                type: "tool_use",
                                id: callId,
                                name: "read",
                                input: { path: outputPath, offset: 1, limit: 2_000 },
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 1_000,
                            output_tokens: 20,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                    };
                }
                if (mainStage === 1 && JSON.stringify(body.messages ?? []).includes(callId)) {
                    mainStage = 2;
                    return {
                        text: "completed large tool output",
                        usage: {
                            input_tokens: 122_000,
                            output_tokens: 20,
                            cache_creation_input_tokens: 0,
                            cache_read_input_tokens: 0,
                        },
                    };
                }
                return null;
            });
            toolHarness.mock.setDefault({
                text: "after force reclaim",
                usage: {
                    input_tokens: 1_000,
                    output_tokens: 20,
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: 0,
                },
            });

            const first = await toolHarness.sendPrompt("read one large fixture file to completion", {
                timeoutMs: 120_000,
            });
            const sessionId = first.sessionId ?? "";
            expect(sessionId).toBeTruthy();
            await toolHarness.waitFor(
                () => {
                    const row = toolHarness
                        .contextDb()
                        .prepare("SELECT last_input_tokens FROM session_meta WHERE session_id = ?")
                        .get(sessionId) as { last_input_tokens: number } | null;
                    return (row?.last_input_tokens ?? 0) >= 122_000 ? true : null;
                },
                { timeoutMs: 30_000, label: "completed tool-output usage persisted" },
            );

            const toolTag = await toolHarness.waitFor(
                () => {
                    const row = toolHarness
                        .contextDb()
                        .prepare(
                            "SELECT tag_number FROM tags WHERE session_id = ? AND type = 'tool' ORDER BY tag_number ASC LIMIT 1",
                        )
                        .get(sessionId) as { tag_number: number } | null;
                    return (row?.tag_number ?? 0) > 0 ? row!.tag_number : null;
                },
                { timeoutMs: 30_000, label: "completed tool-output tag persisted" },
            );
            const requestStart = toolHarness.mock.requests().length;
            await toolHarness.sendPrompt("force reclaim the completed tool-output batch", {
                timeoutMs: 120_000,
                continueSession: true,
            });

            const meta = toolHarness
                .contextDb()
                .prepare("SELECT last_emergency_input_sample FROM session_meta WHERE session_id = ?")
                .get(sessionId) as { last_emergency_input_sample: number } | null;
            expect(meta?.last_emergency_input_sample ?? 0).toBeGreaterThan(0);
            expect(toolHarness.countDroppedTags(sessionId)).toBeGreaterThan(0);
            const toolStatus = toolHarness
                .contextDb()
                .prepare("SELECT status FROM tags WHERE session_id = ? AND tag_number = ?")
                .get(sessionId, toolTag) as { status: string } | null;
            expect(toolStatus?.status).toBe("dropped");
            expect(
                toolHarness.mock.requests().slice(requestStart).some((request) => {
                    const body = JSON.stringify(request.body);
                    return body.includes(callId) && body.includes(`[dropped §${toolTag}§]`);
                }),
            ).toBe(true);
        } finally {
            await toolHarness.dispose();
        }
    }, 180_000);
});
