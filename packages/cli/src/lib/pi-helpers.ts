import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "./find-on-path";

export interface PiBinaryInfo {
    path: string;
    source: "path" | "home";
}

export const PI_PACKAGE_SOURCE = "npm:@cortexkit/pi-magic-context";

const STATIC_MODELS = [
    "anthropic/claude-haiku-4-5",
    "anthropic/claude-sonnet-4-6",
    "github-copilot/claude-sonnet-4.6",
    "github-copilot/gpt-5.4",
    "github-copilot/gpt-5-mini",
    "github-copilot/gemini-3-flash-preview",
    "openai/gpt-5.4",
    "openai/gpt-5.4-mini",
    "opencode-go/glm-5",
    "opencode-go/minimax-m2.7",
    "ollama/qwen2.5-coder:7b",
    "cerebras/llama3.1-8b",
];

export function getStaticModels(): string[] {
    return [...STATIC_MODELS];
}

export function detectPiBinary(): PiBinaryInfo | null {
    // Node-only PATH walker, not which/where: shelling out fails in
    // Alpine/slim/Nix/bunx sandboxes that lack those binaries (same reason the
    // OpenCode detector switched to findOnPath). findOnPath handles platform
    // extensions (.cmd/.exe) and X_OK checks internally.
    const fromPath = findOnPath("pi");
    if (fromPath) return { path: fromPath, source: "path" };

    const homeCandidate =
        process.platform === "win32"
            ? join(homedir(), ".pi", "bin", "pi.cmd")
            : join(homedir(), ".pi", "bin", "pi");
    if (existsSync(homeCandidate)) return { path: homeCandidate, source: "home" };

    return null;
}

export function getPiVersion(piPath: string): string | null {
    // Pi >= 0.71.x writes `--version` output to stderr, not stdout. Use
    // spawnSync (not execFileSync) so we get both streams back even on
    // a clean exit. Prefer stdout when present so future Pi versions
    // that switch back to stdout still work.
    try {
        const result = spawnSync(piPath, ["--version"], {
            encoding: "utf-8",
            timeout: 10_000,
        });
        const stdout = result.stdout?.trim();
        if (stdout) return stdout;
        const stderr = result.stderr?.trim();
        if (stderr) return stderr;
        return null;
    } catch {
        return null;
    }
}

function runPi(piPath: string, args: string[]): string | null {
    try {
        return execFileSync(piPath, args, {
            encoding: "utf-8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 20_000,
        }).trim();
    } catch {
        return null;
    }
}

function stripAnsi(text: string): string {
    return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
}

// provider / model identifier shapes — letters, digits, and the punctuation that
// real ids use (gpt-5.4, qwen2.5-coder:7b, claude-fable-5, opencode-go,
// github-copilot). No slash inside either half; the slash only joins them.
const PROVIDER_TOKEN = /^[a-z0-9][a-z0-9._-]*$/i;
const MODEL_TOKEN = /^[a-z0-9][a-z0-9._:-]*$/i;

/**
 * Parse `pi --list-models` output into `provider/model` ids.
 *
 * Pi prints a fixed-width TABLE, not slash-joined ids:
 *
 *     provider      model                context  max-out  thinking  images
 *     anthropic     claude-fable-5       1M       128K     yes       yes
 *     openai-codex  gpt-5.4              1M       128K     yes       yes
 *
 * The first two whitespace-separated columns are `provider` and `model`; we join
 * them. (The previous parser required each token to already contain `/`, so the
 * table produced ZERO matches and setup fell back to a hardcoded model list the
 * user didn't have — issue #144.) A pre-joined `provider/model` first token is
 * still accepted for forward-compat with any future slash-formatted output.
 */
