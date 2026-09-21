import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { OpenCodeAdapter } from "./opencode";

// An OpenCode 2 host reads its native `plugins` array and still decodes the legacy
// `plugin` array, loading BOTH. A user who registered a checkout under `plugins`
// must not get a second, npm registration appended under `plugin` by doctor/setup.
describe("OpenCodeAdapter registration keys across host generations", () => {
    let root: string;
    let configPath: string;
    const originalConfigHome = process.env.XDG_CONFIG_HOME;

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "mc-oc-adapter-"));
        process.env.XDG_CONFIG_HOME = root;
        configPath = join(root, "opencode", "opencode.json");
    });
    afterEach(() => {
        if (originalConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalConfigHome;
        rmSync(root, { recursive: true, force: true });
    });

    const write = (config: Record<string, unknown>) => {
        const { mkdirSync } = require("node:fs");
        mkdirSync(join(root, "opencode"), { recursive: true });
        writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    };
    const read = () => JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;

    test("a checkout registered under the v2 `plugins` key is left alone", async () => {
        // A real checkout path: dev-path recognition verifies the nearest package.json.
        const checkout = resolve(import.meta.dir, "../../../plugin");
        write({ plugins: [checkout] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(read()).toEqual({ plugins: [checkout] });
    });

    test("an npm registration under the v2 `plugins` key counts as present", () => {
        write({ plugins: ["@cortexkit/opencode-magic-context@latest"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.hasPluginEntry()).toBe(true);
    });

    test("an object-form v2 entry ({ package, options }) counts as present and is not duplicated", async () => {
        // OpenCode 2 replaces the 1.x `[package, options]` tuple with an object
        // (core 2.0.11 decodes the legacy tuple into the same object). A matcher
        // that only knows the tuple reads this as unregistered and appends a
        // second entry, loading the plugin twice.
        const entry = { package: "@cortexkit/opencode-magic-context@latest", options: { x: 1 } };
        write({ plugins: [entry] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.hasPluginEntry()).toBe(true);
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(read()).toEqual({ plugins: [entry] });
    });

    test("an object-form v2 entry pointing at a local checkout is recognised as the dev path", async () => {
        const checkout = resolve(import.meta.dir, "../../../plugin");
        write({ plugins: [{ package: checkout }] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("already_present");
        expect(read()).toEqual({ plugins: [{ package: checkout }] });
    });

    test("a fresh registration on a v2 host is written under `plugins`, never `plugin`", async () => {
        write({ model: "openai/x" });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.ensurePluginEntry();
        expect(result.action).toBe("added");
        const config = read();
        expect(config.plugin).toBeUndefined();
        expect(config.plugins).toEqual(["@cortexkit/opencode-magic-context@latest"]);
    });

    test("a fresh registration on a v1 host keeps the singular `plugin` key", async () => {
        write({ model: "openai/x" });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v1" });
        await adapter.ensurePluginEntry();
        const config = read();
        expect(config.plugins).toBeUndefined();
        expect(config.plugin).toEqual(["@cortexkit/opencode-magic-context@latest"]);
    });

    test("a legacy `plugin` registration on a v2 host is recognised and left where it is", async () => {
        write({ plugin: ["@cortexkit/opencode-magic-context@latest"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        expect(adapter.hasPluginEntry()).toBe(true);
        expect((await adapter.ensurePluginEntry()).action).toBe("already_present");
        expect(read()).toEqual({ plugin: ["@cortexkit/opencode-magic-context@latest"] });
    });

    test("removal drops the entry from whichever key holds it", async () => {
        write({ plugins: ["other", "@cortexkit/opencode-magic-context@latest"] });
        const adapter = new OpenCodeAdapter({ hostGeneration: "v2" });
        const result = await adapter.removePluginEntry();
        expect(result.ok).toBe(true);
        expect(read()).toEqual({ plugins: ["other"] });
    });
});
