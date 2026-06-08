/// <reference types="bun-types" />

// Regression guard: the `auto_drop_tool_age` and `drop_tool_structure` config
// keys (and their camelCase threads `autoDropToolAge` / `dropToolStructure`)
// were REMOVED in Phase 2 — routine age-based tool drops were replaced by the
// tiered target-headroom emergency drop, which always full-drops. No production
// source in the plugin or Pi packages may reference them; a stray reference
// would either be dead code or a config the schema now rejects with a warning.
//
// This is a static source-text scan so it fails at test-time without runtime
// mocking. Tests, generated files, and the doctor's deletion routine (which
// must name the dead keys to strip them) are intentionally excluded.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PLUGIN_SRC = join(__dirname, "..");
const PI_SRC = join(__dirname, "..", "..", "..", "pi-plugin", "src");

const FORBIDDEN = [
    "auto_drop_tool_age",
    "drop_tool_structure",
    "autoDropToolAge",
    "dropToolStructure",
];

// Files allowed to mention the dead keys: the CLI doctor names them to strip
// them from existing user configs. (The doctor lives in packages/cli, not
// scanned here, but keep this list as the documented exception surface.)
const ALLOWED_BASENAMES = new Set<string>([]);

function walkSourceFiles(dir: string, out: string[] = []): string[] {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return out; // package not present in this checkout
    }
    for (const entry of entries) {
        if (entry === "node_modules" || entry === "dist") continue;
        const full = join(dir, entry);
        const s = statSync(full);
        if (s.isDirectory()) {
            walkSourceFiles(full, out);
        } else if (
            s.isFile() &&
            entry.endsWith(".ts") &&
            !entry.endsWith(".test.ts") &&
            !entry.endsWith(".gen.ts") &&
            !ALLOWED_BASENAMES.has(entry)
        ) {
            out.push(full);
        }
    }
    return out;
}

describe("removed Phase 2 config keys", () => {
    it("no production source references auto_drop_tool_age / drop_tool_structure", () => {
        const files = [...walkSourceFiles(PLUGIN_SRC), ...walkSourceFiles(PI_SRC)];
        const offenders: string[] = [];
        for (const file of files) {
            const text = readFileSync(file, "utf-8");
            for (const key of FORBIDDEN) {
                if (text.includes(key)) {
                    offenders.push(`${file}: ${key}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
