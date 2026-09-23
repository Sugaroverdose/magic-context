import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveHistorianModel } from "../shared/model-resolution";
import { loadPluginConfigDetailed } from "./index";
import { historianRunConfig } from "./live-run-config";
import { LiveConfigReader } from "./live-snapshot";

for (const host of ["OC1", "OC2", "Pi"] as const) {
    test(`${host} historian samples the next generation while an existing run keeps its model and fallback`, () => {
        const root = mkdtempSync(join(tmpdir(), "mc-live-historian-"));
        const previous = { home: process.env.HOME, config: process.env.XDG_CONFIG_HOME };
        process.env.HOME = root;
        process.env.XDG_CONFIG_HOME = join(root, "config");
        const directory = join(root, "project");
        const file = join(root, "config", "cortexkit", "magic-context.jsonc");
        mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
        mkdirSync(join(directory, ".cortexkit"), { recursive: true });
        try {
            const block = host === "Pi" ? "pi" : "opencode";
            const write = (model: string, fallback: string) => writeFileSync(file, JSON.stringify({
                historian: { [block]: { model, fallback_models: [fallback] } },
            }));
            write("anthropic/old-model", "anthropic/old-fallback");
            const load = () => loadPluginConfigDetailed(directory, false).config;
            const boot = load();
            const reader = new LiveConfigReader(directory, boot, load, () => {});
            reader.poll();
            const runOne = historianRunConfig(boot, reader.current().effective);
            write("anthropic/new-model-with-longer-name", "anthropic/new-fallback-with-longer-name");
            const runTwo = historianRunConfig(boot, reader.poll().effective);
            const harness = host === "Pi" ? "pi" : "opencode";
            expect(resolveHistorianModel(runOne, harness).primary?.model).toBe("anthropic/old-model");
            expect(resolveHistorianModel(runOne, harness).fallbacks[0]?.model).toBe("anthropic/old-fallback");
            expect(resolveHistorianModel(runTwo, harness).primary?.model).toBe("anthropic/new-model-with-longer-name");
            expect(resolveHistorianModel(runTwo, harness).fallbacks[0]?.model).toBe("anthropic/new-fallback-with-longer-name");
            expect(reader.current().generation).toBe(2);
        } finally {
            if (previous.home === undefined) delete process.env.HOME;
            else process.env.HOME = previous.home;
            if (previous.config === undefined) delete process.env.XDG_CONFIG_HOME;
            else process.env.XDG_CONFIG_HOME = previous.config;
            rmSync(root, { recursive: true, force: true });
        }
    });
}
