/// <reference types="bun-types" />

/**
 * Pi cache-invariant suite — the Pi-harness mirror of tests/cache-invariants.ts.
 *
 * Pi's m[0]/m[1] renderer (inject-compartments-pi.ts) is a SEPARATE
 * implementation from OpenCode's, and the nine Pi parity audit rounds repeatedly
 * found cache divergences there. The existing pi-cache-stability suite covers
 * the replay class (system/prefix byte-stability across defer turns) with ad-hoc
 * prefix loops; what it does NOT cover is the m[0]/m[1] SOFT-publish TAXONOMY —
 * that a routine historian publish surfaces the compartment as an m[1] delta
 * while m[0] stays the frozen baseline (the seq-refold regression class).
 *
 * This file asserts that taxonomy on Pi using the SAME harness-agnostic bust
 * oracle (src/cache-analysis.ts) the OpenCode suite uses, so both harnesses are
 * held to one definition of a cache bust.
 */

import { describe, expect, it } from "bun:test";
import { extractM0, extractM1, findBusts, formatBustReport } from "../src/cache-analysis";
import { PiTestHarness } from "../src/pi-harness";

const HISTORIAN_SYSTEM_MARKER = "the hippocampus of a long-running coding agent";

function isHistorianRequest(body: Record<string, unknown>): boolean {
    const system = body.system;
    if (typeof system === "string") return system.includes(HISTORIAN_SYSTEM_MARKER);
    if (Array.isArray(system)) {
        return system.some(
            (b) =>
                b &&
                typeof b === "object" &&
                typeof (b as { text?: unknown }).text === "string" &&
                ((b as { text: string }).text).includes(HISTORIAN_SYSTEM_MARKER),
        );
    }
    return false;
}

/** Line-anchored [N] U:/A: ordinal range, scoped to the <new_messages> block. */
function findOrdinalRange(body: Record<string, unknown>): { start: number; end: number } | null {
    const messages = (body.messages as Array<{ content: unknown }> | undefined) ?? [];
    for (const m of messages) {
        const blocks = Array.isArray(m.content) ? m.content : [];
        for (const block of blocks) {
            const text = (block as { text?: string }).text;
            if (!text || !text.includes("<new_messages>")) continue;
            const start = text.indexOf("<new_messages>");
            const end = text.indexOf("</new_messages>");
            const scope = end > start ? text.slice(start, end) : text.slice(start);
            const nums = [...scope.matchAll(/^\[(\d+)\] [UA]:/gm)].map((mm) => Number(mm[1]));
            if (nums.length > 0) return { start: Math.min(...nums), end: Math.max(...nums) };
        }
    }
    return null;
}

function installHistorianMatcher(h: PiTestHarness): void {
    h.mock.addMatcher((body) => {
        if (!isHistorianRequest(body)) return null;
        const range = findOrdinalRange(body);
        const usage = {
            input_tokens: 500,
            output_tokens: 200,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 0,
        };
        if (!range) {
            return {
                text: "<output><compartments></compartments><facts></facts><unprocessed_from>1</unprocessed_from></output>",
                usage,
            };
        }
        const payload = [
            "<output>",
            "<compartments>",
            `<compartment start="${range.start}" end="${range.end}" title="pi cache-invariant chunk" importance="50" episode_type="feature">`,
            "<p1>Driven by the Pi cache-invariant harness exercising the m[0]/m[1] SOFT-delta taxonomy.</p1>",
            "<p2>Pi cache-invariant chunk exercising historian publish.</p2>",
            "<p3>pi cache-invariant chunk</p3>",
            "<p4/>",
            "</compartment>",
            "</compartments>",
            "<facts></facts>",
            "<events></events>",
            `<unprocessed_from>${range.end + 1}</unprocessed_from>`,
            "</output>",
        ].join("\n");
        return { text: payload, usage };
    });
}

function mainRequests(h: PiTestHarness) {
    return h.mock.requests().filter((r) => {
        const sys = r.body.system;
        if (sys === undefined || sys === null) return false;
        const asString = typeof sys === "string" ? sys : JSON.stringify(sys);
        return asString.includes("## Magic Context");
    });
}

function countCompartments(h: PiTestHarness, sessionId: string): number {
    try {
        const row = h
            .contextDb()
            .prepare("SELECT COUNT(*) AS n FROM compartments WHERE session_id = ?")
            .get(sessionId) as { n: number } | null;
        return row?.n ?? 0;
    } catch {
        return 0;
    }
}

const LO = {
    input_tokens: 2_000,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 2_000,
};
const HI = { input_tokens: 30_000, output_tokens: 20, cache_creation_input_tokens: 30_000 };
const TRIGGER = { input_tokens: 90_000, output_tokens: 20, cache_creation_input_tokens: 90_000 };

