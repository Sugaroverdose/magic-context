/// <reference types="bun-types" />

/**
 * Cache-invariant suite — the durable guard against prompt-cache regressions.
 *
 * Motivation: a stale-ctx_reduce strip regression shipped because the existing
 * cache-stability test only drove LOW-PRESSURE PURE-DEFER turns. The bug needed
 * three things that test never combined: conversation GROWTH + an EXECUTE pass
 * (to freeze drop state) + a SUBSEQUENT DEFER pass (where a volatile boundary
 * re-stripped a mid-prefix message). The wire byte-diff caught it in production;
 * nothing in CI did.
 *
 * This suite drives the plugin into those exact states and asserts — using the
 * SAME bust definition the production diagnostic (analyze-cache-busts.ts) uses,
 * ported to `src/cache-analysis.ts` — that DEFER passes never bust the cached
 * prefix. A "bust" = a wire segment BEFORE the final cache_control breakpoint
 * changed between two consecutive requests (i.e. the plugin rewrote bytes that
 * were supposed to stay cached).
 *
 * Invariant classes covered here (the replay class — the regression's family):
 *   A1  low-pressure pure-defer growth stays byte-stable
 *   A2  defer passes AFTER an execute pass + growth stay byte-stable
 *   A3  an aged ctx_reduce call never vanishes mid-prefix on a defer pass
 *       (the exact regression shape)
 *
 * The m[0]/m[1] taxonomy, supersede-delta, boundary, pressure, and restart
 * classes are layered on in sibling describe blocks as the suite grows.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { findBusts, formatBustReport, mainAgentRequests } from "../src/cache-analysis";
import { TestHarness } from "../src/harness";
import type { MockUsage } from "../src/mock-provider/server";

const MODEL_LIMIT = 100_000;

// Below execute_threshold (20% of 100k = 20k) → defer pass.
const DEFER_USAGE: MockUsage = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};

// Above execute_threshold → the next pass is an execute pass.
const EXECUTE_USAGE: MockUsage = {
    input_tokens: 30_000,
    output_tokens: 20,
    cache_creation_input_tokens: 30_000,
    cache_read_input_tokens: 0,
};

let h: TestHarness;

beforeEach(async () => {
    h = await TestHarness.create({
        modelContextLimit: MODEL_LIMIT,
        magicContextConfig: {
            execute_threshold_percentage: 20,
            protected_tags: 1,
            auto_drop_tool_age: 4,
            dreamer: { disable: true },
            sidekick: { disable: true },
            compressor: { enabled: false },
            memory: {
                enabled: true,
                auto_promote: false,
                auto_search: { enabled: false },
                git_commit_indexing: { enabled: false },
            },
        },
    });
});

afterEach(async () => {
    await h.dispose();
});

function setDefer(text: string): void {
    h.mock.setDefault({ text, usage: DEFER_USAGE });
}

/** Emit a single ctx_reduce tool call on the first main-agent request that exposes it. */
function emitCtxReduceOnce(drop: string): void {
    let emitted = false;
    h.mock.addMatcher((body) => {
        if (emitted) return null;
        const sys = JSON.stringify(body.system ?? "");
        if (!sys.includes("## Magic Context")) return null;
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const name = tools
            .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
            .find((n) => typeof n === "string" && /ctx_reduce/.test(n)) as string | undefined;
        if (!name) return null;
        emitted = true;
        return {
            content: [
                {
                    type: "tool_use",
                    id: `toolu_ci_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
                    name,
                    input: { drop },
                },
            ],
            stop_reason: "tool_use" as const,
            usage: DEFER_USAGE,
        };
    });
}

function assertNoBusts(label: string): void {
    const requests = mainAgentRequests(h.mock.requests());
    const busts = findBusts(requests);
    if (busts.length > 0) {
        // Surface the exact wire divergence so a CI failure is actionable.
        console.error(`[cache-invariant:${label}] ${busts.length} bust(s):\n${formatBustReport(busts)}`);
    }
    expect({ label, busts: busts.length }).toEqual({ label, busts: 0 });
}

describe("cache invariants — replay class", () => {
    describe("#given a low-pressure conversation (A1)", () => {
        describe("#when several pure-defer turns grow the tail", () => {
            it("#then the cached prefix never busts across defer passes", async () => {
                //#given / #when
                const sessionId = await h.createSession();
                for (let i = 1; i <= 6; i++) {
                    setDefer(`A1 reply ${i}`);
                    await h.sendPrompt(sessionId, `A1 turn ${i}: low-pressure cache-stability probe.`);
                }

                //#then
                const requests = mainAgentRequests(h.mock.requests());
                expect(requests.length).toBeGreaterThanOrEqual(6);
                assertNoBusts("A1-low-pressure-defer");
            }, 120_000);
        });
    });

    describe("#given a conversation that crossed an execute pass (A2)", () => {
        describe("#when defer passes follow the execute pass with continued growth", () => {
            it("#then defer passes after the execute settle to a stable prefix", async () => {
                //#given — warm up, then a high-usage turn so the NEXT pass executes
                const sessionId = await h.createSession();
                setDefer("A2 warmup 1");
                await h.sendPrompt(sessionId, "A2 turn 1: warmup.");
                setDefer("A2 warmup 2");
                await h.sendPrompt(sessionId, "A2 turn 2: warmup.");

                // High usage marks the next transform as an execute pass.
                h.mock.setDefault({ text: "A2 high usage", usage: EXECUTE_USAGE });
                await h.sendPrompt(sessionId, "A2 turn 3: high usage triggers an execute pass.");

                // Now several defer turns. The execute pass may legitimately bust
                // once (drops/markers materialize); the invariant is that the
                // DEFER passes that follow it are byte-stable.
                const firstDeferIndex = h.mock.requests().length;
                for (let i = 4; i <= 8; i++) {
                    setDefer(`A2 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A2 turn ${i}: defer growth after execute.`);
                }

                //#then — analyze only the post-execute defer window
                const deferRequests = mainAgentRequests(h.mock.requests().slice(firstDeferIndex));
                expect(deferRequests.length).toBeGreaterThanOrEqual(4);
                const busts = findBusts(deferRequests);
                if (busts.length > 0) {
                    console.error(
                        `[cache-invariant:A2-post-execute-defer] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                    );
                }
                expect(busts.length).toBe(0);
            }, 150_000);
        });
    });

    describe("#given an aged ctx_reduce call in the conversation (A3 — the regression)", () => {
        describe("#when pure-defer turns grow the tail past the protected window", () => {
            it("#then the ctx_reduce message never vanishes mid-prefix and the prefix never busts", async () => {
                //#given — a normal turn, then a turn that emits a real ctx_reduce
                // tool call, then enough defer growth to push it well past
                // protected_tags (1) and auto_drop_tool_age (4).
                const sessionId = await h.createSession();
                setDefer("A3 reply 1");
                await h.sendPrompt(sessionId, "A3 turn 1: establish baseline content.");

                emitCtxReduceOnce("99999");
                setDefer("A3 reply 2 (after ctx_reduce tool call)");
                await h.sendPrompt(sessionId, "A3 turn 2: this turn issues a ctx_reduce call.");

                // Capture the wire signature of the ctx_reduce call once it's on
                // the wire, then grow the conversation with pure-defer turns.
                let sawReduceOnWire = false;
                for (let i = 3; i <= 8; i++) {
                    setDefer(`A3 defer reply ${i}`);
                    await h.sendPrompt(sessionId, `A3 turn ${i}: defer growth ages the ctx_reduce call.`);
                    const body = JSON.stringify(h.mock.lastRequest()?.body ?? {});
                    if (body.includes("ctx_reduce")) sawReduceOnWire = true;
                }

                //#then — across the whole post-ctx_reduce window, zero busts.
                // Pre-fix, one of these defer passes would strip the aged
                // ctx_reduce call mid-prefix (vanish + shift) → a bust here.
                expect(sawReduceOnWire).toBe(true);
                assertNoBusts("A3-ctx_reduce-defer-growth");

                // And the ctx_reduce call must still be present on the final wire
                // (never silently removed on a defer pass).
                const finalBody = JSON.stringify(mainAgentRequests(h.mock.requests()).at(-1)?.body ?? {});
                expect(finalBody).toContain("ctx_reduce");
            }, 150_000);
        });
    });
});
