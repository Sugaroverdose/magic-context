/**
 * Renders the shipped, compiled `/ctx-status` dialog for every status payload
 * the dialog can receive, and checks that each one draws and none throws.
 *
 * Previously the dialog read the RPC reply unchecked: a reply without
 * `usagePercentage` (the server's `{ disabled: true }` answer for a home
 * directory or a paused project identity) threw inside the view memo, and
 * OpenCode's crash screen then reported the follow-on
 * "undefined is not an object (evaluating 'view().headline')".
 *
 * The rendering happens in `scripts/render-compiled-status-dialog.ts`, a child
 * process, because it has to register OpenCode's runtime module registry and
 * that registration cannot be undone inside this test process.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { checkStatusDetailPayload, statusRpcFailure } from "../../shared/status-view-check";
import type { StatusDetailResult } from "../data/context-db";

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
const { pluginVersion: _omitted, ...OLDER_SERVER } = COMPLETE;

const CASES: Array<{ name: string; status: StatusDetailResult; expected: string[] }> = [
    {
        name: "a complete snapshot",
        status: checkStatusDetailPayload(COMPLETE, UI),
        expected: ["Magic Context Status", "12.5% / 65%"],
    },
    {
        name: "an RPC transport failure",
        status: statusRpcFailure("connect ECONNREFUSED"),
        expected: ["Status unavailable", "server did not answer"],
    },
    {
        name: "an error envelope",
        status: checkStatusDetailPayload({ error: "unavailable" }, UI),
        expected: ["Status unavailable", "server did not answer"],
    },
    {
        name: "the home-directory reply",
        status: checkStatusDetailPayload({ sessionId: "s", disabled: true }, UI),
        expected: ["Status unavailable", "home directory"],
    },
    {
        name: "the paused-identity reply",
        status: checkStatusDetailPayload({ sessionId: "s", disabled: true, paused: true }, UI),
        expected: ["Status unavailable", "memory paused"],
    },
    {
        name: "an empty reply",
        status: checkStatusDetailPayload({}, UI),
        expected: ["Status unavailable", "incomplete status data"],
    },
    {
        name: "an older server's snapshot",
        status: checkStatusDetailPayload(OLDER_SERVER, UI),
        expected: ["12.5% / 65%", "An older Magic Context server"],
    },
];

let results: Array<{ frame?: string; error?: string }> = [];

beforeAll(() => {
    const script = join(import.meta.dir, "../../../scripts/render-compiled-status-dialog.ts");
    const child = Bun.spawnSync(["bun", script], {
        stdin: new TextEncoder().encode(JSON.stringify(CASES.map((entry) => entry.status))),
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
    });
    if (child.exitCode !== 0) {
        throw new Error(`render script failed: ${child.stderr.toString()}`);
    }
    results = JSON.parse(child.stdout.toString());
}, 60_000);

describe("compiled /ctx-status dialog", () => {
    for (const [index, entry] of CASES.entries()) {
        test(`draws ${entry.name} without throwing`, () => {
            const result = results[index];
            expect(result?.error).toBeUndefined();
            for (const text of entry.expected) expect(result?.frame).toContain(text);
        });
    }
});
