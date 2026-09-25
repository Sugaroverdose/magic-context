/// <reference types="bun-types" />

/**
 * Adversarial gate drive (hermetic ck-subc + ck-mc stack, real OpenCode host):
 * a session with real-or-absent drops and one legacy `{"dropped": …}` skeleton
 * moves TS -> Rust -> TS. Every request passes an Anthropic pairing and no-prefill
 * validator. The drive records, per request, how each dropped call is served
 * (real arguments, legacy marker, or absent), the tag drop modes in context.db,
 * and sha256 of each defer pass over the previous pass's messages.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
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
import { openTestDb } from "../src/test-db";

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

describe.skipIf(!rustPrereqs.ok)("ADV rust: real-or-absent drops across TS -> Rust -> TS", () => {
    let h: RustTestHarness;
    const violations: string[] = [];

    beforeAll(async () => {
        h = await RustTestHarness.create({
            modelContextLimit: 20_000,
            startInTsMode: true,
            startHistorianProducer: false,
            magicContextConfig: CONFIG,
        });
    });

    afterAll(async () => {
        await h?.dispose();
    });

    it("records served shapes, drop modes and defer-pass prefix hashes on both lanes", async () => {
        const toolNamed = (body: Record<string, unknown>, suffix: string) =>
            (Array.isArray(body.tools) ? body.tools : [])
                .map((tool) => (tool as { name?: unknown }).name)
                .find(
                    (name): name is string =>
                        typeof name === "string" && new RegExp(`(^|_)${suffix}$`).test(name),
                );
        const inputs: Record<string, Record<string, unknown>> = {
            toolu_small: { command: "echo small", description: "small" },
            toolu_legacy: { command: "echo legacy", description: "legacy" },
            // 1024 string bytes in multi-byte UTF-8: "echo " + 509 x "é" + "d".
            toolu_mb1024: { command: `echo ${"\u00e9".repeat(509)}`, description: "d" },
            toolu_mid: { command: `echo ${"M".repeat(3000)} > /dev/null`, description: "mid" },
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
        h.mock.addMatcher((body): MockResponse | null => {
            if (turnOneStep >= turnOne.length) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            const [id, input] = turnOne[turnOneStep]!;
            turnOneStep += 1;
            return {
                content: [{ type: "tool_use", id, name: bash, input }],
                stop_reason: "tool_use",
                usage: LOW,
            };
        });
        h.mock.setDefault({ text: "turn one done", usage: LOW });
        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "run the commands");
        await Bun.sleep(500);

        const dbPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
        const withDb = <T>(fn: (db: ReturnType<typeof openTestDb>) => T): T => {
            const db = openTestDb(dbPath);
            try {
                return fn(db);
            } finally {
                db.close();
            }
        };
        const tagOf = (callId: string) =>
            withDb(
                (db) =>
                    db
                        .prepare(
                            "SELECT tag_number AS tag, status, drop_mode AS mode FROM tags WHERE session_id = ? AND type = 'tool' AND message_id = ?",
                        )
                        .get(sessionId, callId) as { tag: number; status: string; mode: string } | null,
            );
        const queue = (tag: number) =>
            withDb((db) =>
                db
                    .prepare(
                        "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at) VALUES (?, ?, 'drop', ?)",
                    )
                    .run(sessionId, tag, Date.now()),
            );
        queue(tagOf("toolu_small")!.tag);
        queue(tagOf("toolu_mb1024")!.tag);
        queue(tagOf("toolu_mid")!.tag);
        withDb((db) =>
            db
                .prepare(
                    "UPDATE tags SET status = 'dropped', drop_mode = 'truncated' WHERE session_id = ? AND tag_number = ?",
                )
                .run(sessionId, tagOf("toolu_legacy")!.tag),
        );

        let endStep = 0;
        h.mock.addMatcher((body): MockResponse | null => {
            if (turnOneStep < turnOne.length || endStep >= 1) return null;
            const bash = toolNamed(body, "bash");
            if (!bash) return null;
            endStep += 1;
            const max = withDb(
                (db) =>
                    db
                        .prepare("SELECT MAX(tag_number) AS max FROM tags WHERE session_id = ?")
                        .get(sessionId) as { max: number },
            );
            queue(max.max + 2);
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
        await Bun.sleep(500);

        const ids = [...Object.keys(inputs), "toolu_end"];
        const modes = () => Object.fromEntries(ids.map((id) => [id, tagOf(id)?.mode ?? null]));
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
                        `${real ? "real" : marker ? "MARKER" : `OTHER:${JSON.stringify(use.input).slice(0, 60)}`} / ${resultText(findToolResult(messages, id)).slice(0, 24)}`,
                    ];
                }),
            );
        const record: Array<Record<string, unknown>> = [];
        let previous: WireMessage[] | null = null;
        let previousRequest: ReturnType<typeof h.mock.lastRequest> = undefined as never;
        const snap = (label: string) => {
            const request = h.mock.lastRequest()!;
            const messages = (request.body.messages ?? []) as WireMessage[];
            const cmp = previousRequest ? analyzePasses([previousRequest, request])[1] : null;
            record.push({
                label,
                messageCount: messages.length,
                modes: modes(),
                shape: shapeOf(messages),
                prefixEqualsPrevious: previous
                    ? shaOf(messages.slice(0, previous.length)) === shaOf(previous)
                    : null,
                divergence: cmp
                    ? { verdict: cmp.verdict, at: cmp.divergeSegmentId, diff: cmp.diff }
                    : null,
            });
            previous = messages;
            previousRequest = request;
        };

        h.mock.setDefault({ text: "ok", usage: LOW });
        await h.sendPrompt(sessionId, "ts defer one");
        await Bun.sleep(500);
        snap("ts-defer-1");
        await h.sendPrompt(sessionId, "ts defer two");
        await Bun.sleep(500);
        snap("ts-defer-2");

        await h.restart({ rust: true, magicContextConfig: CONFIG });
        await h.sendPrompt(sessionId, "rust one");
        await h.waitForRustPasses(1);
        await Bun.sleep(500);
        snap("rust-1");
        await h.sendPrompt(sessionId, "rust two");
        await Bun.sleep(500);
        snap("rust-2");
        await h.sendPrompt(sessionId, "rust three");
        await Bun.sleep(500);
        snap("rust-3");

        await h.restart({ rust: false, magicContextConfig: CONFIG });
        await h.sendPrompt(sessionId, "ts again one");
        await Bun.sleep(500);
        snap("ts-back-1");
        await h.sendPrompt(sessionId, "ts again two");
        await Bun.sleep(500);
        snap("ts-back-2");

        const logLines: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                const st = statSync(full);
                if (st.isDirectory()) walk(full);
                else if (name.endsWith(".log")) {
                    for (const line of readFileSync(full, "utf8").split("\n")) {
                        if (/converted|materializ|HARD|hard fold|fold reason|reason=/i.test(line) && line.includes(sessionId)) {
                            logLines.push(`${name}: ${line.slice(0, 300)}`);
                        }
                    }
                }
            }
        };
        try {
            walk(h.env.dataDir);
        } catch {}
        const summary = { record, violations, requestCount: h.mock.requests().length, logLines };
        console.log("ADV_RUST_MODE_SWITCH", JSON.stringify(summary, null, 1));
        const evidenceDir = process.env.ADV_EVIDENCE;
        if (evidenceDir) {
            mkdirSync(evidenceDir, { recursive: true });
            writeFileSync(join(evidenceDir, "adv-rust-mode-switch.json"), JSON.stringify(summary, null, 2));
            const pids = spawnSync("lsof", ["-t", "+D", realpathSync(h.env.dataDir)], {
                encoding: "utf8",
            })
                .stdout.split("\n")
                .filter(Boolean);
            const lines = [...new Set(pids)].flatMap((pid) =>
                execFileSync("lsof", ["-p", pid], { encoding: "utf8" })
                    .split("\n")
                    .filter((line) => /\.db(-wal|-shm)?$/.test(line)),
            );
            writeFileSync(join(evidenceDir, "adv-rust-lsof-db.txt"), lines.join("\n"));
        }
        expect(violations).toEqual([]);
    }, 1_200_000);
});
