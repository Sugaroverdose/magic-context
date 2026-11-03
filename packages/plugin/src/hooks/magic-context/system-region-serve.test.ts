/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { encodeSystemRegionRow } from "../../features/magic-context/system-region";
import type { PromptSurfaceConfig } from "../../shared/prompt-surface";
import type { PromptSurfaceRuntime } from "../../shared/prompt-surface-runtime";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import { createSystemPromptHashHandler } from "./system-prompt-hash";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function buildHandler(opts?: {
    historyRefreshSessions?: Set<string>;
    systemPromptRefreshSessions?: Set<string>;
    pendingMaterializationSessions?: Set<string>;
    promptSurface?: PromptSurfaceConfig;
    promptSurfaceRuntime?: PromptSurfaceRuntime;
    systemRegionLane?: boolean;
}): ReturnType<typeof createSystemPromptHashHandler> {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        dreamerEnabled: false,
        promptSurface: opts?.promptSurface,
        promptSurfaceRuntime: opts?.promptSurfaceRuntime,
        resolveModel: () => ({ providerID: "provider", modelID: "default-model" }),
        historyRefreshSessions: opts?.historyRefreshSessions ?? new Set<string>(),
        systemPromptRefreshSessions: opts?.systemPromptRefreshSessions ?? new Set<string>(),
        pendingMaterializationSessions: opts?.pendingMaterializationSessions ?? new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        systemRegionLane: opts?.systemRegionLane,
    });
}

