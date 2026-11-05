/**
 * Unit 3 entry law (assembly-v2 plan §Unit 3): the ctx-reduce family enters
 * the v2 tree ONLY where a v2-side caller/importer/consumer exists, or the
 * consumer is a tool entry point registered by the plugin. This census is
 * the gate itself — written red-first, before any ported module lands.
 *
 * Shape per module: the file exists AND at least one allowed production
 * importer actually carries the import. A module that enters with no
 * importer is the carriage class (a dead module smuggled in by the port)
 * and must redden by name.
 *
 * Control: the planted-rogue test plants an orphan module into the walked
 * set and requires the importer predicate to name no one — the walk is not
 * vacuously satisfied by the real tree.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTestTempDir } from "../../shared/test-temp-dir";

const PKG_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const SRC = join(PKG_ROOT, "src");
const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".codegraph"]);
const TS_EXT = /\.(ts|tsx|mts|cts|mjs|cjs)$/;

interface FamilyModule {
    /** Path relative to src/, without extension. */
    rel: string;
    /** Production files whose import of this module satisfies the entry
     * law; the census requires ≥1 of them to actually carry it. */
    importers: string[];
}

const FAMILY: FamilyModule[] = [
    {
        rel: "features/magic-context/reduce-resolver",
        importers: ["tools/ctx-reduce/tools"],
    },
    {
        rel: "features/magic-context/reduce-response",
        importers: ["tools/ctx-reduce/tools"],
    },
    {
        rel: "features/magic-context/tool-call-registry",
        importers: [
            "tools/ctx-reduce/tools",
            "hooks/magic-context/hook-handlers",
            "hooks/magic-context/channel2-delivery",
        ],
    },
    {
        rel: "features/magic-context/message-ordinal-mint",
        importers: ["tools/ctx-reduce/tools"],
    },
    {
        rel: "tools/ctx-expand/withdraw",
        importers: ["tools/ctx-expand/tools"],
    },
];

function collect(dir: string, out: string[]): void {
    let entries: string[];
    try {
        entries = readdirSync(dir);
    } catch {
        return;
    }
    for (const name of entries) {
        if (SKIP_DIRS.has(name)) continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collect(full, out);
        else if (TS_EXT.test(name)) out.push(full);
    }
}

function productionRows(extraDirs: Array<{ dir: string; prefix: string }> = []): Array<{
    rel: string;
    text: string;
}> {
    const rows: Array<{ rel: string; text: string }> = [];
    const emit = (file: string, rel: string) => {
        if (file.endsWith(".test.ts")) return;
        rows.push({ rel: rel.replace(/\.ts$/, ""), text: readFileSync(file, "utf8") });
    };
    const files: string[] = [];
    collect(SRC, files);
    for (const file of files) emit(file, file.slice(SRC.length + 1));
    for (const { dir, prefix } of extraDirs) {
        const planted: string[] = [];
        collect(dir, planted);
        for (const file of planted) emit(file, `${prefix}${file.slice(dir.length + 1)}`);
    }
    return rows;
}

/** Rows (other than the module itself) that import it by module specifier. */
function importersOf(rows: ReturnType<typeof productionRows>, moduleRel: string): string[] {
    const base = moduleRel.split("/").pop();
    return rows
        .filter((r) => r.rel !== moduleRel)
        .filter((r) => new RegExp(`from\\s+"[^"]*\\/${base}"`).test(r.text))
        .map((r) => r.rel);
}

describe("ctx-reduce family entry law (Unit 3 census)", () => {
    const rows = productionRows();

    for (const module of FAMILY) {
        it(`${module.rel}: exists and has a live production importer`, () => {
            const file = rows.find((r) => r.rel === module.rel);
            expect(file, `${module.rel} must exist in the production tree`).toBeDefined();
            const importers = importersOf(rows, module.rel).filter((rel) =>
                module.importers.includes(rel),
            );
            expect(
                importers,
                `${module.rel} must be imported by ≥1 of: ${module.importers.join(", ")}`,
            ).not.toEqual([]);
        });
    }

    it("the ctx-reduce and ctx-expand tools are registered entry points", () => {
        // Family tests (ctx-handles.test.ts) pin these tools; the tools
        // themselves qualify under the entry law only as registered entries.
        const registry = rows.find((r) => r.rel === "plugin/tool-registry");
        const v2Tools = rows.find((r) => r.rel === "v2/hooks/tools");
        expect(registry?.text).toContain(`from "../tools/ctx-reduce"`);
        expect(registry?.text).toContain(`from "../tools/ctx-expand"`);
        expect(v2Tools?.text).toContain(`from "../../tools/ctx-reduce"`);
        expect(v2Tools?.text).toContain(`from "../../tools/ctx-expand"`);
    });

    it("an orphan module in the walked set is named by no importer (anti-vacuity)", () => {
        const { dir } = createTestTempDir("mc-u3-entry-law-");
        try {
            writeFileSync(join(dir, "orphan_module.ts"), "export const orphan = 1;", "utf8");
            const planted = productionRows([{ dir, prefix: "planted/" }]);
            expect(planted.some((r) => r.rel === "planted/orphan_module")).toBe(true);
            // The importer predicate is empty for the orphan — exactly the
            // state that reddens a smuggled module under the per-module law.
            expect(importersOf(planted, "planted/orphan_module")).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
    });
});
