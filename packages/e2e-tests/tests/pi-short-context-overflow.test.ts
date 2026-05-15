/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PiTestHarness } from "../src/pi-harness";

/**
 * Pi short-context emergency-drop regression test.
 *
 * This is the Pi port of OpenCode's short-context overflow guard. With a
 * deliberately small 128K mock model window, fast main-agent turns, and a slow
 * historian, pressure should cross the force-materialization band while the
 * historian is still active. Pi must still materialize pending drops and keep
 * the outgoing provider request under 100% of the configured context window.
 *
 * Pi uses the shared overflow/pressure machinery but its event wiring and
 * context-limit source are Pi-specific, so this test verifies the same survival
 * property through `PiTestHarness` and Pi's settings/models.json path.
 */

const HISTORIAN_MARKER = "You condense long AI coding sessions";

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
            compaction_markers: true,
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
                text:
                    `<output><compartments>` +
                    `<compartment start="${start}" end="${end}" title="Pi build-up">` +
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
            const mainReq = reqs.find((r) => !isHistorian(r.body));
            const observed = mainReq ? Math.floor(JSON.stringify(mainReq.body).length / 4) : 0;
            turnUsage.push(Math.round((observed / 128_000) * 1000) / 10);
        }

        const peakObservedPct = turnUsage.reduce((m, p) => Math.max(m, p), 0);
        const finalPct = turnUsage[turnUsage.length - 1] ?? 0;
        console.log(`[PI-OVERFLOW-GUARD] peak: ${peakObservedPct}% final: ${finalPct}% of 128K`);
        console.log(`[PI-OVERFLOW-GUARD] per-turn %: ${turnUsage.join(", ")}`);
        if (turnErrors.length > 0) {
            console.log(
                `[PI-OVERFLOW-GUARD] prompt failures (${turnErrors.length}):`,
                turnErrors.map((e) => `turn ${e.turn}: ${e.error.slice(0, 100)}`).join(" | "),
            );
        }

        expect(sessionId).toBeTruthy();
        expect(turnErrors).toEqual([]);

        const droppedCount = h.countDroppedTags(sessionId!);
        console.log(`[PI-OVERFLOW-GUARD] dropped tags: ${droppedCount}`);
        expect(droppedCount).toBeGreaterThan(0);
        expect(peakObservedPct).toBeLessThan(100);
    }, 240_000);
});
