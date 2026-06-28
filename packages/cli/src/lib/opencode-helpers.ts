import { execFileSync, execSync } from "node:child_process";

/**
 * Run `opencode <args>`. If a `binary` path is given (an absolute path resolved
 * for a stock `~/.opencode/bin` install or a version-manager shim that is not on
 * PATH), call that exact path via execFile; otherwise fall back to a bare
 * `opencode` on PATH.
 */
function runOpenCode(args: string[], binary?: string | null): string | null {
    try {
        if (binary) {
            return execFileSync(binary, args, { stdio: "pipe" }).toString().trim();
        }
        return execSync(`opencode ${args.join(" ")}`, { stdio: "pipe" })
            .toString()
            .trim();
    } catch {
        return null;
    }
}

export function getOpenCodeVersion(binary?: string | null): string | null {
    return runOpenCode(["--version"], binary);
}

export function getAvailableModels(binary?: string | null): string[] {
    const output = runOpenCode(["models"], binary);
    if (output === null) return [];
    return output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
}
