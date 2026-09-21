/// <reference types="bun-types" />

/**
 * The OpenCode 2 boundary trim, under enough pressure that a fold actually lands.
 *
 * Its own file on purpose: each of these scenarios boots a hermetic daemon, a
 * module and a GA host, and two such stacks in one Bun process do not both come
 * up. The rust lane already runs one file per fresh process for the same reason.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
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

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

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
 * The pressure recipe is the conversion lane's: a 24k context against a 1k output
 * (a small context with the default 32k output makes 2.0.5's first-request
 * ceiling negative and the host never reaches the plugin), and ballast built from
 * varied prose. Repeated filler does not work — the tokenizer collapses it, so a
 * turn that looks large on the page carries almost no true-raw mass, and the
 * module measures true-raw mass rather than the usage the mock reports.
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
            modelContextLimit: 24_000,
            modelOutputLimit: 1_024,
            magicContextConfig: {
                transform_mode: "rust",
                subc: { connection_file: subc.connectionFile },
                memory: { enabled: false },
                dreamer: { disable: true },
                // The historian model has to sit in the harness sub-block: the shared
                // resolver reads `historian.<harness>`, and the v2 lane resolves with
                // "opencode". A top-level `historian.model` resolves to nothing, which
                // the module reports back as historian_no_fire=no_models — and with no
                // historian publication there is no compartment, so no boundary.
                historian: { opencode: { model: "openai/mock-model" } },
                execute_threshold_percentage: 40,
                history_budget_percentage: 0.15,
            },
        });
    }, 600_000);

    afterAll(async () => {
        await host?.stop();
        await subc?.stop();
    });

    it("stops handing the module the whole history once a boundary is recorded", async () => {
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
                { signal: AbortSignal.timeout(120_000) },
            );
        };

        // Keep driving ordinary turns until the module publishes a boundary. Each
        // round is one real turn; nothing is reached into, the loop just keeps
        // asking until the durable state this assertion depends on exists.
        host.mock.setDefault({
            text: "pressure",
            usage: { input_tokens: 20_000, output_tokens: 20 },
        });
        let boundaryAt = -1;
        let round = 0;
        for (; round < 24 && boundaryAt < 0; round += 1) {
            await prompt(`turn ${round + 1}: durable signal for chunk ${round + 1}. ${ballast(3_000)}`);
            await waitForPasses(logPath, round + 1);
            boundaryAt = readCoverage(logPath).findIndex((entry) => entry.markerAt !== "none");
        }
        // The boundary is recorded during the pass that publishes it, and the trim is
        // read at the START of a pass, so the first pass that can be trimmed is the
        // one after it. Drive several more so the steady state is what gets measured.
        for (let extra = 0; extra < 6; extra += 1) {
            await prompt(`post-fold turn ${extra + 1}: ${ballast(3_000)}`);
            await waitForPasses(logPath, round + extra + 2);
        }

        const coverage = readCoverage(logPath);
        console.log(
            `oc_input per pass: ${coverage.map((entry) => `${entry.ocInput}@${entry.markerAt}`).join(" ")}`,
        );
        expect(coverage.length).toBeGreaterThan(0);
        // A boundary must actually have been published; without one the rest of
        // this test would be asserting nothing.
        expect(boundaryAt).toBeGreaterThan(0);

        // Each turn adds a user row and an assistant row, so an untrimmed array
        // would carry about two more messages on every pass. That is the number
        // the trim has to beat: what it claims is not "smaller than some earlier
        // peak" — the pre-fold history is short by construction — but that the
        // array handed to the module stops tracking the conversation at all.
        const untrimmed = 2 * coverage.length - 1;
        const post = coverage.slice(boundaryAt + 1).map((entry) => entry.ocInput);
        expect(post.length).toBeGreaterThan(2);
        const final = post[post.length - 1]!;
        console.log(
            `post-boundary oc_input: ${post.join(" ")} | untrimmed equivalent at the final pass: ${untrimmed}`,
        );
        expect(final).toBeLessThan(untrimmed);
        // Flat, not merely smaller: the window stays put while the conversation
        // grows past it, which is what a marker row buys on OpenCode 1.
        expect(Math.max(...post) - Math.min(...post)).toBeLessThanOrEqual(2);
        // The boundary itself keeps advancing, so the trim is tracking live
        // publications rather than pinning one stale id.
        const boundaries = coverage.slice(boundaryAt).map((entry) => entry.markerAt);
        expect(new Set(boundaries).size).toBeGreaterThan(1);

        // The trim is about what the module is handed; the served bytes still have
        // to be a real module head rather than a raw passthrough.
        const served = servedArray(host.mock.requests().at(-1));
        expect(JSON.stringify(served[0])).toContain("<session-history>");
        const passes = readPasses(logPath);
        expect(passes.some((pass) => pass.servedFrom === "transform" && pass.applied)).toBe(true);
        console.log(`served m[0] sha256 after the fold: ${sha256(JSON.stringify(served[0]))}`);
    }, 900_000);
});
