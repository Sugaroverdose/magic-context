/**
 * Doctor check for a stale Magic Context install in OpenCode 2's plugin cache.
 *
 * OpenCode 2 installs npm plugins under `<cache>/opencode/npm/<name>@<spec>/`
 * (one numbered generation per install) instead of the 1.x
 * `<cache>/opencode/packages/` tree. For an `@latest` (or bare) entry the host
 * installs once and then keeps loading that generation: at startup it only
 * flags the plugin `outdated`, and its "check for updates" action (ctrl+r in
 * the plugins dialog) refreshes that flag without touching the cache. A new
 * release is installed only when the user asks the host to update the plugin
 * (ctrl+u in the plugins dialog, or `opencode plugin update`), or when the
 * slot is missing at startup, in which case the host installs the current
 * `latest` into a fresh slot.
 *
 * This check reports a cached install older than the latest published version
 * and, under `doctor --fix` (or `--force`), removes Magic Context's own slot so
 * the next OpenCode start installs the current release. Only that one slot is
 * ever removed: other packages' slots and version-pinned Magic Context slots
 * are left alone.
 *
 * The slot is never removed while an OpenCode process may be using it. A
 * running host keeps no file inside the slot open once the plugin is loaded
 * (the module is already in memory), so an open-file scan of the slot alone
 * cannot see it. What every running host does hold open is its session
 * database, so the probe asks `lsof` for any process holding the resolved
 * OpenCode database (or its `-wal`/`-shm` files) or any file inside the slot
 * (an install in progress). If `lsof` is unavailable or fails, use cannot be
 * ruled out and the slot is left in place.
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { compareSemverCore } from "@magic-context/core/hooks/auto-update-checker/semver";
import {
    getOpenCodeV2PluginCacheSlot,
    readOpenCodeV2CachedPluginVersion,
} from "../lib/opencode-plugin-cache";

export type HostUseProbe =
    | { status: "free" }
    | { status: "in_use"; pids: number[] }
    | { status: "unknown"; reason: string };

export interface HostUseProbeTargets {
    /** Files a running OpenCode host keeps open (its session database). */
    files: string[];
    /** Directories whose open files mean an install or load is in progress. */
    directories: string[];
}

type SpawnLike = (
    command: string,
    args: string[],
    options: { encoding: "utf-8"; timeout: number },
) => { status: number | null; stdout?: string | null; error?: Error };

function runLsof(args: string[], spawn: SpawnLike): { pids: number[] } | { error: string } {
    const result = spawn("lsof", args, { encoding: "utf-8", timeout: 15_000 });
    if (result.error) return { error: result.error.message };
    // lsof exits 1 when no process matches; any other non-zero status is a failure.
    if (result.status !== 0 && result.status !== 1) {
        return { error: `lsof exited with status ${String(result.status)}` };
    }
    const pids = (result.stdout ?? "")
        .split(/\s+/)
        .filter((token) => /^\d+$/.test(token))
        .map((token) => Number(token))
        .filter((pid) => pid !== process.pid);
    return { pids };
}

/** Ask `lsof` which processes (other than this one) hold any of the targets open. */
export function probeHostProcessesUsing(
    targets: HostUseProbeTargets,
    spawn: SpawnLike = spawnSync as unknown as SpawnLike,
): HostUseProbe {
    const files = targets.files.filter((file) => existsSync(file));
    const directories = targets.directories.filter((directory) => existsSync(directory));
    const queries: string[][] = [];
    // -w silences warnings about unrelated unreadable mounts; -t prints bare pids.
    if (files.length > 0) queries.push(["-w", "-t", "--", ...files]);
    for (const directory of directories) queries.push(["-w", "-t", "+D", directory]);

    const pids = new Set<number>();
    for (const args of queries) {
        const result = runLsof(args, spawn);
        if ("error" in result) {
            return { status: "unknown", reason: `could not run lsof (${result.error})` };
        }
        for (const pid of result.pids) pids.add(pid);
    }
    if (pids.size > 0) return { status: "in_use", pids: [...pids].sort((a, b) => a - b) };
    return { status: "free" };
}

export interface OpenCodeV2CacheResult {
    action:
        | "not_found"
        | "up_to_date"
        | "stale"
        | "check_unavailable"
        | "cleared"
        | "in_use"
        | "in_use_unknown"
        | "error";
    slot: string;
    cached?: string;
    latest?: string;
    pids?: number[];
    reason?: string;
    error?: string;
    /** Cleared only because of `--force`: the install was not known to be outdated. */
    forced?: boolean;
}

/** True when the cached install is older than `latest` or unreadable. */
function isStale(cached: string | undefined, latest: string): boolean {
    if (cached === undefined) return true;
    if (cached === latest) return false;
    const comparison = compareSemverCore(cached, latest);
    // Unparseable versions that differ are treated as stale; a newer cached
    // build (for example a prerelease ahead of `latest`) is left alone.
    return comparison === null ? true : comparison < 0;
}