describe("pi cache invariants — m[0]/m[1] taxonomy", () => {
    describe("#given a compartment published after Pi materialized m[0] empty (B9 parity)", () => {
        describe("#when the publish surfaces it as an m[1] delta and defer passes follow", () => {
            it("#then m[0] stays empty/frozen (SOFT) — the compartment rides m[1], never folds into m[0]", async () => {
                const h = await PiTestHarness.create({
                    modelContextLimit: 100_000,
                    magicContextConfig: {
                        execute_threshold_percentage: 20,
                        protected_tags: 1,
                        dreamer: { disable: true },
                        sidekick: { disable: true },
                        compressor: { enabled: false },
                        historian: { model: "anthropic/claude-haiku-4-5" },
                        memory: {
                            enabled: true,
                            auto_promote: false,
                            auto_search: { enabled: false },
                            git_commit_indexing: { enabled: false },
                        },
                    },
                });
                try {
                    installHistorianMatcher(h);

                    // Phase 1 — warm up + force an early execute so m[0] materializes
                    // EMPTY before any compartment exists. The first real-id pass
                    // also performs the v25 stable-id cutover (a forced execute),
                    // which naturally helps materialize the empty baseline.
                    h.mock.setDefault({ text: "pi B9 warm", usage: LO });
                    const first = await h.sendPrompt("pi B9 turn 1: warmup.", { timeoutMs: 90_000 });
                    const sessionId = first.sessionId;
                    expect(sessionId).toBeTruthy();
                    h.mock.setDefault({ text: "pi B9 high", usage: HI });
                    await h.sendPrompt("pi B9 turn 2: high usage marks next pass execute.", {
                        timeoutMs: 90_000,
                        continueSession: true,
                    });
                    h.mock.setDefault({ text: "pi B9 mat", usage: LO });
                    await h.sendPrompt("pi B9 turn 3: execute pass materializes empty m[0].", {
                        timeoutMs: 90_000,
                        continueSession: true,
                    });

                    // Phase 2 — build an eligible tail, then trigger + run historian.
                    for (let i = 4; i <= 11; i++) {
                        h.mock.setDefault({ text: `pi B9 r${i}`, usage: LO });
                        await h.sendPrompt(`pi B9 turn ${i}: durable content for compartment chunk ${i}.`, {
                            timeoutMs: 90_000,
                            continueSession: true,
                        });
                    }
                    h.mock.setDefault({ text: "pi B9 trigger", usage: TRIGGER });
                    await h.sendPrompt("pi B9 turn 12: high-usage historian trigger.", {
                        timeoutMs: 90_000,
                        continueSession: true,
                    });
                    h.mock.setDefault({ text: "pi B9 post", usage: LO });
                    await h.sendPrompt("pi B9 turn 13: follow-up starts + awaits the historian publish.", {
                        timeoutMs: 120_000,
                        continueSession: true,
                    });

                    await h.waitFor(() => countCompartments(h, sessionId!) >= 1, {
                        timeoutMs: 60_000,
                        label: "pi B9 compartment publishes",
                    });

                    // Surface pass — drive execute turns until the compartment
                    // appears in m[1] (Pi may need an extra cache-busting pass).
                    let surfaceReq = mainRequests(h).find((r) =>
                        extractM1(r.body)?.includes("<new-compartments>"),
                    );
                    for (let attempt = 0; attempt < 3 && !surfaceReq; attempt++) {
                        h.mock.setDefault({ text: `pi B9 surface ${attempt}`, usage: HI });
                        await h.sendPrompt(`pi B9 turn ${14 + attempt}: execute pass to surface.`, {
                            timeoutMs: 90_000,
                            continueSession: true,
                        });
                        surfaceReq = mainRequests(h).find((r) =>
                            extractM1(r.body)?.includes("<new-compartments>"),
                        );
                    }

                    //#then
                    expect(surfaceReq).toBeDefined();
                    const m1 = extractM1(surfaceReq!.body)!;
                    const m0 = extractM0(surfaceReq!.body)!;
                    // Delta invariant: the compartment rides m[1].
                    expect(m1).toContain("<new-compartments>");
                    expect(m1).toContain("pi cache-invariant chunk");
                    // SOFT invariant: m[0] is still the empty baseline.
                    expect(m0).not.toContain("pi cache-invariant chunk");
                    expect(m0).toContain("<session-history></session-history>");

                    // Trailing pure-defer replay pair must be byte-stable.
                    h.mock.setDefault({ text: "pi B9 replay 1", usage: LO });
                    await h.sendPrompt("pi B9 defer replay 1.", { timeoutMs: 90_000, continueSession: true });
                    h.mock.setDefault({ text: "pi B9 replay 2", usage: LO });
                    await h.sendPrompt("pi B9 defer replay 2.", { timeoutMs: 90_000, continueSession: true });
                    const replayPair = mainRequests(h).slice(-2);
                    const busts = findBusts(replayPair);
                    if (busts.length > 0) {
                        console.error(
                            `[pi-cache-invariant:B9] ${busts.length} bust(s):\n${formatBustReport(busts)}`,
                        );
                    }
                    expect(busts.length).toBe(0);
                } finally {
                    await h.dispose();
                }
            }, 300_000);
        });
    });
});
