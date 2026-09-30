import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { HiddenCompletionExecutor } from "../../../hooks/magic-context/compartment-runner-types";
import {
    markNoteNudgeDelivered,
    peekNoteNudgeText,
    resetNoteNudgeCooldownOnly,
} from "../../../hooks/magic-context/note-nudger";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { setPersistedNoteNudgeTrigger } from "../storage-meta-persisted";
import { addNote, getNotes } from "../storage-notes";
import type { SmartNoteCapabilityApi } from "./capabilities";
import { compileSmartNoteCheck } from "./compiler";
import { runCompiledSmartNoteCheck } from "./sandbox-runner";
import { markSmartNoteCompilationFailure } from "./storage";
import { SmartNoteNetworkError } from "./types";

const directories: string[] = [];
const databases: Database[] = [];
afterEach(() => {
    for (const db of databases.splice(0)) db.close();
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDirectory(): string {
    const root = path.join(tmpdir(), "magic-context", "smart-notes-fix");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(path.join(root, "fixture-"));
    directories.push(dir);
    return dir;
}
const emptyCapabilities: SmartNoteCapabilityApi = {
    readFile: async () => null,
    gitHeadSha: async () => null,
    gitTag: async () => null,
    gitLog: async () => [],
    httpGet: async () => {
        throw new Error("Unexpected HTTP request");
    },
};
function carrier(outputs: string[]) {
    const requests: string[] = [];
    let calls = 0;
    const executor: HiddenCompletionExecutor = {
        capabilities: { tools: false, harness: "opencode2" },
        open: async () => ({ id: "fixture-compiler" }),
        attempt: async (_handle, request) => {
            requests.push(JSON.stringify(request));
        },
        collect: async () => ({
            text: outputs[Math.min(calls++, outputs.length - 1)],
            reasoning: null,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            lengthCapped: false,
        }),
        close: async () => {},
    };
    return { executor, requests };
}
function output(url: string): string {
    return JSON.stringify({
        compiled_check: `function check(cap) { var r = cap.httpGet(${JSON.stringify(url)}); return { met: r.status === 200 && JSON.parse(r.body).tag_name === "v0.70.0" }; }`,
        manifest: { capabilities: ["httpGet"], hosts: ["api.github.com"], urls: [url] },
        check_cron: "0 * * * *",
    });
}
function compile(
    condition: string,
    capabilities: SmartNoteCapabilityApi,
    executor?: HiddenCompletionExecutor,
) {
    return compileSmartNoteCheck({
        hiddenCompletionExecutor: executor,
        parentSessionId: undefined,
        sessionDirectory: tempDirectory(),
        projectIdentity: "cortexkit/insula",
        note: { id: 1, content: "waiting", surfaceCondition: condition },
        capabilityFactory: () => capabilities,
        signal: new AbortController().signal,
        deadline: Date.now() + 30_000,
    });
}

test("oversized release dry run recompiles once with feedback and fires on bounded latest fixture", async () => {
    const root = "https://api.github.com/repos/steipete/CodexBar/releases";
    const transport = carrier([output(root), output(`${root}/latest`)]);
    const urls: string[] = [];
    const result = await compile(
        "github.com/steipete/CodexBar has a release tag newer than v0.66.0",
        {
            ...emptyCapabilities,
            httpGet: async (url) => {
                urls.push(url);
                if (url === root)
                    throw new SmartNoteNetworkError(
                        `SMART_NOTE_NETWORK: response body too large at ${url} (received at least 98304 bytes; limit 65536)`,
                        { terminal: true, persistent: true },
                    );
                expect(url).toBe(`${root}/latest`);
                return { status: 200, body: JSON.stringify({ tag_name: "v0.70.0" }) };
            },
        },
        transport.executor,
    );
    expect(result).toMatchObject({ ok: true, dryRun: { met: true } });
    expect(urls).toEqual([root, `${root}/latest`]);
    expect(transport.requests).toHaveLength(2);
    expect(transport.requests[1]).toContain("response body too large");
    expect(transport.requests[1]).toContain("Recompile using smaller bounded endpoints");
});

test("oversized repair failure stops after two compiler calls", async () => {
    const url = "https://api.github.com/repos/steipete/CodexBar/releases";
    const transport = carrier([output(url)]);
    const result = await compile(
        "release newer than v0.66.0",
        {
            ...emptyCapabilities,
            httpGet: async () => {
                throw new SmartNoteNetworkError(`response body too large at ${url}`, {
                    terminal: true,
                    persistent: true,
                });
            },
        },
        transport.executor,
    );
    expect(result).toMatchObject({ ok: false, persistent: true });
    expect(transport.requests).toHaveLength(2);
});

const original =
    "a tag on cortexkit/insula that isn't an ancestor of master, or a tag other than v0.1.0/v0.1.1 exists";
function tagRepository() {
    const dir = tempDirectory();
    const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        }).trim();
    git("init", "-b", "master");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("commit", "--allow-empty", "-m", "first");
    git("tag", "v0.1.0");
    git("commit", "--allow-empty", "-m", "second");
    git("tag", "-a", "v0.1.1", "-m", "annotated second");
    git("commit", "--allow-empty", "-m", "master tip");
    const capabilities: SmartNoteCapabilityApi = {
        ...emptyCapabilities,
        httpGet: async (url) => {
            const parsed = new URL(url);
            expect(parsed.hostname).toBe("api.github.com");
            if (parsed.pathname.endsWith("/tags")) {
                expect(parsed.searchParams.get("per_page")).toBe("100");
                const names = git("tag", "--list").split("\n").filter(Boolean);
                return { status: 200, body: JSON.stringify(names.map((name) => ({ name }))) };
            }
            expect(parsed.searchParams.get("per_page")).toBe("1");
            const tag = decodeURIComponent(parsed.pathname.split("...")[1]);
            let ancestor = true;
            try {
                git("merge-base", "--is-ancestor", `${tag}^{commit}`, "master");
            } catch {
                ancestor = false;
            }
            return {
                status: 200,
                body: JSON.stringify({ status: ancestor ? "behind" : "diverged" }),
            };
        },
    };
    return { git, capabilities };
}

