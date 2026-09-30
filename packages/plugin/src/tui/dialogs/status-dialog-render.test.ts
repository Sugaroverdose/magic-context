/**
 * Renders the shipped, compiled `/ctx-status` dialog
 * (`src/tui-compiled/dialogs/status-dialog.tsx`) for every status payload the
 * dialog can receive, and checks that each one draws and none throws.
 *
 * Before issue 584 the dialog read the RPC reply unchecked: a reply without
 * `usagePercentage` (the server's `{ disabled: true }` answer for a home
 * directory or a paused project identity) threw inside the view memo, and
 * OpenCode's crash screen then reported the follow-on
 * "undefined is not an object (evaluating 'view().headline')".
 *
 * The compiled component imports its runtime from OpenCode's
 * `opentui:runtime-module:*` registry. Bare Bun has none, so this file
 * registers the same modules from this package's own dependencies before
 * loading the component.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { plugin } from "bun";
import { checkStatusDetailPayload, statusRpcFailure } from "../../shared/status-view-check";
import { runtimeModuleId, TUI_RUNTIME_SPECIFIERS } from "../../shared/tui-runtime-specifiers";
import type { StatusDetailResult } from "../data/context-db";

type TestRender = (
    node: () => unknown,
    options: { width: number; height: number },
) => Promise<{ renderOnce(): Promise<void>; captureCharFrame(): string }>;

type CompiledDialog = {
    StatusDialog(props: { api: unknown; status: StatusDetailResult }): unknown;
};

let testRender: TestRender;
let dialog: CompiledDialog;

beforeAll(async () => {
    const loaded = new Map<string, Record<string, unknown>>();
    for (const specifier of TUI_RUNTIME_SPECIFIERS) loaded.set(specifier, await import(specifier));
    plugin({
        name: "opentui-runtime-registry-for-tests",
        setup(build) {
            for (const specifier of TUI_RUNTIME_SPECIFIERS) {
                build.module(runtimeModuleId(specifier), () => ({
                    exports: loaded.get(specifier) ?? {},
                    loader: "object",
                }));
            }
        },
    });
    testRender = (loaded.get("@opentui/solid") as { testRender: TestRender }).testRender;
    dialog = (await import("../../tui-compiled/dialogs/status-dialog.tsx")) as CompiledDialog;
});

const THEME = {
    accent: "#ffcc00",
    text: "#ffffff",
    textMuted: "#888888",
    warning: "#ff8800",
    error: "#ff0000",
};

async function frameFor(status: StatusDetailResult): Promise<string> {
    const setup = await testRender(
        () => dialog.StatusDialog({ api: { theme: { current: THEME } }, status }),
        { width: 110, height: 50 },
    );
    await setup.renderOnce();
    return setup.captureCharFrame();
}

const UI = "0.44.5";

const COMPLETE = {
    sessionId: "ses_complete",
    pluginVersion: UI,
    usagePercentage: 12.5,
    inputTokens: 25_000,
    contextLimit: 200_000,
    executeThreshold: 65,
    systemPromptTokens: 5_000,
    docsTokens: 0,
    compartmentTokens: 0,
    compartmentCount: 0,
    factTokens: 0,
    memoryTokens: 0,
    memoryBlockCount: 0,
    profileTokens: 0,
    conversationTokens: 20_000,
    toolCallTokens: 0,
    toolDefinitionTokens: 0,
    activeTags: 0,
    droppedTags: 0,
    totalTags: 0,
    activeBytes: 0,
    lastNudgeTokens: 0,
    pendingOpsCount: 0,
    protectedTagCount: 0,
    isSubagent: false,
    cacheTtl: "5m",
    lastResponseTime: 0,
    cacheRemainingMs: 0,
    cacheExpired: false,
    historyBlockTokens: 0,
    compressionBudget: null,
    compressionUsage: null,
    memoryCount: 0,
};

describe("compiled /ctx-status dialog", () => {
    test("draws a complete snapshot", async () => {
        const frame = await frameFor(checkStatusDetailPayload(COMPLETE, UI));
        expect(frame).toContain("Magic Context Status");
        expect(frame).toContain("12.5% / 65%");
    });

    const unavailable: Array<[string, () => StatusDetailResult, string]> = [
        [
            "an RPC transport failure",
            () => statusRpcFailure("connect ECONNREFUSED"),
            "server did not answer",
        ],
        [
            "an error envelope",
            () => checkStatusDetailPayload({ error: "unavailable" }, UI),
            "server did not answer",
        ],
        [
            "the home-directory reply",
            () => checkStatusDetailPayload({ sessionId: "s", disabled: true }, UI),
            "home directory",
        ],
        [
            "the paused-identity reply",
            () => checkStatusDetailPayload({ sessionId: "s", disabled: true, paused: true }, UI),
            "memory paused",
        ],
        ["an empty reply", () => checkStatusDetailPayload({}, UI), "incomplete status data"],
    ];
    for (const [name, status, reason] of unavailable) {
        test(`draws ${name} as the unavailable view`, async () => {
            const frame = await frameFor(status());
            expect(frame).toContain("Status unavailable");
            expect(frame).toContain(reason);
        });
    }

    test("draws an older server's snapshot and names the older server", async () => {
        const { pluginVersion: _omitted, ...older } = COMPLETE;
        const frame = await frameFor(checkStatusDetailPayload(older, UI));
        expect(frame).toContain("12.5% / 65%");
        expect(frame).toContain("An older Magic Context server");
    });
});
