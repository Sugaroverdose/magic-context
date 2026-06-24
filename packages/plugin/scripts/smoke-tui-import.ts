// Import smoke test for the raw-TSX TUI entry (`./tui` export).
//
// The TUI entry (src/tui/index.tsx) uses `/** @jsxImportSource @opentui/solid */`,
// so loading it requires @opentui/solid + solid-js to resolve from the plugin
// package itself. When those weren't declared as deps, OpenCode 1.17.10's
// OpenTUI 0.4.2 bump surfaced an immediate load failure:
//   Cannot find module '@opentui/solid/jsx-dev-runtime'
// `bun test` doesn't catch this because no suite imports the TSX entry. This
// script imports it exactly like OpenCode loads the `./tui` export, so a missing
// or version-mismatched OpenTUI/Solid runtime fails the smoke instead of shipping
// a TUI that won't load. Run: bun packages/plugin/scripts/smoke-tui-import.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/tui/index.tsx");

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
    if (cond) {
        console.log(`  ok  ${name}`);
    } else {
        failures++;
        console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

try {
    // Resolving the OpenTUI JSX runtime the TSX entry compiles against is the
    // exact thing that broke; importing the entry exercises it end to end.
    const mod = (await import(entry)) as { default?: { id?: string; tui?: unknown } };
    check("TUI entry imports without a missing-runtime error", true);
    check(
        "exports the { id, tui } plugin shape",
        mod.default?.id === "opencode-magic-context" && typeof mod.default?.tui === "function",
        `got id=${mod.default?.id} tui=${typeof mod.default?.tui}`,
    );
} catch (error) {
    check(
        "TUI entry imports without a missing-runtime error",
        false,
        error instanceof Error ? error.message : String(error),
    );
}

if (failures > 0) {
    console.error(`\nsmoke-tui-import: ${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nsmoke-tui-import: all checks passed");
