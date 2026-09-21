/// <reference types="bun-types" />

/**
 * Who decides when a Rust-mode session on OpenCode 2 folds.
 *
 * Two clocks run in this lane and they are not the same clock. The host fires
 * its `compaction` hook off the usage IT measures — the history it has stored
 * for the session — while Magic Context folds off what the module measures, the
 * true-raw mass of the conversation it is actually serving. Once a long session
 * crosses the host's trigger, the host keeps asking on every turn; the module
 * folds far less often than that. This file pins the rule that resolves the two:
 * the hook is a trigger Magic Context answers, not a command it obeys, so a
 * checkpoint is written when the module's boundary moves and not otherwise.
 *
 * Its own file on purpose: each scenario boots a hermetic daemon, a module and a
 * GA host, and two such stacks in one Bun process do not both come up. The rust
 * lane already runs one file per fresh process for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { driveHistorian } from "../../src/opencode2-runner/conversion-lane";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();

function field(body: string, name: string): string {
    return new RegExp(`\\b${name}=([^\\s]+)`).exec(body)?.[1] ?? "";
}

function logLines(logPath: string, marker: string): string[] {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes(marker))
        .map((line) => line.slice(line.indexOf(marker) + marker.length));
}

/** `rust pass: decision=… served_from=… in=N …` — one line per module pass. */
function readPasses(logPath: string): Array<{ decision: string; servedFrom: string }> {
    return logLines(logPath, "rust pass: ").map((body) => ({
        decision: field(body, "decision"),
        servedFrom: field(body, "served_from"),
    }));
}

/** `rust input coverage: oc_input=N marker_at=… covered=N` — the array handed to the module. */
function readCoverage(logPath: string): Array<{ ocInput: number; markerAt: string }> {
    return logLines(logPath, "rust input coverage: ").map((body) => ({
        ocInput: Number(field(body, "oc_input") || "0"),
        markerAt: field(body, "marker_at"),
    }));
}

/**
 * `v2 compaction hook: fired answered=… …` — one line per host request.
 *
 * This is the instrument the whole file turns on: the host's firing rate and
 * Magic Context's answering rate are separate facts, and only reading both
 * explains a session's checkpoint cadence.
 */
function readHookFires(logPath: string): Array<{ answered: boolean; reason: string }> {
    return logLines(logPath, "v2 compaction hook: ").map((body) => ({
        answered: field(body, "answered") === "true",
        reason: field(body, "reason"),
    }));
}

/** Completed host checkpoints, read from the store the host actually wrote. */
function compactionRows(
    dbPath: string,
    sessionId: string,
): Array<{ seq: number; status: string; summary: string }> {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
        return (
            db
                .prepare(
                    `SELECT seq, data FROM session_message
                      WHERE session_id = ? AND type = 'compaction' ORDER BY seq ASC`,
                )
                .all(sessionId) as Array<{ seq: number; data: string }>
        ).map((row) => {
            const data = JSON.parse(row.data) as { status?: string; summary?: string };
            return {
                seq: row.seq,
                status: String(data.status ?? ""),
                summary: String(data.summary ?? "").slice(0, 120),
            };
        });
    } finally {
        db.close();
    }
}

/**
 * Real prose mass, because the module measures true content rather than the
 * usage the mock reports. Repeated filler does not work — the tokenizer collapses
 * it, so a turn that looks large on the page carries almost no true-raw mass.
 */
const BALLAST_WORDS = [
    "boundary", "historian", "compartment", "schedule", "pressure", "tokens",
    "window", "publish", "transform", "session", "marker", "budget", "eligible",
    "protected", "ordinal", "snapshot", "replay", "decision", "threshold",
];

function ballast(tokens: number): string {
    const target = tokens * 4;
    const parts: string[] = [];
    let length = 0;
    for (let index = 0; length < target; index += 1) {
        const word = BALLAST_WORDS[index % BALLAST_WORDS.length]!;
        parts.push(index % 17 === 0 ? `${word}.` : word);
        length += word.length + 1;
    }
    return parts.join(" ");
}

