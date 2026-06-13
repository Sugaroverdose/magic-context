/**
 * Unified `setup` command.
 *
 * Resolves the harness target via `--harness` flag or auto-detection
 * (`resolveAdaptersForCommand`), then dispatches to the per-harness
 * setup wizard. We deliberately reuse the existing per-harness
 * setup flows (`setup-opencode.ts` and `setup-pi.ts`) instead of
 * collapsing them into a generic flow because each harness has
 * meaningfully different prompts (OpenCode picks historian models +
 * checks for DCP/OMO conflicts; Pi prompts for Pi version compat
 * + thinking_level for Copilot models).
 */
import type { HarnessAdapter } from "../adapters/types";
import { resolveAdaptersForCommand } from "../lib/harness-select";
import { intro, log, note, outro } from "../lib/prompts";
import { runSetup as runOpenCodeSetup } from "./setup-opencode";
import { runSetup as runPiSetup } from "./setup-pi";

export async function runSetup(argv: string[]): Promise<number> {
    const dryRun = argv.includes("--dry-run");
    intro(dryRun ? "Magic Context setup (dry run)" : "Magic Context setup");

    const adapters = await resolveAdaptersForCommand(argv, {
        allowMulti: true,
        verb: "setup",
    });

    if (adapters.length === 0) {
        outro("No harness selected. Nothing to do.");
        return 0;
    }

    let anyFailure = false;
    for (const adapter of adapters) {
        log.step(`Configuring ${adapter.displayName} (${adapter.pluginPackageName})…`);

        if (!adapter.isInstalled()) {
            log.warn(`${adapter.displayName} host not found on PATH. ${adapter.getInstallHint()}.`);
            anyFailure = true;
            continue;
        }

        const code = await dispatchSetup(adapter, dryRun);
        if (code !== 0) anyFailure = true;
        if (!dryRun) printNextSteps(adapter);
    }

    if (anyFailure) {
        outro("Setup finished with warnings — see above.");
        return 1;
    }
    outro(dryRun ? "Dry run done — no changes were made." : "Done.");
    return 0;
}

async function dispatchSetup(adapter: HarnessAdapter, dryRun: boolean): Promise<number> {
    switch (adapter.kind) {
        case "opencode":
            return runOpenCodeSetup(dryRun);
        case "pi":
            return runPiSetup({ dryRun });
    }
}

function printNextSteps(adapter: HarnessAdapter): void {
    if (adapter.kind === "opencode") {
        note(
            [
                "Restart OpenCode (or reload your session) so the plugin loads.",
                "Verify with: npx @cortexkit/magic-context@latest doctor",
            ].join("\n"),
            "Next steps",
        );
        return;
    }
    if (adapter.kind === "pi") {
        note(
            [
                "Restart your Pi session so the extension registers.",
                "Verify with: npx @cortexkit/magic-context@latest doctor --harness pi",
            ].join("\n"),
            "Next steps",
        );
    }
}
