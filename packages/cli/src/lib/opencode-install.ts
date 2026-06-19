import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { findOnPath } from "./find-on-path";

/** Stock OpenCode install location (~/.opencode/bin), OS-specific binary name. */
export function resolveStockOpenCodeBinary(): string {
    const isWindows = process.platform === "win32";
    return isWindows
        ? join(homedir(), ".opencode", "bin", "opencode.exe")
        : join(homedir(), ".opencode", "bin", "opencode");
}

/**
 * Whether OpenCode is installed — matches OpenCodeAdapter.isInstalled() and doctor
 * (stock bin first, then PATH walk). Avoids shelling out to `opencode --version`,
 * which fails in sandboxes where the binary exists but exec is blocked.
 */
export function isOpenCodeInstalledOnSystem(): boolean {
    const stockBin = resolveStockOpenCodeBinary();
    if (existsSync(stockBin)) return true;
    return findOnPath("opencode") !== null;
}
