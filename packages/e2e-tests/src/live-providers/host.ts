/**
 * One throwaway OpenCode 1.18.30 host per scenario, wired to a real provider through the
 * loopback recorder.
 *
 * Every state root the host or Magic Context could touch (HOME, all XDG roots, OPENCODE_DB,
 * MAGIC_CONTEXT_STORAGE_DIR, TMPDIR) lives under the scenario root, and `lsof -p <host pid>`
 * must show every open database inside it. The provider key is written only into the
 * scenario's `opencode.json`; `dispose` deletes the whole root, key included.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareContextDatabase } from "../prepare-context-db";
import type { ProviderRoute } from "./types";

export const EXPECTED_HOST_VERSION = "1.18.30";
const repoRoot = resolve(import.meta.dir, "../../../..");
export const PLUGIN_ENTRY = join(repoRoot, "packages/plugin/dist/index.js");

export interface HostOptions {
    binary: string;
    root: string;
    route: ProviderRoute;
    apiKey: string;
    recorderBaseURL: string;
    magicContext: Record<string, unknown>;
    /** Optional models.dev catalogue copied into the host cache, so model metadata is current. */
    modelsCatalog?: string;
}

export interface Host {
    url: string;
    pid: number;
    workDir: string;
    contextDb: string;
    mcLogPath: string;
    hostLog(): string;
    /**
     * Magic Context config warnings logged so far. An invalid value silently falls back to its
     * default, so a scenario that ignored these would measure a different configuration.
     */
    configWarnings(): string[];
    api(path: string, body: unknown, timeoutMs?: number): Promise<{ status: number; value: unknown }>;
    /** Database files the host holds open; throws when any lies outside the scenario root. */
    checkIsolation(): string[];
    dispose(): Promise<void>;
}

function providerConfig(options: HostOptions): Record<string, unknown> {
    const { route } = options;
    return {
        [route.providerId]: {
            npm: route.npm,
            options: {
                ...route.providerOptions,
                apiKey: options.apiKey,
                baseURL: options.recorderBaseURL,
            },
            models: {
                [route.model]: {
                    name: route.model,
                    reasoning: true,
                    tool_call: true,
                    attachment: false,
                    temperature: false,
                    limit: { context: 200_000, output: 8_192 },
                    ...route.modelConfig,
                    options: route.modelOptions ?? {},
                },
            },
        },
    };
}

