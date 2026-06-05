import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAftAvailability } from "./aft-availability";

// End-to-end against a temp HOME with real config files + real package.json on
// disk. getAftAvailability resolves paths from process.env.HOME, so overriding
// HOME exercises the genuine path-resolution + package.json-read code path
// (no mocking), which is what regressed for local AFT dev checkouts.

let tmpHome: string;
let originalHome: string | undefined;

function writeJson(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2), "utf-8");
}

/** Create a fake package directory with the given package.json `name`. */
function makePackage(relDir: string, name: string): string {
    const dir = join(tmpHome, relDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }), "utf-8");
    return dir;
}

beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(join(tmpdir(), "aft-avail-"));
    process.env.HOME = tmpHome;
});

afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
});

describe("getAftAvailability — OpenCode", () => {
    it("#given a file:// dev-path plugin entry whose package.json name is an AFT package #then detects available", () => {
        const pkgDir = makePackage(
            "Work/opencode-aft/packages/opencode-plugin",
            "@cortexkit/aft-opencode",
        );
        writeJson(join(tmpHome, ".config", "opencode", "opencode.jsonc"), {
            plugin: [`file://${pkgDir}`],
        });

        const result = getAftAvailability();
        expect(result.opencode).toBe(true);
        expect(result.available).toBe(true);
    });

    it("#given a published AFT package string #then detects available (back-compat)", () => {
        writeJson(join(tmpHome, ".config", "opencode", "opencode.json"), {
            plugin: ["@cortexkit/aft-opencode"],
        });
        expect(getAftAvailability().opencode).toBe(true);
    });

    it("#given a file:// dev-path to a NON-AFT package #then not available", () => {
        const pkgDir = makePackage("Work/some-other-plugin", "@someone/unrelated-plugin");
        writeJson(join(tmpHome, ".config", "opencode", "opencode.jsonc"), {
            plugin: [`file://${pkgDir}`],
        });
        expect(getAftAvailability().opencode).toBe(false);
    });

    it("#given a bare non-AFT npm spec #then not available (no fs read attempted)", () => {
        writeJson(join(tmpHome, ".config", "opencode", "opencode.jsonc"), {
            plugin: ["npm:@diegopetrucci/pi-openai-fast"],
        });
        expect(getAftAvailability().opencode).toBe(false);
    });
});

describe("getAftAvailability — Pi", () => {
    it("#given a relative dev-path package entry resolving to an AFT package #then detects available", () => {
        // Pi settings.json lives at ~/.pi/agent/settings.json; relative entries
        // resolve against that directory. ../../Work/... → <HOME>/Work/...
        makePackage("Work/opencode-aft/packages/pi-plugin", "@cortexkit/aft-pi");
        writeJson(join(tmpHome, ".pi", "agent", "settings.json"), {
            packages: ["../../Work/opencode-aft/packages/pi-plugin"],
        });

        const result = getAftAvailability();
        expect(result.pi).toBe(true);
        expect(result.available).toBe(true);
    });

    it("#given a relative dev-path to a NON-AFT package #then not available", () => {
        makePackage("Work/random/packages/thing", "@x/thing");
        writeJson(join(tmpHome, ".pi", "agent", "settings.json"), {
            packages: ["../../Work/random/packages/thing"],
        });
        expect(getAftAvailability().pi).toBe(false);
    });
});