function freezeReduce(sessionId: string): void {
    resolveCtxReduceAvailabilityFromMessages(sessionId, [
        { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ] as never);
}

function seedRegion(sessionId: string, region: string | null): void {
    const db = openDatabase();
    getOrCreateSessionMeta(db, sessionId);
    updateSessionMeta(db, sessionId, {
        cachedM0Bytes: region === null ? null : encodeSystemRegionRow(region),
    });
}

async function pass(
    handler: ReturnType<typeof createSystemPromptHashHandler>["handler"],
    sessionId: string,
    system: string,
): Promise<string> {
    const output = { system: [system] };
    await handler({ sessionID: sessionId }, output);
    return output.system[0];
}

describe("system-region serve: frozen bytes in the watched system channel", () => {
    it("law 1+2: steady passes replay the region byte-identical; panel state never busts the hash", async () => {
        useTempDataHome("srg-boot-identity-");
        const sessionId = "ses-srg-boot";
        freezeReduce(sessionId);
        seedRegion(sessionId, "<project-docs>DOC-A</project-docs>\n<memory>P</memory>");
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            systemRegionLane: true,
        });

        const first = await pass(handler, sessionId, "Base host prompt");
        expect(first).toContain("<project-docs>DOC-A</project-docs>");
        const meta1 = getOrCreateSessionMeta(openDatabase(), sessionId);
        expect(meta1.systemPromptHash).not.toBe("");
        const hash1 = meta1.systemPromptHash;

        const second = await pass(handler, sessionId, "Base host prompt");
        expect(second).toBe(first);
        const meta2 = getOrCreateSessionMeta(openDatabase(), sessionId);
        expect(meta2.systemPromptHash).toBe(hash1);
        // The whole `reason=unknown executed=false` class: a panel-side change
        // must not move the watched hash nor schedule any bust. Steady passes
        // add nothing to the refresh sets.
        expect(historyRefreshSessions.size).toBe(0);
        expect(systemPromptRefreshSessions.size).toBe(0);
        expect(pendingMaterializationSessions.size).toBe(0);
        clearCtxReduceAvailability(sessionId);
    });

    it("law 3: a host-content change still moves the watched hash and re-anchors, region preserved", async () => {
        useTempDataHome("srg-reanchor-");
        const sessionId = "ses-srg-reanchor";
        freezeReduce(sessionId);
        seedRegion(sessionId, "<project-docs>DOC-B</project-docs>");
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const { handler } = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            systemRegionLane: true,
        });

        await pass(handler, sessionId, "Base host prompt");
        const hash1 = getOrCreateSessionMeta(openDatabase(), sessionId).systemPromptHash;

        const changed = await pass(handler, sessionId, "CHANGED host prompt");
        const meta = getOrCreateSessionMeta(openDatabase(), sessionId);
        expect(meta.systemPromptHash).not.toBe(hash1);
        // The immediate-fold re-anchor arm is preserved verbatim for H changes
        // (V5): the hash-change path schedules the flush/materialization sets.
        expect(historyRefreshSessions.has(sessionId)).toBe(true);
        expect(systemPromptRefreshSessions.has(sessionId)).toBe(true);
        expect(pendingMaterializationSessions.has(sessionId)).toBe(true);
        // The frozen region rides the bust unchanged.
        expect(changed).toContain("<project-docs>DOC-B</project-docs>");
        expect(changed.startsWith("CHANGED host prompt")).toBe(true);
        clearCtxReduceAvailability(sessionId);
    });

    it("law: region bytes are excluded from the hash and included in the pressure estimate", async () => {
        useTempDataHome("srg-split-");
        const sessionId = "ses-srg-split";
        freezeReduce(sessionId);
        seedRegion(sessionId, "<project-docs>SHORT</project-docs>");
        const { handler } = buildHandler({ systemRegionLane: true });

        await pass(handler, sessionId, "Base host prompt");
        const meta1 = getOrCreateSessionMeta(openDatabase(), sessionId);
        const hash1 = meta1.systemPromptHash;
        const tokens1 = meta1.systemPromptTokens;
        expect(tokens1).toBeGreaterThan(0);

        // Simulate a rotation landing between passes: the row changes out from
        // under the serve path. The watched hash must NOT move (no watcher
        // bust, no hash-changed flush), while the served bytes and the token
        // estimate must follow the region.
        seedRegion(sessionId, `<project-docs>${"LONG REGION CONTENT ".repeat(200)}</project-docs>`);
        const second = await pass(handler, sessionId, "Base host prompt");
        const meta2 = getOrCreateSessionMeta(openDatabase(), sessionId);
        expect(meta2.systemPromptHash).toBe(hash1);
        expect(second).toContain("LONG REGION CONTENT");
        expect(meta2.systemPromptTokens).not.toBe(tokens1);
        expect(meta2.systemPromptTokens).toBeGreaterThan(tokens1);
        clearCtxReduceAvailability(sessionId);
    });

    // N3 (round 10): the head lane must be inert by CONSTRUCTION against a
    // region row, not merely by absence of one. Distinct from the row-less
    // boot law: here the stored region EXISTS and the lane is off (a
    // compaction-off or rust-capability boot over a row installed while the
    // lane was on, or after rollback). Nothing region-shaped may leak.
    it("inert capability lane: a seeded region row stays invisible to the head handler", async () => {
        useTempDataHome("srg-lane-off-");
        const sessionId = "ses-srg-lane-off";
        freezeReduce(sessionId);
        const region = "<project-docs>ROGUE-LEAK-CHECK</project-docs>";
        seedRegion(sessionId, region);
        const { handler } = buildHandler({ systemRegionLane: false });
        const served = await pass(handler, sessionId, "Base host prompt");
        expect(served).toContain("Base host prompt");
        expect(served).not.toContain("ROGUE-LEAK-CHECK");
        expect(served).not.toContain("mc:system-region");
        clearCtxReduceAvailability(sessionId);
    });

    it("no region row yet: serve is byte-stable host-prompt only (boot before first install)", async () => {
        useTempDataHome("srg-preinstall-");
        const sessionId = "ses-srg-preinstall";
        freezeReduce(sessionId);
        seedRegion(sessionId, null);
        const { handler } = buildHandler({ systemRegionLane: true });
        const bare = await pass(handler, sessionId, "Base host prompt");
        expect(bare).toContain("Base host prompt");
        expect(bare).not.toContain("mc:system-region");
        clearCtxReduceAvailability(sessionId);
    });

    it("law: the midnight date freeze can never reach region bytes", async () => {
        useTempDataHome("srg-date-");
        const sessionId = "ses-srg-date";
        freezeReduce(sessionId);
        const REGION_WITH_DATE =
            "<session-history>\n## 1-9 · 2024-01-01 · Old work\nToday's date: Wed Jan 01 2025 was the day.\n</session-history>";
        seedRegion(sessionId, REGION_WITH_DATE);
        const { handler } = buildHandler({ systemRegionLane: true });

        const first = await pass(handler, sessionId, "Host\nToday's date: Fri Oct 02 2026");
        expect(first).toContain("Today's date: Fri Oct 02 2026");
        expect(first).toContain("Today's date: Wed Jan 01 2025");

        // Midnight flip on a defer pass: the H date rewinds to the sticky one;
        // the region's own date line is untouched and un-rewritten.
        const second = await pass(handler, sessionId, "Host\nToday's date: Sat Oct 03 2026");
        expect(second).toContain("Today's date: Fri Oct 02 2026");
        expect(second).not.toContain("Sat Oct 03 2026");
        expect(second).toContain("Today's date: Wed Jan 01 2025");
        clearCtxReduceAvailability(sessionId);
    });

    it("law L2: restart is replay — a fresh handler on the reopened store serves identical bytes and performs no rotation", async () => {
        useTempDataHome("srg-restart-");
        const sessionId = "ses-srg-restart";
        freezeReduce(sessionId);
        seedRegion(sessionId, "<project-docs>DOC-R</project-docs>\n<memory>R</memory>");
        const { handler } = buildHandler({ systemRegionLane: true });
        const before = await pass(handler, sessionId, "Host prompt");
        const metaBefore = getOrCreateSessionMeta(openDatabase(), sessionId);
        const hashBefore = metaBefore.systemPromptHash;
        const regionBefore = Buffer.from(metaBefore.cachedM0Bytes as Uint8Array);

        // Restart: close the shared handle, reopen the same file, brand-new
        // handler and sets. Boot must be pure replay of stored bytes.
        closeDatabase();
        const historyRefreshSessions = new Set<string>();
        const systemPromptRefreshSessions = new Set<string>();
        const pendingMaterializationSessions = new Set<string>();
        const revived = buildHandler({
            historyRefreshSessions,
            systemPromptRefreshSessions,
            pendingMaterializationSessions,
            systemRegionLane: true,
        });
        const after = await pass(revived.handler, sessionId, "Host prompt");
        expect(after).toBe(before);
        const metaAfter = getOrCreateSessionMeta(openDatabase(), sessionId);
        expect(metaAfter.systemPromptHash).toBe(hashBefore);
        expect(Buffer.from(metaAfter.cachedM0Bytes as Uint8Array)).toEqual(regionBefore);
        expect(historyRefreshSessions.size).toBe(0);
        expect(systemPromptRefreshSessions.size).toBe(0);
        expect(pendingMaterializationSessions.size).toBe(0);
        clearCtxReduceAvailability(sessionId);
    });

    it("law L1: the serve path reads no region or panel state — only the session meta the pass already loads", async () => {
        useTempDataHome("srg-zeroread-");
        const sessionId = "ses-srg-zeroread";
        freezeReduce(sessionId);
        seedRegion(sessionId, "<project-docs>DOC-Z</project-docs>\n<memory>Z</memory>");
        const db = openDatabase();
        const originalPrepare = db.prepare.bind(db);
        const statements: string[] = [];
        db.prepare = ((sql: string) => {
            statements.push(sql);
            return originalPrepare(sql);
        }) as typeof db.prepare;
        try {
            const { handler } = buildHandler({ systemRegionLane: true });
            const served = await pass(handler, sessionId, "Host prompt");
            expect(served).toContain("<project-docs>DOC-Z</project-docs>");
            // Zero store reads on the serve path beyond what the pass already
            // performs: no region SELECT, no panel-table (compartments,
            // memories, user memories, notes) touch during a serve pass.
            const leaks = statements.filter(
                (sql) =>
                    !/^\s*SELECT \* FROM session_meta/i.test(sql) &&
                    !/FROM session_meta WHERE/i.test(sql) &&
                    /cached_m0_bytes|FROM compartments|FROM memories|FROM user_memories|FROM notes/i.test(
                        sql,
                    ),
            );
            expect(leaks).toEqual([]);
            // Exactly the one meta read the pass already performs; a second
            // meta SELECT is a live re-derivation dressed as replay.
            const metaReads = statements.filter((sql) => /FROM session_meta WHERE/i.test(sql));
            expect(metaReads.length).toBe(1);
        } finally {
            db.prepare = originalPrepare as typeof db.prepare;
        }
        clearCtxReduceAvailability(sessionId);
    });
});
