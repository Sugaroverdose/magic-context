import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { cleanupTestTempDir, createTestTempDir } from "../src/shared/test-temp-dir";

const repoRoot = resolve(import.meta.dir, "../../..");
const script = join(repoRoot, "scripts/clean-dist-chunks.mjs");
const dirs: string[] = [];

function scratch(): string {
    const { dir } = createTestTempDir("mc-clean-dist-chunks-");
    dirs.push(dir);
    return dir;
}

function run(...args: string[]) {
    return spawnSync(process.execPath, [script, ...args], { encoding: "utf8", windowsHide: true });
}

afterEach(() => {
    for (const dir of dirs.splice(0)) cleanupTestTempDir(dir);
});

describe("clean-dist-chunks", () => {
    it("succeeds on a clean checkout where nothing matches", () => {
        const dist = join(scratch(), "dist");
        mkdirSync(dist);
        const result = run(dist, "index.js");
        expect(result.status).toBe(0);
    });

    it("succeeds when the dist directory does not exist yet", () => {
        const result = run(join(scratch(), "missing"), "index.js");
        expect(result.status).toBe(0);
    });

    it("removes the named entries and split chunks, and nothing else", () => {
        const dist = join(scratch(), "dist");
        mkdirSync(join(dist, "v2"), { recursive: true });
        for (const name of ["index.js", "index-a1b2.js", "chunk-x9.js", "keep.js", "keep.d.ts", "style-a.css"]) {
            writeFileSync(join(dist, name), "");
        }
        writeFileSync(join(dist, "v2", "server-a1.js"), "");
        const result = run(dist, "index.js");
        expect(result.status).toBe(0);
        expect(readdirSync(dist).sort()).toEqual(["keep.d.ts", "keep.js", "style-a.css", "v2"]);
        // Only the named directory is cleaned, never a subdirectory.
        expect(existsSync(join(dist, "v2", "server-a1.js"))).toBe(true);
    });
});

// Bun's script shell on Windows expands an unquoted glob itself and aborts on an
// empty match, so a clean build failed there. Package scripts delete build
// outputs through clean-dist-chunks.mjs instead of a shell glob.
describe("package build scripts", () => {
    it("never delete with a shell glob", () => {
        const offenders: string[] = [];
        for (const pkg of ["package.json", "packages/plugin/package.json", "packages/pi-plugin/package.json", "packages/cli/package.json"]) {
            const scripts = JSON.parse(readFileSync(join(repoRoot, pkg), "utf8")).scripts ?? {};
            for (const [name, command] of Object.entries<string>(scripts)) {
                if (/\brm\b[^&|;]*\*/.test(command)) offenders.push(`${pkg} ${name}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