export async function startHost(options: HostOptions): Promise<Host> {
    const { root, route } = options;
    if (!root.includes("/magic-context/")) throw new Error("Scenario root must be under $TMPDIR/magic-context/");
    if (existsSync(root)) throw new Error(`Scenario root already exists: ${root}`);
    const dirs = Object.fromEntries(
        ["home", "config", "data", "cache", "state", "runtime", "work", "tmp"].map((key) => [key, join(root, key)]),
    ) as Record<string, string>;
    for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.modelsCatalog) {
        mkdirSync(join(dirs.cache, "opencode"), { recursive: true });
        copyFileSync(options.modelsCatalog, join(dirs.cache, "opencode", "models.json"));
    }
    const model = `${route.providerId}/${route.model}`;
    writeFileSync(
        join(dirs.config, "opencode.json"),
        JSON.stringify({
            plugin: [`file://${PLUGIN_ENTRY}`],
            provider: providerConfig(options),
            enabled_providers: [route.providerId],
            model,
            small_model: model,
            autoupdate: false,
            share: "disabled",
            compaction: { auto: false, prune: false },
            permission: { bash: "allow", edit: "deny", webfetch: "deny", external_directory: "deny" },
        }),
        { mode: 0o600 },
    );
    // Current Magic Context reads $XDG_CONFIG_HOME/cortexkit/magic-context.jsonc (the old
    // opencode/ location is migrated there on boot).
    mkdirSync(join(dirs.config, "cortexkit"), { recursive: true });
    writeFileSync(
        join(dirs.config, "cortexkit", "magic-context.jsonc"),
        JSON.stringify({
            dreamer: { disable: true },
            historian: { opencode: { model } },
            ...options.magicContext,
        }),
    );
    prepareContextDatabase(dirs.data);
    const storageDir = join(dirs.data, "cortexkit", "magic-context");
    const mcLogPath = join(root, "mc.log");
    const env: Record<string, string> = {
        PATH: process.env.PATH as string,
        HOME: dirs.home,
        XDG_CONFIG_HOME: dirs.config,
        XDG_DATA_HOME: dirs.data,
        XDG_CACHE_HOME: dirs.cache,
        XDG_STATE_HOME: dirs.state,
        XDG_RUNTIME_DIR: dirs.runtime,
        OPENCODE_CONFIG_DIR: dirs.config,
        OPENCODE_DB: join(dirs.data, "opencode", "live.db"),
        MAGIC_CONTEXT_STORAGE_DIR: storageDir,
        MAGIC_CONTEXT_LOG_PATH: mcLogPath,
        TMPDIR: dirs.tmp,
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
    };
    const version = Bun.spawnSync([options.binary, "--version"], { env, windowsHide: true }).stdout.toString().trim();
    if (version !== EXPECTED_HOST_VERSION) throw new Error(`Expected OpenCode ${EXPECTED_HOST_VERSION}, got ${version}`);
    const port = 22000 + Math.floor(Math.random() * 20000);
    const child: ChildProcess = spawn(
        options.binary,
        ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
        { cwd: dirs.work, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let logs = "";
    child.stdout?.on("data", (chunk) => (logs += chunk));
    child.stderr?.on("data", (chunk) => (logs += chunk));
    const url = `http://127.0.0.1:${port}`;

    const api = async (path: string, body: unknown, timeoutMs = 120_000) => {
        const separator = path.includes("?") ? "&" : "?";
        const res = await fetch(`${url}${path}${separator}directory=${encodeURIComponent(dirs.work)}`, {
            method: body === undefined ? "GET" : "POST",
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, value: await res.json().catch(() => null) };
    };

    const checkIsolation = () => {
        const out = Bun.spawnSync(["lsof", "-p", String(child.pid)], { windowsHide: true }).stdout.toString();
        writeFileSync(join(root, "lsof.txt"), out);
        const rows = out.split("\n").filter((line) => /REG/.test(line) && /\.db(?:-|\s|$)/.test(line));
        if (!rows.length || rows.some((line) => !line.includes(root))) {
            throw new Error(`Database isolation failed: ${rows.join(" | ")}`);
        }
        return rows.map((line) => (line.split(/\s+/).slice(8).join(" ") as string).replace(root, "<root>"));
    };

    const dispose = async () => {
        if (child.exitCode === null) {
            child.kill("SIGTERM");
            const exited = await Promise.race([
                new Promise<boolean>((r) => child.once("exit", () => r(true))),
                Bun.sleep(15_000).then(() => false),
            ]);
            if (!exited) child.kill("SIGKILL");
        }
        rmSync(root, { recursive: true, force: true });
    };

    let ready = false;
    for (let i = 0; i < 120 && !ready; i++) {
        try {
            ready = (await fetch(`${url}/session`, { signal: AbortSignal.timeout(1000) })).ok;
        } catch {}
        if (!ready) await Bun.sleep(500);
    }
    if (!ready) {
        await dispose();
        throw new Error(`host did not start: ${logs.slice(-2000)}`);
    }

    return {
        url,
        pid: child.pid as number,
        workDir: dirs.work,
        contextDb: join(storageDir, "context.db"),
        mcLogPath,
        hostLog: () => logs,
        configWarnings: () =>
            readIfExists(mcLogPath)
                .split("\n")
                .filter((line) => line.includes("config warning")),
        api,
        checkIsolation,
        dispose,
    };
}

export function readIfExists(path: string): string {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
}