export function parseModelListOutput(output: string): string[] {
    const models = new Set<string>();
    for (const rawLine of stripAnsi(output).split(/\r?\n/)) {
        const line = rawLine.trim().replace(/^[•*-]\s*/, "");
        if (!line || line.toLowerCase().includes("usage:")) continue;

        const cols = line.split(/\s+/);
        const first = cols[0]?.replace(/,$/, "") ?? "";

        // Already slash-joined (forward-compat): take the first token verbatim.
        if (first.includes("/")) {
            if (!/^https?:\/\//.test(first)) models.add(first);
            continue;
        }

        // Table row: column 0 = provider, column 1 = model. Skip the header
        // (`provider  model  …`) and any non-identifier rows (separators, notes).
        const provider = first;
        const model = cols[1]?.replace(/,$/, "") ?? "";
        if (provider.toLowerCase() === "provider" && model.toLowerCase() === "model") {
            continue;
        }
        if (PROVIDER_TOKEN.test(provider) && MODEL_TOKEN.test(model)) {
            models.add(`${provider}/${model}`);
        }
    }
    return [...models];
}

export function getAvailableModels(piPath: string): string[] {
    // `pi --list-models` is the canonical command (prints the provider/model
    // table). Try it first, then the older `models list` subcommand for
    // forward/backward compat.
    const outputs = [runPi(piPath, ["--list-models"]), runPi(piPath, ["models", "list"])];
    for (const output of outputs) {
        if (!output) continue;
        const models = parseModelListOutput(output);
        if (models.length > 0) return models;
    }
    return getStaticModels();
}

export function buildModelSelection(
    allModels: string[],
    role: "historian" | "dreamer" | "sidekick",
): { label: string; value: string; recommended?: boolean }[] {
    const result: { label: string; value: string; recommended?: boolean }[] = [];
    const added = new Set<string>();

    const addIfAvailable = (pattern: string, hint?: string) => {
        const matches = allModels.filter((m) => m === pattern || m.endsWith(`/${pattern}`));
        for (const model of matches) {
            if (added.has(model)) continue;
            added.add(model);
            result.push({
                label: hint ? `${model} — ${hint}` : model,
                value: model,
                recommended: result.length === 0,
            });
        }
    };

    if (role === "historian") {
        addIfAvailable("anthropic/claude-haiku-4-5", "fast/cheap default");
        addIfAvailable("github-copilot/claude-sonnet-4.6", "per-request billing");
        addIfAvailable("anthropic/claude-sonnet-4-6");
        addIfAvailable("github-copilot/gpt-5.4", "per-request billing");
        addIfAvailable("openai/gpt-5.4");
        addIfAvailable("opencode-go/minimax-m2.7");
        addIfAvailable("opencode-go/glm-5");
    } else if (role === "dreamer") {
        for (const model of allModels.filter((m) => m.startsWith("ollama/"))) {
            if (added.has(model)) continue;
            added.add(model);
            result.push({
                label: `${model} — local`,
                value: model,
                recommended: result.length === 0,
            });
        }
        addIfAvailable("anthropic/claude-sonnet-4-6", "recommended quality default");
        addIfAvailable("github-copilot/claude-sonnet-4.6", "per-request billing");
        addIfAvailable("github-copilot/gemini-3-flash-preview", "fast/cheap");
        addIfAvailable("opencode-go/glm-5");
        addIfAvailable("opencode-go/minimax-m2.7");
    } else {
        for (const model of allModels.filter((m) => m.startsWith("cerebras/"))) {
            if (added.has(model)) continue;
            added.add(model);
            result.push({
                label: `${model} — fast`,
                value: model,
                recommended: result.length === 0,
            });
        }
        addIfAvailable("github-copilot/gemini-3-flash-preview", "fast");
        addIfAvailable("github-copilot/gpt-5-mini", "fast");
        addIfAvailable("openai/gpt-5.4-mini", "fast");
        addIfAvailable("anthropic/claude-haiku-4-5", "fast");
    }

    for (const model of allModels) {
        if (result.length >= 30) break;
        if (added.has(model)) continue;
        added.add(model);
        result.push({
            label: model,
            value: model,
            recommended: result.length === 0,
        });
    }

    return result;
}
