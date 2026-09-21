import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { type RpcPortFileRecord, rpcPortDir } from "../../../plugin/src/shared/rpc-utils";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

async function eventually<T>(read: () => T | undefined, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = read();
        if (value !== undefined) return value;
        await Bun.sleep(25);
    }
    throw new Error("timed out waiting for the v2 RPC surface");
}

/**
 * Issue 492 finding 6: `transform_mode: "rust"` has no wiring on OpenCode 2 — the subc transport
 * the Rust transform needs is built only by the v1 server lane. It used to be accepted and
 * silently ignored, which also broke every status read (the RPC handlers asked a Rust module that
 * was never constructed for the session state). The ruling for this task is to keep running
 * TypeScript mode, but loudly: one warning line, and a named limitation on every status surface.
 */
test("v2 runs TypeScript mode and names the limitation when Rust mode is configured", async () => {
    const host = await spawnOpencode2({
        magicContextConfig: {
            transform_mode: "rust",
            // `resolveTransformMode` downgrades Rust to TypeScript before the adapter ever sees it
            // unless user-tier subc routing is configured, and the fixture config file IS the user
            // tier. Without this the config loader answers the question and finding 6's path is
            // never reached.
            subc: { connection_file: "/tmp/mc-e2e-subc-that-is-never-dialled.json" },
            memory: { enabled: false },
            historian: { disable: true },
            dreamer: { disable: true },
        },
    });
    try {
        const client = OpenCode.make({
            baseUrl: host.url,
            headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
        });
        const session = await client.session.create({
            location: { directory: host.cwd },
            model: { providerID: "openai", id: "mock-model" },
        });
        await waitForPluginActive(client, host.cwd);
        host.mock.setDefault({
            text: "rust-mode fixture reply",
            usage: { input_tokens: 137, output_tokens: 11 },
        });
        await client.session.prompt({ sessionID: session.id, text: "rust mode fixture prompt" });
        await client.session.wait(
            { sessionID: session.id },
            { signal: AbortSignal.timeout(20_000) },
        );

        // The transform still ran: the request reached the provider and the session was measured.
        expect(host.mock.requests().length).toBeGreaterThan(0);

        const storageDir = join(host.env.XDG_DATA_HOME!, "cortexkit", "magic-context");
        const discovery = await eventually(() => {
            const directory = rpcPortDir(storageDir, host.cwd);
            if (!existsSync(directory)) return undefined;
            const file = readdirSync(directory).find(
                (name) => name.startsWith("port-") && name.endsWith(".json"),
            );
            return file
                ? (JSON.parse(readFileSync(join(directory, file), "utf8")) as RpcPortFileRecord)
                : undefined;
        });
        const rpc = async (method: string) => {
            const response = await fetch(`http://127.0.0.1:${discovery.port}/rpc/${method}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${discovery.token}`,
                },
                body: JSON.stringify({ sessionId: session.id, directory: host.cwd }),
            });
            expect(response.status).toBe(200);
            return (await response.json()) as Record<string, unknown>;
        };

        // Before this fix the Rust branch answered every status read with
        // "Rust module status unavailable", because no module client exists on this lane.
        const snapshot = await rpc("sidebar-snapshot");
        expect(snapshot.error).toBeUndefined();
        expect(snapshot.hostLimitations).toEqual(["rust_mode_unsupported"]);
        expect(snapshot.inputTokens).toBeGreaterThan(0);

        const detail = await rpc("status-detail");
        expect(detail.error).toBeUndefined();
        expect(detail.hostLimitations).toEqual(["rust_mode_unsupported"]);

        // Exactly one warning line for the whole process, carrying the user-facing code.
        const logged = `${host.stdout()}\n${host.stderr()}`
            .split("\n")
            .filter((line) => line.includes("MC-S06"));
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("Rust transform mode is not available");
    } catch (error) {
        console.error(host.stdout(), host.stderr());
        throw error;
    } finally {
        await host.stop();
    }
}, 90_000);
