import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseJsonc } from "../shared/jsonc-parser";
import { LiveConfigReader } from "./live-snapshot";

test("one snapshot per run survives a malformed tier and adopts both tiers atomically", () => {
    const oldConfigHome = process.env.XDG_CONFIG_HOME;
    const root = mkdtempSync(join(tmpdir(), "mc-live-config-"));
    const project = join(root, "project");
    const projectFile = join(project, ".cortexkit", "magic-context.jsonc");
    const userFile = join(root, "config", "cortexkit", "magic-context.jsonc");
    mkdirSync(join(project, ".cortexkit"), { recursive: true });
    mkdirSync(join(root, "config", "cortexkit"), { recursive: true });
    process.env.XDG_CONFIG_HOME = join(root, "config");
    try {
        const logs: string[] = [];
        writeFileSync(userFile, '{"historian":{"model":"user"}}');
        writeFileSync(projectFile, '{"historian":{"model":"project"}}');
        const load = () => {
            const user = parseJsonc<{ historian: { model: string } }>(readFileSync(userFile, "utf8"));
            const projectConfig = parseJsonc<{ historian: { model: string } }>(readFileSync(projectFile, "utf8"));
            return { model: projectConfig.historian.model ?? user.historian.model };
        };
        const reader = new LiveConfigReader(project, load(), load, (line) => logs.push(line));
        const first = reader.poll();
        expect(first.generation).toBe(1);
        writeFileSync(projectFile, '{"historian":');
        expect(reader.poll()).toBe(first);
        expect(reader.lastFailure()?.path).toBe(projectFile);
        reader.poll();
        expect(logs.filter((line) => line.includes("reload failed"))).toHaveLength(1);
        writeFileSync(projectFile, '{"historian":{"model":"second-model"}}');
        const second = reader.poll();
        expect(second.generation).toBe(2);
        expect(second.effective.model).toBe("second-model");
        expect(first.effective.model).toBe("project");
        expect(reader.lastFailure()).toBeUndefined();
        expect(logs.filter((line) => line.includes("config reloaded"))).toEqual(["config reloaded gen=2 keys=[model]"]);
    } finally {
        if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = oldConfigHome;
        rmSync(root, { recursive: true, force: true });
    }
});
