import { afterEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { getSubagentInvocations } from "../../features/magic-context/storage-subagent-invocations";
import type { PluginContext } from "../../plugin/types";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { runValidatedHistorianPass } from "./compartment-runner-historian";
import type { HiddenCompletionExecutor } from "./compartment-runner-types";

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

test("historian ledger distinguishes empty, reasoning-only, length-capped and valid output", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-historian-ledger-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cases = [
        { text: null, reasoning: null, lengthCapped: false, expected: "empty" },
        { text: null, reasoning: "thinking", lengthCapped: false, expected: "empty" },
        { text: null, reasoning: "thinking", lengthCapped: true, expected: "empty" },
        {
            text: '<output><compartment start="1" end="1" title="History"><p1>Preserve this.</p1></compartment></output>',
            reasoning: null,
            lengthCapped: false,
            expected: "completed",
        },
    ] as const;
    for (const [index, item] of cases.entries()) {
        const executor: HiddenCompletionExecutor = {
            capabilities: { tools: false, harness: "opencode" },
            open: async () => ({ id: `child-${index}`, childSessionId: `child-${index}` }),
            attempt: async () => {},
            collect: async () => ({ ...item, usage }),
            close: async () => {},
        };
        await runValidatedHistorianPass({
            client: undefined,
            hiddenCompletionExecutor: executor,
            db,
            parentSessionId: `parent-${index}`,
            sessionDirectory: directory,
            prompt: "Messages 1-1:\n1: U: preserve this",
            chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
            priorCompartments: [],
            sequenceOffset: 0,
            dumpLabelBase: `case-${index}`,
        });
        const rows = getSubagentInvocations(db, `parent-${index}`);
        expect(rows[0]?.status).toBe(item.expected);
        if (item.expected === "empty") expect(rows[0]?.error).toBeTruthy();
    }
});

test("a resolving timed-out historian prompt is archived and recorded as timed_out", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mc-historian-timeout-"));
    tempDirs.push(directory);
    process.env.XDG_DATA_HOME = directory;
    const db = openDatabase();
    const abort = mock(async () => ({}));
    const update = mock(async () => ({}));
    const remove = mock(async () => ({}));
    const client = {
        session: {
            create: async () => ({ data: { id: "child-timeout" } }),
            prompt: ({ signal }: { signal: AbortSignal }) =>
                new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve())),
            messages: async () => ({ data: [] }),
            abort,
            update,
            delete: remove,
        },
    } as unknown as PluginContext["client"];
    await runValidatedHistorianPass({
        client,
        db,
        parentSessionId: "parent-timeout",
        sessionDirectory: directory,
        prompt: "Messages 1-1:\n1: U: preserve this",
        timeoutMs: 20,
        chunk: { startIndex: 1, endIndex: 1, lines: [{ ordinal: 1, messageId: "message-1" }] },
        priorCompartments: [],
        sequenceOffset: 0,
        dumpLabelBase: "timeout",
    });
    const rows = getSubagentInvocations(db, "parent-timeout");
    expect(rows[0]?.status).toBe("timed_out");
    expect(rows[0]?.error).toContain("prompt timed out after 20ms");
    expect(abort).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
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
