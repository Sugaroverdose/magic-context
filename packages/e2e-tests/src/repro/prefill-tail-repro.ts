/**
 * Real-host reproduction harness for "This model does not support assistant
 * message prefill. The conversation must end with a user message."
 *
 * Boots a real `opencode serve` (any 1.x binary) under a throwaway root, points
 * it at a mock Anthropic endpoint that applies the provider's own rule — HTTP 400
 * with exactly that message whenever the last request message is not role
 * `user` — and runs an orchestrator session that spawns a subagent through the
 * `task` tool. The subagent runs a tool loop whose reported input grows with the
 * real request size, so a small configured window walks it through Magic
 * Context's execute threshold and into the emergency bands.
 *
 * Every provider request is recorded (lane, last role, tail block shapes); any
 * request that trips the rule is saved in full as `prefill-<n>.json`.
 *
 * Usage:
 *   bun run src/repro/prefill-tail-repro.ts --opencode <bin> --plugin <entry|none>
 *     --out <dir> [--window 40000] [--sub-steps 24] [--agent-steps 0]
 *     [--text-with-tool] [--agent worker] [--big-tokens 1500]
 *     [--thinking every|none|alternate]
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockProvider, type MockResponse } from "../mock-provider/server";

const PREFILL_MESSAGE =
    "This model does not support assistant message prefill. The conversation must end with a user message.";

interface Args {
    opencode: string;
    plugin: string;
    out: string;
    window: number;
    subSteps: number;
    agentSteps: number;
    textWithTool: boolean;
    agent: string;
    bigTokens: number;
    /** every: thinking on every step; none: never; alternate: odd steps only. */
    thinking: "every" | "none" | "alternate";
}

function parseArgs(argv: string[]): Args {
    const get = (name: string, fallback?: string): string => {
        const index = argv.indexOf(`--${name}`);
        if (index >= 0 && argv[index + 1] !== undefined) return argv[index + 1];
        if (fallback === undefined) throw new Error(`missing --${name}`);
        return fallback;
    };
    return {
        opencode: resolve(get("opencode")),
        plugin: get("plugin"),
        out: resolve(get("out")),
        window: Number(get("window", "40000")),
        subSteps: Number(get("sub-steps", "24")),
        agentSteps: Number(get("agent-steps", "0")),
        textWithTool: argv.includes("--text-with-tool"),
        agent: get("agent", "worker"),
        bigTokens: Number(get("big-tokens", "1500")),
        thinking: get("thinking", "every") as Args["thinking"],
    };
}

type Block = { type?: string; text?: string; tool_use_id?: string; name?: string };
type Msg = { role: string; content: unknown };