export function checkOpenCodeV2PluginCache(
    options: {
        fix?: boolean;
        force?: boolean;
        latestVersion: string | null;
        /** Files a running host holds open, normally the resolved OpenCode database. */
        hostFiles: string[];
    },
    deps: {
        slot?: string;
        probe?: (targets: HostUseProbeTargets) => HostUseProbe;
        remove?: (path: string) => void;
    } = {},
): OpenCodeV2CacheResult {
    const slot = deps.slot ?? getOpenCodeV2PluginCacheSlot();
    if (!existsSync(slot)) return { action: "not_found", slot };

    const cached = readOpenCodeV2CachedPluginVersion(slot);
    const latest = options.latestVersion ?? undefined;
    const force = options.force === true;

    if (latest === undefined && !force) return { action: "check_unavailable", slot, cached };
    const stale = latest !== undefined && isStale(cached, latest);
    if (!stale && !force) return { action: "up_to_date", slot, cached, latest };
    if (!force && options.fix !== true) return { action: "stale", slot, cached, latest };

    const probe = deps.probe ?? probeHostProcessesUsing;
    const use = probe({ files: options.hostFiles, directories: [slot] });
    if (use.status === "in_use") return { action: "in_use", slot, cached, latest, pids: use.pids };
    if (use.status === "unknown") {
        return { action: "in_use_unknown", slot, cached, latest, reason: use.reason };
    }

    const remove =
        deps.remove ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
    try {
        remove(slot);
    } catch (err) {
        return {
            action: "error",
            slot,
            cached,
            latest,
            error: err instanceof Error ? err.message : String(err),
        };
    }
    return { action: "cleared", slot, cached, latest, forced: !stale };
}

/**
 * How a user updates the plugin through OpenCode 2 itself. `opencode plugin
 * update` without a target updates every outdated plugin, which avoids having
 * to repeat the entry exactly as written in the config (bare or `@latest`).
 */
export const OPENCODE_V2_PLUGIN_UPDATE_HINT =
    "update it from OpenCode: open /plugins, select Magic Context and press ctrl+u (ctrl+r only re-checks), or run `opencode plugin update`";

export interface OpenCodeV2CacheReporter {
    pass(message: string): void;
    warn(message: string): void;
    info(message: string): void;
}

/**
 * Print a cache result. Returns whether the step fixed something and whether
 * it left an issue that needs the user's attention.
 */
export function reportOpenCodeV2PluginCache(
    result: OpenCodeV2CacheResult,
    report: OpenCodeV2CacheReporter,
    options: { reportMissing: boolean },
): { fixed: boolean; issue: boolean } {
    const versions = `cached: ${result.cached ?? "unreadable"}${result.latest ? `, latest: ${result.latest}` : ""}`;
    switch (result.action) {
        case "not_found":
            if (options.reportMissing) {
                report.pass(
                    "OpenCode 2 plugin cache has no Magic Context install yet (OpenCode installs it on next start)",
                );
            }
            return { fixed: false, issue: false };
        case "up_to_date":
            report.pass(`OpenCode 2 plugin cache up to date (v${result.cached})`);
            return { fixed: false, issue: false };
        case "check_unavailable":
            report.warn(
                `OpenCode 2 plugin cache version check unavailable; preserving cached plugin${result.cached ? ` (cached: ${result.cached})` : ""}. Use doctor --force to reinstall it.`,
            );
            return { fixed: false, issue: false };
        case "stale":
            report.warn(
                `OpenCode 2 is running an outdated Magic Context (${versions}); OpenCode does not install new releases on its own`,
            );
            report.info(`  To upgrade, ${OPENCODE_V2_PLUGIN_UPDATE_HINT},`);
            report.info(
                "  or quit OpenCode (including `opencode service stop`) and run `magic-context doctor --fix`.",
            );
            return { fixed: false, issue: true };
        case "in_use":
            report.warn(
                `Outdated Magic Context in the OpenCode 2 plugin cache (${versions}) was not cleared: OpenCode is running (pid ${result.pids?.join(", ")})`,
            );
            report.info(
                `  Quit OpenCode (and \`opencode service stop\`) and rerun doctor --fix, or ${OPENCODE_V2_PLUGIN_UPDATE_HINT}.`,
            );
            report.info(`  ${result.slot}`);
            return { fixed: false, issue: true };
        case "in_use_unknown":
            report.warn(
                `Outdated Magic Context in the OpenCode 2 plugin cache (${versions}) was not cleared: ${result.reason ?? "could not tell whether OpenCode is running"}`,
            );
            report.info(
                `  Quit OpenCode and delete ${result.slot} by hand, or ${OPENCODE_V2_PLUGIN_UPDATE_HINT}.`,
            );
            return { fixed: false, issue: true };
        case "cleared":
            report.pass(
                `Cleared ${result.forced ? "" : "outdated "}Magic Context from the OpenCode 2 plugin cache (${versions}${result.forced ? ", --force" : ""}) — OpenCode installs the latest on next start`,
            );
            report.info(`  ${result.slot}`);
            return { fixed: true, issue: false };
        case "error":
            report.warn(`Could not clear the OpenCode 2 plugin cache: ${result.error}`);
            report.info(`  Manually delete: ${result.slot}`);
            return { fixed: false, issue: true };
    }
}
