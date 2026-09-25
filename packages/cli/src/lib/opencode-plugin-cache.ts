import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getOpenCodePluginCacheDir, getOpenCodeV2NpmCacheDir } from "./paths";

export const OPENCODE_PLUGIN_NAME = "@cortexkit/opencode-magic-context";
export const OPENCODE_PLUGIN_ENTRY_WITH_VERSION = `${OPENCODE_PLUGIN_NAME}@latest`;

export function getOpenCodePluginCacheRoots(): string[] {
    const cacheDir = getOpenCodePluginCacheDir();
    return [
        join(cacheDir, OPENCODE_PLUGIN_ENTRY_WITH_VERSION),
        join(cacheDir, OPENCODE_PLUGIN_NAME),
    ];
}

export function getOpenCodePluginPackageJsonPath(pluginCacheRoot: string): string {
    return join(
        pluginCacheRoot,
        "node_modules",
        ...OPENCODE_PLUGIN_NAME.split("/"),
        "package.json",
    );
}

export function getOpenCodePluginPackageJsonPaths(): string[] {
    return getOpenCodePluginCacheRoots().map(getOpenCodePluginPackageJsonPath);
}

/**
 * OpenCode 2's cache slot for the entries that follow new releases. The host
 * keys a registry spec as `<name>@<spec>` and treats a bare package name as
 * `@latest`, so both `@cortexkit/opencode-magic-context` and
 * `@cortexkit/opencode-magic-context@latest` load from this one slot. A
 * version-pinned entry has its own immutable slot that is never stale.
 */
export function getOpenCodeV2PluginCacheSlot(npmCacheDir = getOpenCodeV2NpmCacheDir()): string {
    return join(npmCacheDir, ...OPENCODE_PLUGIN_ENTRY_WITH_VERSION.split("/"));
}

/**
 * The install generation OpenCode 2 loads from a slot: the numerically
 * highest all-digit directory name, matching the host's own selection.
 */
export function getOpenCodeV2ActiveGeneration(slot: string): string | undefined {
    try {
        const generations = readdirSync(slot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
            .map((entry) => entry.name)
            .sort((a, b) => Number(a) - Number(b));
        const newest = generations.at(-1);
        return newest === undefined ? undefined : join(slot, newest);
    } catch {
        return undefined;
    }
}

/** Version of the Magic Context package OpenCode 2 would load from `slot`, if readable. */
export function readOpenCodeV2CachedPluginVersion(slot: string): string | undefined {
    const generation = getOpenCodeV2ActiveGeneration(slot);
    if (!generation) return undefined;
    try {
        const pkg = JSON.parse(
            readFileSync(getOpenCodePluginPackageJsonPath(generation), "utf-8"),
        ) as { version?: unknown };
        return typeof pkg.version === "string" ? pkg.version : undefined;
    } catch {
        return undefined;
    }
}
