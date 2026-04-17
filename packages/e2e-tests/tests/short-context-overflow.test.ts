/// <reference types="bun-types" />

/**
 * Small-context overflow probe — documents a real gap in overflow prevention
 * on short-context models when main turns hit back-to-back faster than
 * historian can finish.
 *
 * ## Scenario
 *
 * A 128K model with fast main and monotonically accumulating context where
 * the plugin's `input_tokens` signal comes from the actual size of the
 * request body (the mock counts request bytes and reports tokens ≈ bytes/4,
 * mirroring how real providers compute usage). Each turn the mock returns
 * a ~60KB text block that becomes part of the assistant history, so the
 * next user turn ships a bigger request. Historian is delayed 3 seconds to
 * simulate a slow summarizer model. Turns fire back-to-back with no user
 * pause — the autonomous-loop scenario.
 *
 * ## What we observed
 *
 * Peak provider-visible request reached 169% of 128K after 16 turns, even
 * with `compaction_markers: true`, `execute_threshold_percentage: 40`, and
 * historian producing valid compartments. Inspection of the test's
 * context.db showed: 1 compartment published, 14 pending drops queued by
 * `queueDropsForCompartmentalizedMessages`, and ZERO tags in `dropped`
 * status. The drops were queued correctly but never applied.
 *
 * ## Root cause (verified)
 *
 * `transform-postprocess-phase.ts:113-114` gates pending-op application on:
 *
 *     shouldApplyPendingOps =
 *         (schedulerDecision === "execute" || isExplicitFlush) &&
 *         !compartmentRunning
 *
 * The `!compartmentRunning` guard defers drops while historian is active
 * to avoid mid-mutation conflicts. With a fast main agent firing turns
 * back-to-back during sustained high pressure, every transform pass sees
 * `compartmentRunning=true` (historian either still processing the previous
 * range or starting a new one). Drops accumulate in pending_ops but never
 * materialize. The outgoing body never shrinks; the provider rejects the
 * request once input exceeds 100%.
 *
 * ## Why this is less severe in production
 *
 * Real users pause 5-15 seconds between turns (reading, thinking). Between
 * pauses historian finishes, `compartmentRunning` flips to false, and the
 * next turn's transform materializes the pending drops before the next
 * request goes out. The body shrinks, overflow is avoided. Fast autonomous
 * agent loops without pauses break this assumption.
 *
 * ## Why the test is skipped
 *
 * Fixing this requires a design decision on which approach:
 *   (a) Apply pending drops for already-PUBLISHED compartments even when a
 *       NEW historian run is in progress (drops for published ranges are
 *       safe — they don't touch the in-progress chunk)
 *   (b) Allow emergency drop materialization at >=95% regardless of
 *       compartmentRunning
 *   (c) Make historian start-of-run atomically apply queued drops from
 *       prior compartments before taking the "running" lock
 *
 * The probe is preserved as a runnable reproducer. Remove `.skip` once the
 * fix approach is chosen.
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
