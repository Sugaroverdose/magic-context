import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Reaching the OpenCode 2 host's own HTTP API from inside a plugin.
 *
 * The plugin surface a v2 host hands us carries no client and no address, but the host running in
 * service mode registers itself in a file that is the whole discovery contract: a base URL and the
 * password for basic auth. Everything here is plain `fetch` and `node:fs` on purpose — the OpenCode
 * client package stays a development dependency and must not be imported at runtime.
 *
 * A plain `opencode serve` writes no registration, so discovery legitimately comes up empty; every
 * caller treats that as "not now" rather than an error.
 */

/** Matches the path the OpenCode client resolves a local service from. */
export function serviceRegistrationPath(env: NodeJS.ProcessEnv = process.env): string {
    const state = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    return join(state, "opencode", "service.json");
}

export interface HostService {
    /** Base URL with no trailing slash. */
    readonly url: string;
    readonly headers: Record<string, string>;
}

/** Reads the registration a running service left behind, or undefined when there is none. */
export function discoverHostService(env: NodeJS.ProcessEnv = process.env): HostService | undefined {
    let text: string;
    try {
        text = readFileSync(serviceRegistrationPath(env), "utf8");
    } catch {
        return undefined;
    }
    let info: { url?: unknown; password?: unknown };
    try {
        info = JSON.parse(text) as { url?: unknown; password?: unknown };
    } catch {
        return undefined;
    }
    if (typeof info.url !== "string" || info.url.length === 0) return undefined;
    return {
        url: info.url.replace(/\/+$/, ""),
        headers:
            typeof info.password === "string" && info.password.length > 0
                ? {
                      authorization: `Basic ${Buffer.from(`opencode:${info.password}`, "utf8").toString("base64")}`,
                  }
                : {},
    };
}

/**
 * Deletes a session through the host, which interrupts whatever it is doing, waits for it to go
 * idle, removes its children, and publishes the deletion so the rest of the host keeps up. This is
 * the same route the OpenCode client's session removal calls, so it inherits all of that.
 */
export async function removeHostSession(
    sessionID: string,
    env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
    const service = discoverHostService(env);
    if (!service) {
        throw new Error("No running OpenCode service is registered to delete the session through");
    }
    const response = await fetch(`${service.url}/api/session/${encodeURIComponent(sessionID)}`, {
        method: "DELETE",
        headers: service.headers,
        signal: AbortSignal.timeout(60_000),
    });
    // A session that is already gone is the state the caller asked for.
    if (!response.ok && response.status !== 404) {
        throw new Error(`OpenCode session delete answered ${response.status}`);
    }
}
