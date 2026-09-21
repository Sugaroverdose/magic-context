import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import { gaDatabasePath } from "../../../plugin/src/v2/store-reader";
import {
    serviceRegistrationPath,
    spawnOpencode2,
    waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(path)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
        await Bun.sleep(20);
    }
}

function sessionExists(path: string, sessionID: string): boolean {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        return db.prepare("SELECT id FROM session_v2 WHERE id = ?").get(sessionID) != null;
    } finally {
        db.close();
    }
}

/**
 * Issue 492 finding 5: a host with no service registration has no owner-bound route to delete a
 * hidden child through. That is an acceptable limitation, but it has to be a RETRIABLE and NAMED
 * one — the child stays recorded so a later process inside a registered service removes it, and
 * the status surfaces carry the code instead of the plugin silently pruning its bookkeeping.
 */
test("a hidden child retired on an unregistered OpenCode 2 host stays recorded and names the limitation", async () => {
    const bundleDir = mkdtempSync(join(tmpdir(), "mc-hidden-child-unbound-"));
    const build = await Bun.build({
        entrypoints: [join(import.meta.dir, "hidden-child-unbound-probe.ts")],
        outdir: bundleDir,
        naming: "index.js",
        target: "node",
        format: "esm",
        define: { "process.env.NODE_ENV": '"production"' },
        external: ["bun:sqlite", "node:sqlite"],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));

    // No `serviceMode`: `serve` alone writes no registration, which is the host shape under test.
    const host = await spawnOpencode2({
        probePlugin: bundleDir,
        includeMagicContext: false,
        mockResponse: { text: "unbound fixture reply", usage: { input_tokens: 10, output_tokens: 2 } },
    });
    try {
        expect(existsSync(serviceRegistrationPath(host.env))).toBe(false);
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        await waitForPluginActive(client, host.cwd, "mc-hidden-child-unbound-proof");
        await waitForFile(join(host.cwd, "hidden-child-unbound-ready"));
        await Bun.write(join(host.cwd, "hidden-child-unbound-command"), "go");
        const resultPath = join(host.cwd, "hidden-child-unbound-result.json");
        await waitForFile(resultPath);
        const result = JSON.parse(readFileSync(resultPath, "utf8")) as {
            retiredChildID: string;
            replacementChildID: string;
            owner: unknown;
            retired: Array<{ id: string; owner: unknown }>;
            limitations: string[];
        };

        // Nothing was registered, so nothing could be bound at creation time.
        expect(result.owner).toBeNull();
        expect(result.retired).toEqual([{ id: result.retiredChildID, owner: null }]);
        // Not silent: the limitation is named with its MC code for every status surface.
        expect(result.limitations).toContain("MC-H02");
        // The session is still there, which is exactly why the bookkeeping must not be pruned.
        const storePath = gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env);
        expect(sessionExists(storePath, result.retiredChildID)).toBe(true);
    } catch (error) {
        console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host.stop();
        rmSync(bundleDir, { recursive: true, force: true });
    }
}, 120_000);
