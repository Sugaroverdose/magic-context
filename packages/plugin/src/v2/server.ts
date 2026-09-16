import { loadPluginConfigDetailed } from "../config";
import { setHarness } from "../shared/harness";
import { registerContext } from "./hooks/context";
import type { V2Context } from "./hooks/types";
import { startUpdateChecks } from "./hooks/update-check";

/**
 * Only an OpenCode 2 host hands `setup` a context carrying `session.hook`.
 * The package's default export is the union `{ id, server, setup }`, and a
 * v1 host that finds `setup` on it must not run the v2 lane: locking the
 * harness to "opencode2" there mis-tags every row that seat writes.
 *
 * Proven against the shipped OpenCode 1.18.30 binary: the host calls
 * `server()` first, then `setup(context)` with keys
 * `[options, agent, aisdk, catalog, command, integration, plugin, reference,
 * skill]` and no `session`. `registerContext` then throws on
 * `context.session.hook` and the host swallows it, leaving the harness
 * locked to "opencode2" for the rest of the v1 process.
 */
export function isOpenCode2HostContext(context: unknown): context is V2Context {
    if (typeof context !== "object" || context === null) return false;
    const session = (context as { session?: unknown }).session;
    return (
        typeof session === "object" &&
        session !== null &&
        typeof (session as { hook?: unknown }).hook === "function"
    );
}

export async function setup(context: V2Context) {
    if (!isOpenCode2HostContext(context)) {
        console.warn(
            "[magic-context] setup() called without an OpenCode 2 session hook surface; the v1 server lane owns this host, v2 setup is inert",
        );
        return async () => {};
    }
    setHarness("opencode2");
    const duties = await registerContext(context);
    const checks =
        loadPluginConfigDetailed(context.location.directory).config.auto_update === false
            ? undefined
            : startUpdateChecks(context);
    console.info("[magic-context] @cortexkit/opencode-magic-context v2 setup");
    return async () => {
        await checks?.dispose();
        await duties?.dispose();
    };
}

export default {
    id: "@cortexkit/opencode-magic-context",
    setup,
};
