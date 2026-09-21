import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import type { PluginContext } from "../../plugin/types";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { runValidatedHistorianPass } from "./compartment-runner-historian";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    clearModelsDevCache();
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
    tempDirs.length = 0;
});

test("surfaces a settled assistant error instead of reporting empty historian output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-historian-assistant-error-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const assistant = {
        info: {
            role: "assistant",
            time: { created: 1, completed: 2 },
            finish: "error",
            error: {
                name: "ProviderAuthError",
                data: {
                    providerID: "google",
                    message: "Antigravity authorization refused the hidden child session",
                },
            },
        },
        parts: [],
    };
    const client = {
        session: {
            create: async () => ({ data: { id: "child-provider-error" } }),
            prompt: async () => ({ data: assistant }),
            messages: async () => ({ data: [assistant] }),
            delete: async () => ({}),
        },
    } as unknown as PluginContext["client"];

    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "google",
                            models: {
                                "fixture-model": { limit: { context: 200_000, output: 32000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
    const result = await runValidatedHistorianPass({
        model: "google/fixture-model",
        client,
        db,
        parentSessionId: "parent-provider-error",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        chunk: {
            startIndex: 1,
            endIndex: 1,
            lines: [{ ordinal: 1, messageId: "message-1" }],
        },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "provider-error",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("ProviderAuthError");
    expect(result.error).toContain("Antigravity authorization refused the hidden child session");
    expect(result.error).toContain("finish=error");
    expect(result.error).not.toContain("Historian returned no assistant output");
});
