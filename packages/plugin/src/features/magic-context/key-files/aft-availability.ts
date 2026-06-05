import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "comment-json";

let overrideAvailability: boolean | null = null;

export interface AftAvailability {
    available: boolean;
    opencode: boolean;
    pi: boolean;
    checkedPaths: string[];
}

function parseConfig(path: string): unknown {
    if (!existsSync(path)) return null;
    return parse(readFileSync(path, "utf-8"));
}

const AFT_NAME_NEEDLES = ["@cortexkit/aft", "aft-opencode", "aft-pi"];

function stringMentionsAft(value: string): boolean {
    return AFT_NAME_NEEDLES.some((needle) => value.includes(needle));
}

/**
 * A plugin/package entry can be a published spec ("@cortexkit/aft-opencode"),
 * a file:// URL, or a relative/absolute filesystem path (a local dev checkout).
 * Published specs match by string. For local paths we resolve the target's
 * package.json `name` and match that — so an AFT checkout in an arbitrarily
 * named directory (e.g. file:///…/opencode-aft/packages/opencode-plugin, whose
 * path contains "opencode-aft" but not the package name "aft-opencode") is
 * still recognized via its real name "@cortexkit/aft-opencode". Returns null
 * when the entry isn't a local path or its package.json can't be read.
 */
function resolveLocalEntryPackageName(value: string, configDir: string): string | null {
    let dir: string | null = null;
    if (value.startsWith("file://")) {
        try {
            dir = fileURLToPath(value);
        } catch {
            return null;
        }
    } else if (value.startsWith("~/")) {
        dir = join(homedir(), value.slice(2));
    } else if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
        dir = isAbsolute(value) ? value : resolve(configDir, value);
    } else {
        // Bare package spec ("npm:@scope/pkg", "@scope/pkg") — not a local path.
        return null;
    }
    try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
            name?: unknown;
        };
        return typeof pkg.name === "string" ? pkg.name : null;
    } catch {
        return null;
    }
}

function entryMatchesAft(entry: unknown, configDir: string): boolean {
    const value = Array.isArray(entry) ? entry[0] : entry;
    if (typeof value !== "string") return false;
    if (stringMentionsAft(value)) return true;
    const name = resolveLocalEntryPackageName(value, configDir);
    return name != null && stringMentionsAft(name);
}

function hasAftInArray(value: unknown, configDir: string): boolean {
    return Array.isArray(value) && value.some((entry) => entryMatchesAft(entry, configDir));
}

function hasAftAtKeys(value: unknown, keys: string[], configDir: string): boolean {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    for (const key of keys) {
        if (hasAftInArray(record[key], configDir)) return true;
    }
    return false;
}

export function getAftAvailability(): AftAvailability {
    const home = process.env.HOME || homedir();
    const opencodePaths = [
        join(home, ".config", "opencode", "opencode.jsonc"),
        join(home, ".config", "opencode", "opencode.json"),
    ];
    const piPaths = [join(home, ".pi", "agent", "settings.json")];
    const checkedPaths = [...opencodePaths, ...piPaths];

    let opencode = false;
    for (const path of opencodePaths) {
        try {
            const config = parseConfig(path);
            // Relative path entries resolve against the config file's directory.
            const configDir = join(path, "..");
            if (hasAftAtKeys(config, ["plugin", "plugins", "mcp", "mcp_servers"], configDir)) {
                opencode = true;
                break;
            }
        } catch {
            // Malformed config is treated as unavailable; doctor reports parse errors separately.
        }
    }

    let pi = false;
    for (const path of piPaths) {
        try {
            const config = parseConfig(path);
            const configDir = join(path, "..");
            if (hasAftAtKeys(config, ["packages", "extensions"], configDir)) {
                pi = true;
                break;
            }
            const agent = (config as Record<string, unknown> | null)?.agent;
            if (hasAftAtKeys(agent, ["packages", "extensions"], configDir)) {
                pi = true;
                break;
            }
        } catch {
            // Malformed config is treated as unavailable; doctor reports parse errors separately.
        }
    }

    const detected = opencode || pi;
    return {
        available: overrideAvailability ?? detected,
        opencode,
        pi,
        checkedPaths,
    };
}

export function isAftAvailable(): boolean {
    return getAftAvailability().available;
}

/** Test-only override for deterministic key-files unit tests. */
export function setAftAvailabilityOverride(value: boolean | null): void {
    overrideAvailability = value;
}
