/// <reference types="bun-types" />

/**
 * Small-context overflow probe — documents a real gap in overflow prevention
 * on short-context models for pure-text workflows.
 *
 * ## Scenario
 *
 * A 128K model with fast main and monotonically accumulating context where
 * the plugin's `input_tokens` signal comes from the actual size of the
 * request body (the mock counts request bytes and reports tokens ≈ bytes/4,
 * mirroring how real providers compute usage). Each turn the mock returns
 * a ~60KB text block that becomes part of the assistant history, so the
 * next user turn ships a bigger request. This simulates a verbose reasoning
 * conversation with no tool calls.
 *
 * ## What we observed
 *
 * Peak provider-visible request reached 169% of 128K after 16 turns, even
 * with `compaction_markers: true` and `execute_threshold_percentage: 40`.
 * The plugin did its job on the signal side (fired historian 16 times,
 * published 16 compartments, blocked turn 8 for 12s at 98% threshold) but
 * the outgoing body kept growing because:
 *
 *   1. Compartments are ADDITIVE: historian writes a summary to
 *      `<session-history>`, but the raw messages covered by that compartment
 *      are not automatically dropped from the outgoing request body.
 *   2. Heuristic cleanup only targets tool parts (`tool_use`, `tool_result`,
 *      `tool-invocation`, `tool`). Plain text parts from the assistant are
 *      never dropped by the transform pipeline.
 *   3. Compaction markers inject a `type: "compaction"` boundary into
 *      OpenCode's DB, which `filterCompacted` uses to trim pre-boundary
 *      messages. In production, this works (see session ses_331acff95 with
 *      117 compartments comfortably under 1M context). In this probe
 *      compartments were published but outgoing size kept climbing —
 *      possibly the marker/boundary placement didn't advance as fast as
 *      history grew, possibly OpenCode's `filterCompacted` skipped our
 *      marker because the accompanying summary message wasn't considered
 *      "completed" in the expected way. Needs deeper debugging.
 *
 * ## Why this is less severe in real sessions
 *
 * Real sessions are tool-heavy. A typical assistant turn contains small
 * text + large tool_use/tool_result blocks (often 50-100KB of tool output).
 * Heuristic cleanup drops those tool parts on every execute pass, reclaiming
 * 70%+ of context. The pure-text scenario this probe exercises is rare
 * outside of chat-only use cases.
 *
 * ## Why the test is skipped
 *
 * Fixing this surfaces larger design questions (should compartments
 * auto-drop their covered messages? should compaction-marker behavior
 * change?) that the user should decide. The probe is preserved, ready to
 * re-run after that decision. Remove `.skip` to reproduce.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

const HISTORIAN_MARKER = "You condense long AI coding sessions";

function isHistorian(body: Record<string, unknown>): boolean {
    const sys = body.system;
    const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
    return asString.includes(HISTORIAN_MARKER);
}

function bigReplyText(turn: number, targetBytes: number): string {
    const header = `turn-${turn}-reply: `;
    const filler = "abcdefghij0123456789".repeat(200);
    const reps = Math.max(1, Math.floor(targetBytes / filler.length));
    return header + filler.repeat(reps);
}

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create({
        modelContextLimit: 128_000,
        magicContextConfig: {
            execute_threshold_percentage: 40,
            compaction_markers: true,
        },
    });
});

afterAll(async () => {
    await h.dispose();
});

// Skipped — see docstring. Remove .skip to reproduce the failure.
describe.skip("short context accumulating overflow", () => {
    it(
        "known gap: 128K model with pure-text accumulation overflows past 100%",
        async () => {
            h.mock.reset();

            h.mock.addMatcher((body) => {
                if (!isHistorian(body)) return null;
                const msgs = body.messages as Array<{ content?: unknown }> | undefined;
                const flat = JSON.stringify(msgs ?? []);
                const rangeHdr = flat.match(/Messages (\d+)-(\d+):/);
                const start = rangeHdr ? Number(rangeHdr[1]) : 0;
                const end = rangeHdr ? Number(rangeHdr[2]) : 0;
                return {
                    text:
                        `<output><compartments>` +
                        `<compartment start="${start}" end="${end}" title="Build-up">` +
                        `Summary.</compartment></compartments><facts></facts>` +
                        `<unprocessed_from>${end + 1}</unprocessed_from></output>`,
                    usage: {
                        input_tokens: 500,
                        output_tokens: 50,
                        cache_creation_input_tokens: 500,
                        cache_read_input_tokens: 0,
                    },
                    delayMs: 3_000,
                };
            });

            let mainCalls = 0;
            h.mock.addMatcher((body) => {
                if (isHistorian(body)) return null;
                mainCalls++;
                const approxInputTokens = Math.floor(JSON.stringify(body).length / 4);
                const reply = bigReplyText(mainCalls, 60_000);
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

            const sessionId = await h.createSession();
            const turnUsage: number[] = [];
            for (let i = 1; i <= 16; i++) {
                const reqBefore = h.mock.requests().length;
                try {
                    await h.sendPrompt(sessionId, `user turn ${i}: continue.`, {
                        timeoutMs: 60_000,
                    });
                } catch {
                    // overflow after emergency abort — expected
                }
                const reqs = h.mock.requests().slice(reqBefore);
                const mainReq = reqs.find((r) => !isHistorian(r.body));
                const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
                turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
            }

            const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
            console.log(`[KNOWN-GAP] peak request: ${peakObservedPct}% of 128K`);
            console.log(`[KNOWN-GAP] per-turn %: ${turnUsage.join(", ")}`);

            // Will fail: documents the real-world overflow.
            expect(peakObservedPct).toBeLessThan(100);
        },
        240_000,
    );
});
