/**
 * Renders the shipped, compiled `/ctx-status` dialog
 * (`src/tui-compiled/dialogs/status-dialog.tsx`) outside OpenCode, for
 * `src/tui/dialogs/status-dialog-render.test.ts`.
 *
 * The compiled component imports its runtime from OpenCode's process-wide
 * `opentui:runtime-module:*` registry. Bare Bun has none, so this script
 * registers the same modules from this package's own dependencies. A Bun
 * plugin cannot be unregistered, which is why this runs as its own process:
 * other tests in the suite check that the registry is absent.
 *
 * Input (stdin): a JSON array of checked status results. Output (stdout): a
 * JSON array with, for each input, either `{ frame }` (the rendered
 * characters) or `{ error }` (the message the render threw).
 */
import { plugin } from "bun";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../src/shared/tui-runtime-specifiers";

type TestRender = (
    node: () => unknown,
    options: { width: number; height: number },
) => Promise<{ renderOnce(): Promise<void>; captureCharFrame(): string }>;

const loaded = new Map<string, Record<string, unknown>>();
for (const specifier of TUI_RUNTIME_SPECIFIERS) loaded.set(specifier, await import(specifier));
plugin({
    name: "opentui-runtime-registry-for-render-script",
    setup(build) {
        for (const specifier of TUI_RUNTIME_SPECIFIERS) {
            build.module(runtimeModuleId(specifier), () => ({
                exports: loaded.get(specifier) ?? {},
                loader: "object",
            }));
        }
    },
});

const { testRender } = loaded.get("@opentui/solid") as { testRender: TestRender };
// Imported by URL so the scripts typecheck does not try to compile the TSX
// output (it is already transformed and has no JSX left in it).
const dialogUrl = new URL("../src/tui-compiled/dialogs/status-dialog.tsx", import.meta.url).href;
const dialog = (await import(dialogUrl)) as {
    StatusDialog(props: { api: unknown; status: unknown }): unknown;
};
const theme = {
    accent: "#ffcc00",
    text: "#ffffff",
    textMuted: "#888888",
    warning: "#ff8800",
    error: "#ff0000",
};

const inputs = JSON.parse(await Bun.stdin.text()) as unknown[];
const results: Array<{ frame: string } | { error: string }> = [];
for (const status of inputs) {
    try {
        const setup = await testRender(
            () => dialog.StatusDialog({ api: { theme: { current: theme } }, status }),
            { width: 110, height: 50 },
        );
        await setup.renderOnce();
        results.push({ frame: setup.captureCharFrame() });
    } catch (error) {
        results.push({ error: error instanceof Error ? error.message : String(error) });
    }
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
