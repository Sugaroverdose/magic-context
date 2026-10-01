#!/usr/bin/env node
// Remove a build's previous outputs before rebuilding: the named entry files plus
// every split chunk (`*-*.js`) directly inside the given dist directory.
//
// Usage: bun scripts/clean-dist-chunks.mjs <dist dir> [entry file ...]
//
// A plain `rm -f dist/*-*.js` in a package script fails on a clean checkout under
// Bun's script shell on Windows: the glob is expanded by the shell and an empty
// match aborts with "no matches found" before rm runs. Listing the directory
// here makes "nothing to remove" an ordinary, successful case on every platform.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const [distDir, ...entries] = process.argv.slice(2);
if (!distDir) {
    console.error("usage: clean-dist-chunks.mjs <dist dir> [entry file ...]");
    process.exit(2);
}

let names;
try {
    names = readdirSync(distDir);
} catch (error) {
    if (error && error.code === "ENOENT") process.exit(0);
    throw error;
}

// Split chunks are named `<name>-<hash>.js`; entry files are named explicitly.
const chunk = /^[^/\\]+-[^/\\]+\.js$/;
const targets = new Set(entries);
for (const name of names) if (chunk.test(name)) targets.add(name);
for (const name of targets) rmSync(join(distDir, name), { force: true });
