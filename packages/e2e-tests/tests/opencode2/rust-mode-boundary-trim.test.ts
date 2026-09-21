/// <reference types="bun-types" />

/**
 * The OpenCode 2 boundary trim, under enough pressure that a fold actually lands.
 *
 * Its own file on purpose: each of these scenarios boots a hermetic daemon, a
 * module and a GA host, and two such stacks in one Bun process do not both come
 * up. The rust lane already runs one file per fresh process for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
    buildHermeticBinaries,
    detectRustModePrereqs,
    HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();

/** One `rust pass:` diagnostic line, reduced to the fields this file reads. */
interface PassLine {
    decision: string;
    servedFrom: string;
    inputCount: number;
    applied: boolean;
}

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

function readPasses(logPath: string): PassLine[] {
    return logLines(logPath, "rust pass: ").map((body) => ({
        decision: field(body, "decision"),
        servedFrom: field(body, "served_from"),
        inputCount: Number(field(body, "in") || "0"),
        applied: field(body, "applied") === "true",
    }));
}

/** `rust input coverage: oc_input=N marker_at=… covered=N` — the trim's own trace. */
function readCoverage(logPath: string): Array<{ ocInput: number; markerAt: string }> {
    return logLines(logPath, "rust input coverage: ").map((body) => ({
        ocInput: Number(field(body, "oc_input") || "0"),
        markerAt: field(body, "marker_at"),
    }));
}

/** The plugin buffers its diagnostic log, so a read straight after a turn can miss it. */
async function waitForPasses(logPath: string, atLeast: number): Promise<PassLine[]> {
    const deadline = Date.now() + 60_000;
    let passes = readPasses(logPath);
    while (passes.length < atLeast && Date.now() < deadline) {
        await Bun.sleep(250);
        passes = readPasses(logPath);
    }
    return passes;
}

/**
 * The array this request actually put on the wire.
 *
 * The OpenCode 2 lane's mock speaks the OpenAI Responses API, which carries the
 * conversation in `input`; the Anthropic-shaped lanes carry it in `messages`.
 * Reading whichever is present keeps the assertions about served bytes rather
 * than about one provider's field name — and throwing when neither is present
 * is deliberate, because an empty read would otherwise let every byte-identity
 * assertion below pass by comparing nothing to nothing.
 */
function servedArray(request: { body: Record<string, unknown> } | undefined): unknown[] {
    const wire = request?.body.input ?? request?.body.messages;
    if (!Array.isArray(wire) || wire.length === 0) {
        throw new Error(
            `no served array on the captured request; body keys: ${Object.keys(request?.body ?? {}).join(", ") || "<no request>"}`,
        );
    }
    return wire;
}


/**
 * The boundary trim, under enough pressure that a fold actually lands.
 *
 * On OpenCode 1 the host's own compaction row is what stops a folded session from
 * resending its whole history; OpenCode 2 writes no such row, so the adapter
 * records the module's boundary and trims against it. The observable consequence
 * is that `oc_input` — the size of the array handed to the module — stops
 * tracking the conversation once a boundary exists.
 *
 * Pressure has to come from real content: the module measures true-raw mass, not
 * the usage numbers the mock reports.
 */
describe.skipIf(!prereqs.ok)("rust mode on OpenCode 2: boundary trim", () => {
    let host: Awaited<ReturnType<typeof spawnOpencode2>>;
    let subc: HermeticSubcStack;
    let logPath: string;

    beforeAll(async () => {
        const fixture = isolation();
        logPath = join(fixture.env.XDG_DATA_HOME!, "magic-context-oc2-fold.log");
        fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
        const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
        subc = await HermeticSubcStack.start({
            dataDir: fixture.env.XDG_DATA_HOME!,
            ckMcBin: binaries.ckMcBin,
            ckSubcBin: binaries.ckSubcBin,
            startProducer: true,
        });
        host = await spawnOpencode2({
            existingIsolation: fixture,
            // A small context with the default 32k output makes 2.0.5's first-request
            // ceiling negative and the host never reaches the plugin; the output limit
            // has to come down with it.
            modelContextLimit: 30_000,
            modelOutputLimit: 1024,
            magicContextConfig: {
                transform_mode: "rust",
                subc: { connection_file: subc.connectionFile },
                memory: { enabled: false },
                dreamer: { disable: true },
                execute_threshold_percentage: 25,
            },
        });
    }, 600_000);

    afterAll(async () => {
        await host?.stop();
        await subc?.stop();
    });

    // SKIPPED, and deliberately not weakened into something that passes: the claim
    // it makes is real and unproven. Fourteen turns at a 30k context and a 25%
    // execute threshold produced ten module passes with `marker_at=none` on every
    // one, so no boundary was ever published and the trim never ran. The cause is
    // that the turns do not serialise on this harness — fourteen prompt/wait pairs
    // complete in about two seconds, where a single completed turn takes roughly
    // three — so true-raw content never accumulates to the fold trigger, and the
    // module measures true-raw mass rather than the usage the mock reports. What
    // this needs is a way to await turn completion on the OpenCode 2 client (the
    // OpenCode 1 rust harness has one; `session.wait` here returns early), not a
    // looser assertion.
    it.skip("stops handing the module the whole history once a boundary is recorded", async () => {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const session = await client.session.create({
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        for (let turn = 1; turn <= 14; turn += 1) {
            host.mock.setDefault({
                text: `assistant ${turn}`,
                usage: { input_tokens: 3_000 * turn, output_tokens: 20 },
            });
            await client.session.prompt({
                sessionID: session.id,
                text: `turn ${turn}: ${"ballast content ".repeat(400)}`,
            });
            await client.session.wait(
                { sessionID: session.id },
                { signal: AbortSignal.timeout(120_000) },
            );
        }
        await waitForPasses(logPath, 10);
        const coverage = readCoverage(logPath);
        console.log(
            `oc_input per pass: ${coverage.map((entry) => `${entry.ocInput}@${entry.markerAt}`).join(" ")}`,
        );
        expect(coverage.length).toBeGreaterThan(0);
        const folded = coverage.findIndex((entry) => entry.markerAt !== "none");
        expect(folded).toBeGreaterThan(0);
        // Before the boundary the array grows with the conversation; after it, the
        // array starts at the boundary, so it is strictly smaller than the peak.
        const before = Math.max(...coverage.slice(0, folded).map((entry) => entry.ocInput));
        const after = coverage[coverage.length - 1]!.ocInput;
        console.log(`oc_input peak before boundary=${before} final after boundary=${after}`);
        expect(after).toBeLessThan(before);
    }, 900_000);
});