/**
 * Both answers report the same high usage, so the HOST stays above its own
 * trigger for the whole run. They differ in the only thing Magic Context
 * measures: how much real conversational content the turn adds. That is the
 * divergence this file is about, and holding the host's number fixed is what
 * keeps the two clocks separable.
 */
const HOST_PRESSURE_USAGE = { input_tokens: 20_000, output_tokens: 20 };

describe.skipIf(!prereqs.ok)(
    `rust mode on OpenCode 2: fold cadence${prereqs.ok ? "" : ` (skipped: ${prereqs.skipReason})`}`,
    () => {
        let host: Awaited<ReturnType<typeof spawnOpencode2>>;
        let subc: HermeticSubcStack;
        let logPath: string;
        let openCodeDbPath: string;

        beforeAll(async () => {
            const fixture = isolation();
            logPath = join(fixture.env.XDG_DATA_HOME!, "magic-context-oc2-fold.log");
            fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
            openCodeDbPath = join(fixture.env.XDG_DATA_HOME!, "opencode", "opencode2.db");
            const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
            subc = await HermeticSubcStack.start({
                dataDir: fixture.env.XDG_DATA_HOME!,
                ckMcBin: binaries.ckMcBin,
                ckSubcBin: binaries.ckSubcBin,
                startProducer: true,
            });
            host = await spawnOpencode2({
                existingIsolation: fixture,
                // A 24k context against a 1k output: a small context with the default
                // 32k output makes 2.0.5's first-request ceiling negative and the host
                // never reaches the plugin.
                modelContextLimit: 24_000,
                modelOutputLimit: 1_024,
                magicContextConfig: {
                    transform_mode: "rust",
                    subc: { connection_file: subc.connectionFile },
                    memory: { enabled: false },
                    dreamer: { disable: true },
                    historian: { opencode: { model: "openai/mock-model" } },
                    execute_threshold_percentage: 40,
                    history_budget_percentage: 0.15,
                },
            });
        }, 900_000);

        afterAll(async () => {
            await host?.stop();
            await subc?.stop();
        });

        it("checkpoints the host when the module folds, not when the host asks", async () => {
            const client = OpenCode.make({
                baseUrl: host.url,
                headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
            });
            const session = await client.session.create({
                location: { directory: host.cwd },
                model: { providerID: "openai", id: "mock-model" },
            });
            const prompt = async (text: string) => {
                await client.session.prompt({ sessionID: session.id, text });
                await client.session.wait(
                    { sessionID: session.id },
                    { signal: AbortSignal.timeout(180_000) },
                );
            };
            const boundaryPublished = () =>
                readCoverage(logPath).some((entry) => entry.markerAt !== "none");

            // ── 1. drive until the module folds once ─────────────────────────────
            // Each round is one ordinary turn carrying real prose; the loop just keeps
            // asking until the durable state the rest of this test depends on exists.
            await driveHistorian({
                prompt,
                mock: host.mock,
                pressure: { text: "pressure", usage: HOST_PRESSURE_USAGE },
                quiet: { text: "ok", usage: HOST_PRESSURE_USAGE },
                label: "a module boundary",
                satisfied: boundaryPublished,
                rounds: 24,
                settleMs: 6_000,
                text: (round) =>
                    `turn ${round + 1}: durable signal for chunk ${round + 1}. ${ballast(3_000)}`,
            });
            expect(boundaryPublished()).toBe(true);

            const afterFirstFold = compactionRows(openCodeDbPath, session.id);
            const firstFoldCoverage = readCoverage(logPath).length;
            const firstFoldFires = readHookFires(logPath).length;
            console.log(
                `after the first fold: compaction rows=${JSON.stringify(afterFirstFold)}`,
            );
            // The module folded and the host recorded exactly one checkpoint for it.
            // Without this the "no further rows" assertion below would be vacuous:
            // a run that never checkpointed at all would satisfy it.
            expect(afterFirstFold.filter((row) => row.status === "completed")).toHaveLength(1);

            // ── 2. twenty turns the module has no reason to fold on ──────────────
            // Same reported usage, so the host stays above its own trigger and keeps
            // asking; almost no new content, so the module's own measure stays under
            // the execute threshold and its boundary does not move.
            host.mock.setDefault({ text: "ok", usage: HOST_PRESSURE_USAGE });
            for (let turn = 1; turn <= 20; turn += 1) {
                await prompt(`quiet turn ${turn}`);
            }

            const quietFires = readHookFires(logPath).slice(firstFoldFires);
            const quietCoverage = readCoverage(logPath).slice(firstFoldCoverage);
            const afterQuiet = compactionRows(openCodeDbPath, session.id);
            console.log(
                `quiet phase: host fired ${quietFires.length} times, answered ${quietFires.filter((fire) => fire.answered).length}`,
            );
            console.log(
                `quiet phase decline reasons: ${[...new Set(quietFires.filter((fire) => !fire.answered).map((fire) => fire.reason))].join(", ") || "<none>"}`,
            );
            console.log(
                `quiet phase oc_input: ${quietCoverage.map((entry) => `${entry.ocInput}@${entry.markerAt}`).join(" ")}`,
            );

            // The host really did keep asking. If this fails the cadence claim is
            // wrong and the rest of the phase proves nothing, so it is asserted
            // rather than assumed.
            expect(quietFires.length).toBeGreaterThan(5);
            // …and Magic Context declined every one of them, because its own
            // boundary did not move.
            expect(quietFires.filter((fire) => fire.answered)).toHaveLength(0);
            // The consequence in the store: no new checkpoint. This also catches the
            // case where declining merely hands the cut to the host, which would
            // write a row of its own.
            expect(afterQuiet).toEqual(afterFirstFold);
            // And the consequence for the module: the array it is handed stops
            // tracking the conversation, which is what a fold is for.
            expect(quietCoverage.length).toBeGreaterThan(10);
            const ocInputs = quietCoverage.map((entry) => entry.ocInput);
            expect(Math.max(...ocInputs) - Math.min(...ocInputs)).toBeLessThanOrEqual(2);

            // ── 3. real content again: the module folds, the host is told ────────
            const boundariesSoFar = new Set(
                readCoverage(logPath)
                    .map((entry) => entry.markerAt)
                    .filter((marker) => marker !== "none"),
            );
            const advanced = () =>
                readCoverage(logPath).some(
                    (entry) => entry.markerAt !== "none" && !boundariesSoFar.has(entry.markerAt),
                );
            await driveHistorian({
                prompt,
                mock: host.mock,
                pressure: { text: "pressure", usage: HOST_PRESSURE_USAGE },
                quiet: { text: "ok", usage: HOST_PRESSURE_USAGE },
                label: "a second module boundary",
                satisfied: advanced,
                rounds: 16,
                settleMs: 6_000,
                text: (round) =>
                    `second chunk turn ${round + 1}: durable signal. ${ballast(3_000)}`,
            });
            expect(advanced()).toBe(true);

            const afterSecondFold = compactionRows(openCodeDbPath, session.id);
            const allFires = readHookFires(logPath);
            console.log(
                `after the second fold: compaction rows=${JSON.stringify(afterSecondFold)}`,
            );
            console.log(
                `whole run: host fired ${allFires.length} times, Magic Context answered ${allFires.filter((fire) => fire.answered).length}`,
            );
            const completed = afterSecondFold.filter((row) => row.status === "completed");
            expect(completed.length).toBeGreaterThan(afterFirstFold.length);
            // One checkpoint per module fold, not one per host request.
            expect(completed.length).toBe(allFires.filter((fire) => fire.answered).length);
            expect(allFires.length).toBeGreaterThan(completed.length);
            // Every checkpoint carries the module's own baseline, not a host-composed
            // summary of a history the module never served.
            for (const row of completed) expect(row.summary).toContain("<session-history>");
            // The module was serving throughout; a run that fell back to the
            // TypeScript transform would satisfy the counts above for free.
            expect(readPasses(logPath).some((pass) => pass.servedFrom === "transform")).toBe(true);
        }, 1_800_000);
    },
);
