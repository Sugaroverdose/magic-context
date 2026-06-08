/**
 * Live-server client for the Channel 2 ctx_reduce ceiling nudge (a synthetic
 * user `<system-reminder>` delivered via `promptAsync`).
 *
 * WHY a separate client instead of the plugin-provided `input.client`:
 * OpenCode's plugin `input.client` routes through `Server.Default().app.fetch`,
 * which uses a SEPARATE Effect `memoMap` from the live HTTP listener the UI
 * uses. `SessionRunState` lives per-memoMap, so a plugin-origin `promptAsync`
 * observes an "idle" runner while the live turn is still running, `ensureRunning`
 * fails to coalesce, and OpenCode persists duplicate assistant children
 * (upstream bug anomalyco/opencode#28202). Building a `createOpencodeClient`
 * aimed at `input.serverUrl` via `globalThis.fetch` enters the SAME live
 * listener, so `ensureRunning` sees the real run and coalesces — the synthetic
 * message lands at the tail after the current assistant step.
 *
 * The live listener is only reachable on OpenCode Desktop (Electron+Node) and
 * TUI launched with `--port 0`; plain TUI binds an internal listener that 404s
 * `/session/*`. We probe once at init and cache per `serverUrl`. When
 * unreachable, Channel 2 is DISABLED (Channel 1 + 85% force-materialization
 * remain the backstop) — MC deliberately does NOT fall back to the in-process
 * client because that would knowingly trigger #28202.
 */

import { createOpencodeClient } from "@opencode-ai/sdk";

export type LiveServerClient = ReturnType<typeof createOpencodeClient>;

const clientCache = new Map<string, LiveServerClient>();

function cacheKey(serverUrl: string, directory: string): string {
    return `${serverUrl}|${directory}`;
}

function normalizeServerUrl(serverUrl: string): string {
    try {
        return new URL(serverUrl).toString();
    } catch {
        return serverUrl;
    }
}

/** Basic-auth header OpenCode expects when `OPENCODE_SERVER_PASSWORD` is set. */
function serverAuthHeaders(): Record<string, string> | undefined {
    const password = process.env.OPENCODE_SERVER_PASSWORD;
    if (!password) return undefined;
    const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
    return {
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    };
}

/**
 * Cached `createOpencodeClient` aimed at the live HTTP listener for the given
 * `(serverUrl, directory)`. One client is reused across deliveries.
 */
export function getLiveServerClient(serverUrl: string, directory: string): LiveServerClient {
    const key = cacheKey(serverUrl, directory);
    const cached = clientCache.get(key);
    if (cached) return cached;
    const client = createOpencodeClient({
        baseUrl: serverUrl,
        directory,
        headers: serverAuthHeaders(),
        fetch: globalThis.fetch,
    });
    clientCache.set(key, client);
    return client;
}

// Per-serverUrl wake decision + probe TTL. One plugin process can host multiple
// OpenCode windows with different listener URLs, so the decision must be keyed.
interface ProbeDecision {
    reachable: boolean;
    probedAt: number;
}
const wakeDecisionByServerUrl = new Map<string, ProbeDecision>();

// Re-probe window: a transient 404/timeout shouldn't permanently disable
// Channel 2 for the whole session lifetime (per council-r3).
const PROBE_TTL_MS = 10 * 60_000;

/**
 * Probe whether `serverUrl` serves OpenCode's HTTP API within `timeoutMs`.
 * `true` only when `/session` proves the API is usable: any 2xx, or 401/403
 * (auth-protected listener still exists). `false` for 404 (plain TUI internal
 * listener), 5xx, connection refused, DNS failure, timeout, or malformed URL.
 * Records the result + timestamp in the per-serverUrl cache.
 */
export async function probeServerReachable(
    serverUrl: string | undefined,
    timeoutMs = 1500,
): Promise<boolean> {
    if (!serverUrl) return false;
    const normalized = normalizeServerUrl(serverUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let reachable = false;
    try {
        const probeUrl = new URL("/session", serverUrl).toString();
        const res = await globalThis.fetch(probeUrl, {
            method: "GET",
            headers: serverAuthHeaders(),
            signal: controller.signal,
        });
        reachable = res.ok || res.status === 401 || res.status === 403;
    } catch {
        reachable = false;
    } finally {
        clearTimeout(timer);
        wakeDecisionByServerUrl.set(normalized, { reachable, probedAt: Date.now() });
    }
    return reachable;
}

/** Record a probe result directly (test helper / explicit override). */
export function setLiveServerWakeAvailable(
    serverUrl: string | undefined,
    available: boolean,
): void {
    if (!serverUrl) return;
    wakeDecisionByServerUrl.set(normalizeServerUrl(serverUrl), {
        reachable: available,
        probedAt: Date.now(),
    });
}

/**
 * Should Channel 2 deliver through the live-server client for `serverUrl`?
 * Returns false when never probed or the last probe failed. A stale decision
 * (older than the TTL) returns false so the caller re-probes before delivering.
 */
export function useLiveServerWake(serverUrl?: string): boolean {
    if (!serverUrl) return false;
    const decision = wakeDecisionByServerUrl.get(normalizeServerUrl(serverUrl));
    if (!decision) return false;
    if (Date.now() - decision.probedAt > PROBE_TTL_MS) return false;
    return decision.reachable;
}

/** True when a usable (non-stale) probe decision exists, regardless of outcome. */
export function hasFreshProbe(serverUrl?: string): boolean {
    if (!serverUrl) return false;
    const decision = wakeDecisionByServerUrl.get(normalizeServerUrl(serverUrl));
    if (!decision) return false;
    return Date.now() - decision.probedAt <= PROBE_TTL_MS;
}

/** Test helper — reset both caches between cases. */
export function __resetLiveServerClientForTests(): void {
    clientCache.clear();
    wakeDecisionByServerUrl.clear();
}