test("original tag condition stays unmet with exactly two ancestor tags through the real compiler path", async () => {
    const { git, capabilities } = tagRepository();
    expect(git("tag", "--list").split("\n")).toEqual(["v0.1.0", "v0.1.1"]);
    // A plausible lost-check failure: either allowed name satisfies this OR.
    // The deleted historical check is unavailable, so this is not a claim about
    // the exact code that previously fired in production.
    const unsafe = await runCompiledSmartNoteCheck({
        capabilities,
        compiledCheck: `function check(cap) { var tags = JSON.parse(cap.httpGet("https://api.github.com/repos/cortexkit/insula/tags?per_page=100").body); return { met: tags.some(function(t) { return t.name !== "v0.1.0" || t.name !== "v0.1.1"; }) }; }`,
    });
    expect(unsafe).toEqual({ ok: true, result: { met: true } });
    const result = await compile(original, capabilities);
    expect(result).toMatchObject({ ok: true, dryRun: { met: false } });
});

test("original tag condition fires when an allowed tag diverges from master", async () => {
    const { git, capabilities } = tagRepository();
    git("checkout", "-b", "side", "v0.1.0");
    git("commit", "--allow-empty", "-m", "side tip");
    git("tag", "-f", "v0.1.1");
    git("checkout", "master");
    expect(await compile(original, capabilities)).toMatchObject({
        ok: true,
        dryRun: { met: true },
    });
});

test("original tag condition fires when an additional ancestor tag exists", async () => {
    const { git, capabilities } = tagRepository();
    git("tag", "v0.1.2");
    expect(await compile(original, capabilities)).toMatchObject({
        ok: true,
        dryRun: { met: true },
    });
});

test("tag source failures are not evidence of a met condition", async () => {
    expect(
        await compile(original, {
            ...emptyCapabilities,
            httpGet: async () => ({ status: 403, body: "{}" }),
        }),
    ).toMatchObject({ ok: false });
});

test("tag pagination cannot silently treat a full final page as complete", async () => {
    const urls: string[] = [];
    const result = await compile(original, {
        ...emptyCapabilities,
        httpGet: async (url) => {
            urls.push(url);
            if (url.includes("/compare/")) return { status: 200, body: '{"status":"identical"}' };
            return {
                status: 200,
                body: JSON.stringify(Array.from({ length: 100 }, () => ({ name: "v0.1.0" }))),
            };
        },
    });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("Tag pagination exceeded 1000 tags");
    expect(urls.filter((url) => url.includes("/tags?"))).toHaveLength(10);
});

test("persistent compilation failure nudges its owner once with the reason, not a met verdict", () => {
    const db = new Database(path.join(tempDirectory(), "notes.sqlite"));
    databases.push(db);
    initializeDatabase(db);
    runMigrations(db);
    const sessionId = "failure-owner";
    db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(sessionId);
    const note = addNote(db, "smart", {
        sessionId,
        projectPath: "fixture",
        content: "release watch",
        surfaceCondition: "a release arrives",
    });
    markSmartNoteCompilationFailure(db, note.id, Date.now(), 3, "response body too large", true);
    expect(peekNoteNudgeText(db, "other-owner", "m1", "fixture")).toBeNull();
    expect(peekNoteNudgeText(db, sessionId, "m1", "fixture")).toBeNull();
    const text = peekNoteNudgeText(db, sessionId, "m2", "fixture");
    expect(text).toContain("response body too large");
    expect(text).toContain("NOT evidence that the condition is met");
    expect(markNoteNudgeDelivered(db, sessionId, text ?? "", "m2").ok).toBe(true);
    resetNoteNudgeCooldownOnly(sessionId);
    markSmartNoteCompilationFailure(
        db,
        note.id,
        Date.now(),
        3,
        "response body too large again",
        true,
    );
    setPersistedNoteNudgeTrigger(db, sessionId);
    expect(peekNoteNudgeText(db, sessionId, "m3", "fixture")).toBeNull();
    expect(peekNoteNudgeText(db, sessionId, "m4", "fixture")).toBeNull();
    expect(getNotes(db, { sessionId, type: "session" })).toHaveLength(1);
    expect(getNotes(db, { type: "smart" })[0].status).toBe("pending");
});
