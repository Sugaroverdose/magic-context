import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR;

afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = prevConfigDir;
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe("ensureTuiPluginEntry", () => {
    it("preserves tuple dev-path plugin entry and does not add @latest", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-tui-"));
        roots.push(root);
        process.env.OPENCODE_CONFIG_DIR = root;
        const devPath = "/Work/magic-context/packages/plugin";
        const tuiPath = join(root, "tui.json");
        writeFileSync(
            tuiPath,
            `${JSON.stringify({ plugin: [[devPath, { sidebar: true }], "other-plugin"] }, null, 2)}\n`,
        );

        const { ensureTuiPluginEntry } = await import("./tui-config");
        const changed = ensureTuiPluginEntry();
        expect(changed).toBe(false);
        const parsed = JSON.parse(readFileSync(tuiPath, "utf-8")) as { plugin: unknown[] };
        expect(parsed.plugin).toHaveLength(2);
        expect(Array.isArray(parsed.plugin[0])).toBe(true);
        expect((parsed.plugin[0] as unknown[])[0]).toBe(devPath);
        expect(parsed.plugin[1]).toBe("other-plugin");
        expect(existsSync(`${tuiPath}.tmp`)).toBe(false);
    });

    it("upgrades bare npm name to @latest while preserving tuple options", async () => {
        const root = mkdtempSync(join(tmpdir(), "mc-tui-npm-"));
        roots.push(root);
        process.env.OPENCODE_CONFIG_DIR = root;
        const tuiPath = join(root, "tui.json");
        writeFileSync(
            tuiPath,
            `${JSON.stringify(
                {
                    plugin: [["@cortexkit/opencode-magic-context", { enabled: true }]],
                },
                null,
                2,
            )}\n`,
        );

        const { ensureTuiPluginEntry } = await import("./tui-config");
        expect(ensureTuiPluginEntry()).toBe(true);
        const parsed = JSON.parse(readFileSync(tuiPath, "utf-8")) as { plugin: unknown[] };
        const entry = parsed.plugin[0] as unknown[];
        expect(entry[0]).toBe("@cortexkit/opencode-magic-context@latest");
        expect(entry[1]).toEqual({ enabled: true });
    });
});
