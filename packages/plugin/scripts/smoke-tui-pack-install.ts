#!/usr/bin/env bun
// Packaged-install TUI smoke: prove the TUI entry loads from a PROD npm install
// living under node_modules — the path OpenCode's plugin cache actually uses.
//
// Why this exists: the dev checkout can NEVER catch a TUI packaging break.
// OpenTUI's Solid transform skips any source under node_modules (sourceFilter
// negative-lookahead), so a dev checkout (file:// path) gets the host's module
// remapping while a published install does not — the published install must
// resolve @opentui/solid and solid-js from its own installed dependencies.
// v0.31.1 shipped without those runtime deps, passed every dev-path check, and
// broke the sidebar for every npm install. This smoke packs the real tarball,
// installs it with --omit=dev under a node_modules path, and imports the TUI
// entry from there — failing exactly the way OpenCode would.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pluginRoot = resolve(import.meta.dir, "..");
const stage = mkdtempSync(join(tmpdir(), "mc-tui-pack-smoke-"));

function fail(message: string): never {
    console.error(`smoke-tui-pack-install: FAIL — ${message}`);
    process.exit(1);
}

try {
    // 1. Pack the real publish artifact.
    execFileSync("npm", ["pack", "--pack-destination", stage], {
        cwd: pluginRoot,
        stdio: "pipe",
    });
    const tarball = readdirSync(stage).find((f) => f.endsWith(".tgz"));
    if (!tarball) fail("npm pack produced no tarball");

    // 2. Install it PROD-ONLY into a scratch package, mirroring OpenCode's
    //    plugin cache shape (<root>/node_modules/<pkg>/...).
    writeFileSync(join(stage, "package.json"), JSON.stringify({ name: "smoke-host", private: true }));
    execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", join(stage, tarball)], {
        cwd: stage,
        stdio: "pipe",
    });

    // 3. Import the TUI entry from INSIDE node_modules, exactly as the host
    //    would. A missing runtime dep (the v0.31.1 failure) throws
    //    "Cannot find module '@opentui/solid/jsx-dev-runtime'" here.
    const installed = join(stage, "node_modules", "@cortexkit", "opencode-magic-context");
    const probe = `
        const mod = await import(${JSON.stringify(join(installed, "src", "tui", "index.tsx"))});
        const plugin = mod.default;
        if (!plugin || typeof plugin !== "object") throw new Error("TUI entry has no default export object");
        console.log("ok  packaged TUI entry imports and exports the plugin object");
    `;
    execFileSync("bun", ["-e", probe], { cwd: stage, stdio: "inherit" });

    console.log("smoke-tui-pack-install: all checks passed");
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
} finally {
    rmSync(stage, { recursive: true, force: true });
}
