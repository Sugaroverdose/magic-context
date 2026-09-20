#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { MockProvider } from "../src/mock-provider/server";
import { spawnOpencode } from "../src/opencode-runner/spawn";
import { openTestDb } from "../src/test-db";
import { appendCompartments } from "../../plugin/src/features/magic-context/compartment-storage";
import { setPendingCompactionMarkerState } from "../../plugin/src/features/magic-context/storage-meta-persisted";

process.env.MC_E2E_MODE = "ts";
const output = resolve(Bun.argv[2] ?? "ckios-probe-output");
mkdirSync(output, { recursive: true });
// MC_SPECIMEN_DIR supplies store-rows.txt with captured reasoning and a completion notice.
// Replay only those inert parts; captured tool commands may mutate real projects.
const specimen = process.env.MC_SPECIMEN_DIR;
const storeRows = specimen ? readFileSync(resolve(specimen, "store-rows.txt"), "utf8").split("\n") : [];
const partFor = (mid: string, type: string) => storeRows.flatMap(line => {
    const [id, owner, ...data] = line.split("|");
    if (!id?.startsWith("prt_") || owner !== mid) return [];
    const part = JSON.parse(data.join("|"));
    return part.type === type ? [part] : [];
})[0];
const stagedThinking = partFor("msg_0bedb7d8f001FvFOQdZoGqywkr", "reasoning");
const thinkingText = stagedThinking?.text ?? "CKIOS_REASONING_ONLY";
const thinkingSignature = stagedThinking?.metadata?.anthropic?.signature ?? "fixture-signature";
const notice = partFor("msg_0bedbd073001dWTdnRGldoxnBq", "text")?.text ?? "<system-reminder>[BACKGROUND BASH COMPLETED]</system-reminder>";
for (const lane of ["plain", "mc", "marker"].filter(lane => !process.env.MC_PROBE_LANE || process.env.MC_PROBE_LANE === lane)) {
    const enabled = lane !== "plain";
    const mock = new MockProvider();
    const { baseURL } = await mock.start();
    mock.setDefault({ text: "finished", usage: { input_tokens: 1000, output_tokens: 1 } });
    mock.addMatcher(body => JSON.stringify(body.messages).includes("Generate a title for this conversation:") ? { text: "Fixture", usage: { input_tokens: 10, output_tokens: 1 } } : null);
    const probes = ["before", "after"].map(stage => {
        const path = `${output}/${lane}-${stage}-plugin.ts`;
        writeFileSync(path, `import { appendFileSync } from 'node:fs';\nexport default async () => ({ 'experimental.chat.messages.transform': async (_input, output) => { appendFileSync(${JSON.stringify(`${output}/${lane}-${stage}.jsonl`)}, JSON.stringify(output.messages) + '\\n'); } });\n`);
        return `file://${path}`;
    });
    const host = await spawnOpencode({
        mockProviderURL: baseURL,
        mockProviderID: "anthropic",
        mockModelID: "claude-opus-5",
        expectedMagicContextState: enabled ? "enabled" : "configured-disabled",
        prepareContextDatabase: enabled,
        extraEnv: { MAGIC_CONTEXT_LOG_PATH: `${output}/${lane}.log` },
        openCodeConfigExtra: { plugin: enabled ? [probes[0], `file://${resolve(import.meta.dir, '../../plugin/src/index.ts')}`, probes[1]] : probes },
        magicContextConfig: { execute_threshold_percentage: 90, compressor: { enabled: false }, memory: { auto_search: { enabled: false } } },
    });
    try {
        const client = createOpencodeClient({ baseUrl: host.url });
        const session = await client.session.create({ query: { directory: host.env.workdir }, throwOnError: true });
        const id = session.data!.id;
        const prompt = async (text: string, synthetic = false) => client.session.prompt({
            path: { id }, query: { directory: host.env.workdir }, throwOnError: true,
            body: { model: { providerID: "anthropic", modelID: "claude-opus-5" }, parts: [{ type: "text", text, synthetic }] },
        });
        if (lane === "marker") {
            await prompt("older history to compact");
            await prompt("boundary user before retained tail");
            const history = (await client.session.messages({ path: { id }, query: { directory: host.env.workdir }, throwOnError: true })).data!;
            const boundary = history[2].info.id;
            const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                const storageDb = db as unknown as Parameters<typeof appendCompartments>[0];
                appendCompartments(storageDb, id, [{ sequence: 0, startMessage: 1, endMessage: 3, startMessageId: history[0].info.id, endMessageId: boundary, title: "Compacted fixture", content: "Older fixture history." }]);
                setPendingCompactionMarkerState(storageDb, id, { ordinal: 3, endMessageId: boundary, publishedAt: Date.now() });
            } finally { db.close(); }
            // Reload the plugin so startup restores the pending marker's deferred signals.
            await client.instance.dispose({ query: { directory: host.env.workdir }, throwOnError: true });
        }
        mock.script([
            { content: [{ type: "tool_use", id: "tool-first", name: "bash", input: { command: "printf done", description: "fixture" } }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 1 } },
            { content: [{ type: "thinking", thinking: thinkingText, signature: thinkingSignature }], stop_reason: "end_turn", usage: { input_tokens: lane === "marker" ? 185000 : 1000, output_tokens: 1 } },
        ]);
        await prompt("Run the fixture");
        writeFileSync(`${output}/${lane}-store-before.json`, JSON.stringify((await client.session.messages({ path: { id }, query: { directory: host.env.workdir } })).data, null, 2));
        const first = mock.requests().length;
        mock.script([
            { content: [{ type: "thinking", thinking: "NEWEST_THINKING", signature: "new-signature" }, { type: "tool_use", id: "tool-second", name: "bash", input: { command: "printf next", description: "fixture next" } }], stop_reason: "tool_use", usage: { input_tokens: 1000, output_tokens: 1 } },
            { text: "done", usage: { input_tokens: 1000, output_tokens: 1 } },
        ]);
        await prompt(notice, true);
        const bodies = mock.requests().slice(first).map(request => request.body);
        if (lane === "marker") {
            const db = openTestDb(resolve(host.env.dataDir, "cortexkit/magic-context/context.db"));
            try {
                const state = db.query("SELECT pending_compaction_marker_state, compaction_marker_state FROM session_meta WHERE session_id = ?").get(id);
                writeFileSync(`${output}/${lane}-state.json`, JSON.stringify(state, null, 2));
                console.log(JSON.stringify({ lane, state }));
            } finally { db.close(); }
        }
        writeFileSync(`${output}/${lane}-bodies.json`, JSON.stringify(bodies, null, 2));
        writeFileSync(`${output}/${lane}-host.json`, JSON.stringify({ env: host.env, session: id }));
        for (const [index, body] of bodies.entries()) {
            const messages = body.messages ?? [];
            console.log(JSON.stringify({ lane, index, target: messages.findIndex(message => JSON.stringify(message).includes(JSON.stringify(thinkingText).slice(1, -1))), sha256: createHash("sha256").update(JSON.stringify(messages)).digest("hex"), tail: messages.slice(-5) }));
        }
    } finally {
        await host.kill();
        await mock.stop();
    }
}
