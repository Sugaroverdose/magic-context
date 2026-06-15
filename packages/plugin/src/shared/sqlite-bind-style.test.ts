import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Guard: SQLite statement binds must use SPREAD positional args
 * (`stmt.run(a, b)`), never the ARRAY form (`stmt.run([a, b])`).
 *
 * Why this is a CI guard, not just a style preference: bun:sqlite (OpenCode)
 * binds a lone array positionally, but node:sqlite (Pi, OpenCode Desktop) reads
 * it as NAMED params ("0","1") and throws `Unknown named parameter '0'`. An
 * array-form bind therefore passes every OpenCode/Bun test yet breaks Pi/Desktop
 * silently — exactly how issue #151 (/ctx-dream) shipped. The sqlite.ts
 * chokepoint now normalizes array binds for node:sqlite so it can no longer
 * CRASH, but the array form is still discouraged: it relies on the shim, reads
 * inconsistently with the rest of the codebase (all spread), and the guard
 * catches it at PR time so the shim stays a safety net, not a crutch.
 */

const SRC_DIR = join(import.meta.dir, "..");
// The chokepoint itself documents the pattern in prose/comments; the guard's own
// source mentions it; allow those two.
const ALLOWED = new Set(["shared/sqlite.ts", "shared/sqlite-bind-style.test.ts"]);
// `stmt.run([` / `.get([` / `.all([` — but `.all([` also matches Promise.all([.
const BIND_PATTERN = /\.(run|get|all)\(\[/;

function collectTsFiles(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const st = statSync(full);
        if (st.isDirectory()) {
            collectTsFiles(full, acc);
        } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
            acc.push(full);
        }
    }
    return acc;
}

describe("sqlite bind style", () => {
    it("uses spread positional binds, never the array form", () => {
        const violations: string[] = [];
        for (const file of collectTsFiles(SRC_DIR)) {
            const rel = file.slice(SRC_DIR.length + 1);
            if (ALLOWED.has(rel)) continue;
            const lines = readFileSync(file, "utf8").split("\n");
            lines.forEach((line, i) => {
                if (!BIND_PATTERN.test(line)) return;
                // Promise.all([...]) is not a SQLite statement bind.
                if (line.includes("Promise.all(")) return;
                // Skip comment lines.
                const trimmed = line.trim();
                if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
                violations.push(`${rel}:${i + 1}  ${trimmed}`);
            });
        }
        expect(
            violations,
            `Array-form SQLite binds found — use spread positional .run(a, b) ` +
                `instead of .run([a, b]) (breaks under node:sqlite on Pi/Desktop):\n` +
                violations.join("\n"),
        ).toEqual([]);
    });
});
