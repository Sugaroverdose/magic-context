/// <reference types="bun-types" />

/**
 * Adversarial gate drive (hermetic ck-subc + ck-mc stack, Rust mode from the
 * first pass): the Rust lane makes its own drops under pressure, with a large
 * call whose result ends the request and text beside it. Every request passes an
 * Anthropic pairing and no-prefill validator. The drive records how each call is
 * served per request and whether each later pass keeps the previous pass's
 * messages byte-identical.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    anthropicViolation,
    findToolResult,
    findToolUse,
    resultText,
    type WireMessage,
} from "../src/anthropic-request-validator";
import { analyzePasses } from "../src/cache-analysis";
import type { MockResponse } from "../src/mock-provider/server";
import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const LOW = { input_tokens: 1_000, output_tokens: 10, cache_creation_input_tokens: 0 };
const HIGH = { input_tokens: 19_500, output_tokens: 10, cache_creation_input_tokens: 0 };
const CONFIG = { execute_threshold_percentage: 20, compressor: { enabled: false } };

const strip = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(strip);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value as Record<string, unknown>)
                .filter(([key]) => key !== "cache_control")
                .map(([key, inner]) => [key, strip(inner)]),
        );
    }
    return value;
};
const shaOf = (messages: unknown[]) =>
    createHash("sha256").update(JSON.stringify(strip(messages))).digest("hex");

describe.skipIf(!rustPrereqs.ok)("ADV rust native real-or-absent drops", () => {
    let h: RustTestHarness;
    const violations: string[] = [];

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 20_000,
            startHistorianProducer: false,
            magicContextConfig: CONFIG,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("keeps the request-ending call and replays drops byte-identically", async () => {
        const toolNamed = (body: Record<string, unknown>, suffix: string) =>
            (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .find(
                    (name): name is string =>
                        typeof name === "string" && new RegExp(`(^|_)${suffix}$`).test(name),
                );
        const inputs: Record<string, Record<string, unknown>> = {
            toolu_small: { command: "echo small", description: "small" },
            toolu_a1025: { command: `echo ${"a".repeat(1018)}`, description: "xy" },
            toolu_mb1024: { command: `echo ${"\u00e9".repeat(509)}`, description: "d" },
            toolu_large: { command: `echo ${"L".repeat(3000)} > /dev/null`, description: "large" },
        };
        const endInput = { command: `echo ${"E".repeat(3000)} > /dev/null`, description: "end" };

        h.mock.reset();
        h.mock.addMatcher((body): MockResponse | null => {
            const violation = anthropicViolation(body);
            if (!violation) return null;
            violations.push(violation);
            return { error: { status: 400, type: "invalid_request_error", message: violation } };
        });
        const turnOne = Object.entries(inputs);
        let turnOneStep = 0;
        let endStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            if (turnOneStep < turnOne.length) {
                const [id, input] = turnOne[turnOneStep]!;
                turnOneStep += 1;
                return {
                    content: [{ type: "tool_use", id, name: bash, input }],
                    stop_reason: "tool_use",
                    usage: LOW,
                };
            }
            return null;
        });
        h.mock.setDefault({ text: "turn one done", usage: LOW });
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run the commands");
        await Bun.sleep(500);

        h.mock.addMatcher((body): MockResponse | null => {
            if (endStep >= 1) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            endStep += 1;
            return {
                content: [
                    { type: "text", text: "Running the final command." },
                    { type: "tool_use", id: "toolu_end", name: bash, input: endInput },
                ],
                stop_reason: "tool_use",
                usage: HIGH,
            };
        });
        h.mock.setDefault({ text: "turn two done", usage: LOW });
        await h.sendPrompt(sessionId, "run the final long command");
        await Bun.sleep(1000);

        // Agent drops of the four turn-one calls through ctx_reduce; the response
        // reports high usage so the next pass is a forced bust that drains them.
        let reduceStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            if (reduceStep >= 1) return null;
            const reduce = (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .find((name): name is string => typeof name === "string" && /ctx_reduce/.test(name));
            if (!reduce) return null;
            if (!JSON.stringify(body.messages ?? "").includes("please reduce")) return null;
            reduceStep += 1;
            return {
                content: [{ type: "tool_use", id: "toolu_reduce", name: reduce, input: { drop: "2-5" } }],
                stop_reason: "tool_use",
                usage: HIGH,
            };
        });
        h.mock.setDefault({ text: "reduced", usage: HIGH });
        await h.sendPrompt(sessionId, "please reduce");
        await Bun.sleep(1000);

        h.mock.setDefault({ text: "ok", usage: LOW });
        for (const text of ["defer one", "defer two", "defer three"]) {
            await h.sendPrompt(sessionId, text);
            await Bun.sleep(500);
        }

        const ids = [...Object.keys(inputs), "toolu_end"];
        const shapeOf = (messages: WireMessage[]) =>
            Object.fromEntries(
                ids.map((id) => {
                    const use = findToolUse(messages, id);
                    if (!use) return [id, "absent"];
                    const expected = id === "toolu_end" ? endInput : inputs[id];
                    const real = JSON.stringify(use.input) === JSON.stringify(expected);
                    const marker = JSON.stringify(use.input).includes('"dropped"');
                    return [
                        id,
                        `${real ? "real" : marker ? "MARKER" : "OTHER"} / ${resultText(findToolResult(messages, id)).slice(0, 24)}`,
                    ];
                }),
            );
        const requests = h.mock.requests();
        const record = requests.map((request, index) => {
            const messages = (request.body.messages ?? []) as WireMessage[];
            const previous = index > 0 ? requests[index - 1]! : null;
            const prevMessages = (previous?.body.messages ?? []) as WireMessage[];
            const cmp = previous ? analyzePasses([previous, request])[1]! : null;
            return {
                index,
                messageCount: messages.length,
                lastRole: messages.at(-1)?.role,
                shape: shapeOf(messages),
                prefixEqualsPrevious: previous
                    ? shaOf(messages.slice(0, prevMessages.length)) === shaOf(prevMessages)
                    : null,
                divergence: cmp ? { verdict: cmp.verdict, at: cmp.divergeSegmentId } : null,
            };
        });
        const summary = { record, violations, requestCount: requests.length };
        console.log("ADV_RUST_NATIVE", JSON.stringify(summary, null, 1));
        const evidenceDir = process.env.ADV_EVIDENCE;
        if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true });
            writeFileSync(join(evidenceDir, "adv-rust-native.json"), JSON.stringify(summary, null, 2));
            writeFileSync(
                join(evidenceDir, "adv-rust-native-last.json"),
                JSON.stringify(requests.at(-1)?.body.messages ?? [], null, 2),
            );
        }
        expect(violations).toEqual([]);
    }, 1_200_000);
});