function blocks(message: Msg): Block[] {
    if (typeof message.content === "string") return [{ type: "text", text: message.content }];
    return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

function firstUserText(messages: Msg[]): string {
    const first = messages.find((m) => m.role === "user");
    return first ? blocks(first).map((b) => b.text ?? "").join(" ") : "";
}

function tailShape(messages: Msg[]): string[] {
    return messages.slice(-3).map((m) => `${m.role}:${blocks(m).map((b) => b.type).join("+")}`);
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const dirs = {
        home: join(args.out, "home"),
        config: join(args.out, "config"),
        data: join(args.out, "data"),
        cache: join(args.out, "cache"),
        state: join(args.out, "state"),
        work: join(args.out, "work"),
    };
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
    const requestLog = join(args.out, "requests.jsonl");
    writeFileSync(requestLog, "");

    // Tool outputs the subagent reads. Sized in tokens (≈4 chars each) so a
    // handful of steps crosses the configured window's thresholds.
    for (let i = 0; i < 4; i += 1) {
        writeFileSync(
            join(dirs.work, `f${i}.txt`),
            `${`file ${i} line of filler text for the tool loop `.repeat(Math.ceil((args.bigTokens * 4) / 48))}\n`,
        );
    }

    const mock = new MockProvider();
    const { baseURL } = await mock.start();
    let subStep = 0;
    let prefillHits = 0;
    let requestIndex = 0;

    mock.addMatcher((body) => {
        requestIndex += 1;
        const messages = (body.messages ?? []) as Msg[];
        const tools = (body.tools ?? []) as Array<{ name?: string }>;
        const first = firstUserText(messages);
        const lane = first.includes("SUBAGENT_RUN")
            ? "subagent"
            : first.includes("PARENT_RUN")
              ? "parent"
              : "other";
        const lastRole = messages.at(-1)?.role ?? "none";
        // Input grows with the real request so drops show up as real relief.
        const inputTokens = Math.ceil(JSON.stringify(body).length / 4);
        const record = {
            index: requestIndex,
            lane,
            messages: messages.length,
            lastRole,
            tail: tailShape(messages),
            inputTokens,
            pct: Number(((inputTokens / args.window) * 100).toFixed(1)),
            rejected: lastRole !== "user",
        };
        appendFileSync(requestLog, `${JSON.stringify(record)}\n`);

        // The provider's own rule: an assistant-terminated conversation is a
        // prefill request, which these models reject outright.
        if (lastRole !== "user") {
            prefillHits += 1;
            writeFileSync(
                join(args.out, `prefill-${requestIndex}.json`),
                JSON.stringify(body, null, 2),
            );
            return {
                error: { status: 400, type: "invalid_request_error", message: PREFILL_MESSAGE },
            };
        }
        const usage = { input_tokens: inputTokens, output_tokens: 40 };

        if (lane === "parent") {
            const taskDone = messages.some((m) =>
                blocks(m).some((b) => b.type === "tool_result" && b.tool_use_id === "toolu_task"),
            );
            if (taskDone || !tools.some((t) => t.name === "task")) {
                return { text: "parent done", stop_reason: "end_turn", usage } satisfies MockResponse;
            }
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_task",
                        name: "task",
                        input: {
                            description: "sub work",
                            prompt: "SUBAGENT_RUN read the files one by one",
                            subagent_type: args.agent,
                        },
                    },
                ],
                stop_reason: "tool_use",
                usage,
            } satisfies MockResponse;
        }

        if (lane === "subagent") {
            subStep += 1;
            if (subStep > args.subSteps) {
                return { text: "subagent finished", stop_reason: "end_turn", usage };
            }
            const parallel = subStep % 5 === 0 ? 3 : 1;
            const content: unknown[] = [];
            if (args.thinking === "every" || (args.thinking === "alternate" && subStep % 2 === 1)) {
                content.push({
                    type: "thinking",
                    thinking: `step ${subStep} reasoning`,
                    signature: `sig-${subStep}`,
                });
            }
            if (args.textWithTool) content.push({ type: "text", text: `Reading batch ${subStep}.` });
            for (let i = 0; i < parallel; i += 1) {
                content.push({
                    type: "tool_use",
                    id: `toolu_s${subStep}_${i}`,
                    name: "bash",
                    input: { command: `cat f${(subStep + i) % 4}.txt`, description: "read file" },
                });
            }
            return { content, stop_reason: "tool_use", usage };
        }

        // Title generation, historian, anything else: a short valid answer.
        return { text: "OK", stop_reason: "end_turn", usage };
    });

    const providerModels = {
        "mock-sonnet": {
            id: "mock-sonnet",
            name: "Mock Sonnet",
            cost: { input: 0, output: 0 },
            limit: { context: args.window, output: 8192 },
            reasoning: true,
            modalities: { input: ["text"], output: ["text"] },
            options: {},
        },
    };
    const worker: Record<string, unknown> = {
        mode: "subagent",
        description: "Reads files for the orchestrator.",
        prompt: "You read files.",
    };
    if (args.agentSteps > 0) worker.steps = args.agentSteps;
    const opencodeConfig = {
        $schema: "https://opencode.ai/config.json",
        plugin: args.plugin === "none" ? [] : [`file://${resolve(args.plugin)}`],
        autoupdate: false,
        share: "disabled",
        compaction: { auto: false, prune: false },
        permission: { bash: "allow", edit: "allow", read: "allow", task: "allow" },
        provider: {
            "mock-anthropic": {
                npm: "@ai-sdk/anthropic",
                name: "Mock Anthropic",
                env: [],
                options: { apiKey: "test-key-not-real", baseURL },
                models: providerModels,
            },
        },
        enabled_providers: ["mock-anthropic"],
        model: "mock-anthropic/mock-sonnet",
        small_model: "mock-anthropic/mock-sonnet",
        agent: { worker },
    };
    writeFileSync(join(dirs.config, "opencode.json"), JSON.stringify(opencodeConfig, null, 2));
    // Defaults otherwise (the reporter's config only pins historian/dreamer models).
    const mcConfig = {
        historian: { model: "mock-anthropic/mock-sonnet" },
        dreamer: { disable: true },
        embedding: { provider: "off" },
    };
    mkdirSync(join(dirs.config, "cortexkit"), { recursive: true });
    writeFileSync(join(dirs.config, "cortexkit", "magic-context.jsonc"), JSON.stringify(mcConfig, null, 2));

    const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        OPENCODE_CONFIG_DIR: dirs.config,
        OPENCODE_DB: "issue-repro.db",
        MAGIC_CONTEXT_STORAGE_DIR: join(dirs.data, "cortexkit", "magic-context"),
        MAGIC_CONTEXT_LOG_PATH: join(args.out, "magic-context.log"),
        ANTHROPIC_API_KEY: "test-key-not-real",
        TMPDIR: join(args.out, "tmp"),
    };
    mkdirSync(env.TMPDIR, { recursive: true });

    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(args.opencode, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        cwd: dirs.work,
        env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let serverLog = "";
    child.stdout?.on("data", (chunk) => (serverLog += chunk));
    child.stderr?.on("data", (chunk) => (serverLog += chunk));
    const url = `http://127.0.0.1:${port}`;
    const summary: Record<string, unknown> = { args, url };
    try {
        for (let i = 0; ; i += 1) {
            try {
                const res = await fetch(`${url}/session`, { signal: AbortSignal.timeout(2000) });
                if (res.ok) break;
            } catch {}
            if (i > 300) throw new Error(`serve never came up:\n${serverLog}`);
            await Bun.sleep(500);
        }
        await Bun.sleep(1500);
        const lsof = Bun.spawnSync(["lsof", "-p", String(child.pid)]).stdout.toString();
        const dbLines = lsof.split("\n").filter((l) => /\.db|context|cortexkit|opencode/.test(l) && /REG/.test(l));
        writeFileSync(join(args.out, "lsof.txt"), dbLines.join("\n"));

        const created = (await (
            await fetch(`${url}/session?directory=${encodeURIComponent(dirs.work)}`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({}),
            })
        ).json()) as { id: string };
        summary.parent = created.id;
        await fetch(`${url}/session/${created.id}/message?directory=${encodeURIComponent(dirs.work)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                agent: "build",
                parts: [{ type: "text", text: "PARENT_RUN delegate the reading to a subagent" }],
            }),
            signal: AbortSignal.timeout(15 * 60_000),
        });
        const lsofAfter = Bun.spawnSync(["lsof", "-p", String(child.pid)]).stdout.toString();
        writeFileSync(
            join(args.out, "lsof-after.txt"),
            lsofAfter.split("\n").filter((l) => /\.db/.test(l)).join("\n"),
        );
        const children = (await (
            await fetch(`${url}/session/${created.id}/children?directory=${encodeURIComponent(dirs.work)}`)
        ).json()) as Array<{ id: string }>;
        summary.children = children.map((c) => c.id);
        const errors: unknown[] = [];
        for (const id of [created.id, ...children.map((c) => c.id)]) {
            const msgs = (await (
                await fetch(`${url}/session/${id}/message?directory=${encodeURIComponent(dirs.work)}`)
            ).json()) as Array<{ info: { role: string; error?: { data?: { message?: string } } } }>;
            for (const m of msgs) if (m.info.error) errors.push({ session: id, error: m.info.error });
            if (id !== created.id) summary.subagentMessages = msgs.length;
        }
        summary.assistantErrors = errors;
    } finally {
        child.kill("SIGTERM");
        await mock.stop();
        writeFileSync(join(args.out, "serve.log"), serverLog);
    }
    const records = readFileSync(requestLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    summary.requests = records.length;
    summary.subagentRequests = records.filter((r) => r.lane === "subagent").length;
    summary.prefillRejections = prefillHits;
    summary.maxSubagentPct = Math.max(0, ...records.filter((r) => r.lane === "subagent").map((r) => r.pct));
    writeFileSync(join(args.out, "summary.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify(summary, null, 2));
}

await main();
