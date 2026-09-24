import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "bun:sqlite";
import { isolation, spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const todos = [{ content: "Finish the fixture", status: "in_progress", priority: "high" }];

function todoState(path: string, sessionID: string): string {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        return (db.prepare("SELECT last_todo_state AS state FROM session_meta WHERE session_id = ?")
            .get(sessionID) as { state: string } | undefined)?.state ?? "";
    } finally { db.close(); }
}

async function until(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (check()) return;
        await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${label}`);
}

test("a real todowrite call projects a synthetic reminder on priced and cached OC2 passes", async () => {
    const fixture = isolation();
    const probe = join(fixture.root, "native-todowrite");
    mkdirSync(probe);
    // AFT-like extra tool: OpenCode 2 does not ship its own native todowrite.
    writeFileSync(join(probe, "server.js"), `export default {
        id: "native-todowrite-fixture", async setup(context) {
            await context.tool.transform(editor => editor.add({
                name: "todowrite", description: "Record the current todo list",
                input: { type: "object", properties: { todos: { type: "array", items: { type: "object", properties: {
                    content: { type: "string" }, status: { type: "string" }, priority: { type: "string" }
                }, required: ["content", "status", "priority"] } } }, required: ["todos"] },
                options: { codemode: false }, async execute(input) { return { content: JSON.stringify(input.todos) }; }
            }));
        }
    };`);
    let host: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        const options = {
            existingIsolation: fixture,
            probePlugin: probe,
            modelContextLimit: 100_000,
            modelOutputLimit: 1024,
            compactionAuto: false,
            magicContextConfig: { execute_threshold_percentage: 20, historian: { disable: true },
                dreamer: { disable: true }, memory: { enabled: false } },
        };
        host = await spawnOpencode2(options);
        const mock = host.mock;
        mock.setDefault({ text: "ok", usage: { input_tokens: 1000, output_tokens: 20 } });
        let issued = false;
        mock.addMatcher((body) => {
            const wire = JSON.stringify(body);
            if (issued || !wire.includes("record the todo state") || !wire.includes('"name":"todowrite"')) return null;
            issued = true;
            return { openaiOutput: [{ type: "function_call", id: "fc_todo_fixture", call_id: "call_todo_fixture",
                name: "todowrite", arguments: JSON.stringify({ todos }) }],
                usage: { input_tokens: 1000, output_tokens: 20 } };
        });
        let client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        const session = await client.session.create({ location: { directory: fixture.cwd },
            model: { providerID: "openai", id: "mock-model" } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: session.id, text: "record the todo state" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        expect(issued).toBe(true);
        const contextPath = join(fixture.env.XDG_DATA_HOME!, "cortexkit", "magic-context", "context.db");
        await until(() => todoState(contextPath, session.id).includes("Finish the fixture"), "persisted todowrite state");
        await host.stopHost();
        host = undefined;
        host = await spawnOpencode2({ ...options,
            magicContextConfig: { ...options.magicContextConfig, memory: { enabled: true } } });
        client = OpenCode.make({ baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` } });
        await waitForPluginActive(client, fixture.cwd);
        await client.session.prompt({ sessionID: session.id, text: "use the todo reminder" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        const pricedDb = new Database(contextPath, { readonly: true, fileMustExist: true });
        const anchor = pricedDb.prepare("SELECT todo_synthetic_call_id AS callId FROM session_meta WHERE session_id = ?")
            .get(session.id) as { callId: string } | undefined;
        pricedDb.close();
        expect(anchor?.callId).toMatch(/^mc_synthetic_todo_[0-9a-f]{16}$/);
        await client.session.prompt({ sessionID: session.id, text: "replay the todo reminder" });
        await client.session.wait({ sessionID: session.id }, { signal: AbortSignal.timeout(30_000) });
        const schemaTrace = readFileSync(join(fixture.root, "llm-schema-guard.jsonl"), "utf8");
        expect(schemaTrace.split("\n").filter((line) => line.startsWith(`PASS ${session.id} `)).length).toBeGreaterThanOrEqual(3);
    } finally {
        if (host) await host.stopHost();
    }
}, 180_000);
