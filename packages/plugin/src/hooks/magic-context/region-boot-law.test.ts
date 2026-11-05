/// <reference types="bun-types" />

/**
 * Region boot law (assembly-v2 Unit 0, plan Step 3).
 *
 * Reproduces the defect-4 receipt shape of assembly's
 * restore-only-boot-pass.ts — cold boot → replay, zero fold — in the
 * region-era receipt vocabulary of InjectM0M1Result. That file does not
 * exist on v2; this law is new and its receipts are read from
 * prepareRegionReplay, never from the assembly file's vocabulary.
 *
 * Spec §10 pass-level gap (disclosed): this law drives the named
 * production entries — prepareRegionReplay, the promotion call-site
 * composition (regionRotationPromotion + currentRegionMarkersForPromotion
 * per #2710/#2715: markers come only from the production readers, the
 * scheduler decision only from the production scheduler), mustMaterialize
 * with the transform.ts:2437-2465 boot hardSignals shape, and the
 * system-prompt serve handler on the system-region-serve.test.ts:93-125
 * fresh-handler + reopened-temp-store pattern — not the full
 * runPostTransformPhase pass. Pass-level boot wiring (the usage-unknown
 * detector feeding the scheduler) is the §10 gap; it is ruled in
 * docs/plans/v2-boot-gate-adjudication.md, not here.
 *
 * The law must pass on v2 as-is (GLM A6: boot law drivable). It asserts:
 *  1. byte-identical boot serve across a store reopen (#2622);
 *  2. the replay entry answers {value:false, reason:"cache_hit"} with
 *     m0RematerializedThisPass:false and no head/m[1] carriage;
 *  3. zero rotations through the production promotion composition, with
 *     two-sided controls (comparator bite + boot-gate bite) so the
 *     decline is never vacuous;
 *  4. the materialized_at witness stands: quiescent boot does not fold,
 *     a post-fold response + idle expiry re-arms the fold (control).
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { computeHardCacheExpired, createScheduler } from "../../features/magic-context/scheduler";
import {
    bumpProjectMemoryEpoch,
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { readSystemRegion } from "../../features/magic-context/system-region";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import {
    currentRegionMarkersForPromotion,
    injectM0M1,
    type M0M1State,
    mustMaterialize,
    prepareRegionReplay,
    regionMarkersFromSnapshot,
    snapshotMarkersFromCachedM0,
} from "./inject-compartments";
import { recomputeRegionVolatileSegment, serveRegionVolatile } from "./region-volatile";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import type { MessageLike } from "./tag-messages";
import { regionRotationPromotion } from "./transform-postprocess-phase";

const SESSION_ID = "ses_region_boot_law";
const PROJECT_PATH = "/tmp/test-region-boot";
const MODEL_KEY = "provider/default-model";

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

// Fresh handler per boot: the system-region-serve.test.ts:93-125 pattern —
// every boot in these laws builds its own handler over a fresh Set surface,
// which is what makes the pass a new process epoch (empty watcher state).
function buildHandler(): ReturnType<typeof createSystemPromptHashHandler> {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        dreamerEnabled: false,
        resolveModel: () => ({ providerID: "provider", modelID: "default-model" }),
        historyRefreshSessions: new Set<string>(),
        systemPromptRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        systemRegionLane: true,
    });
}

function freezeReduce(sessionId: string): void {
    resolveCtxReduceAvailabilityFromMessages(sessionId, [
        { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ] as never);
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

function docsDir(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "region-boot-docs-"));
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nboot law doc.\n");
    writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\nmap.\n");
    return dir;
}

function rowWitness(db: Database): {
    cached_m0_bytes: Uint8Array | null;
    cached_m1_bytes: Uint8Array | null;
    cached_m0_materialized_at: number | null;
} {
    return db
        .prepare(
            "SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_materialized_at FROM session_meta WHERE session_id = ?",
        )
        .get(SESSION_ID) as never;
}

// The boot hardSignals shape mirrored from transform.ts:2437-2465
// (HARD-bust signal construction + const m0HardSignals):
// systemHash from the persisted watched hash, modelKey from the resolved
// model, cacheExpired from the production clock against the persisted
// lastResponseTime. No hand-shaped signals.
function bootHardSignals(state: {
    systemPromptHash: string;
    lastResponseTime: number;
    cacheTtl: string;
}) {
    return {
        systemHash: state.systemPromptHash,
        modelKey: MODEL_KEY,
        cacheExpired: computeHardCacheExpired(state.cacheTtl, state.lastResponseTime, Date.now()),
        lastResponseTime: state.lastResponseTime,
    };
}

// The promotion call-site composition (transform-postprocess-phase.ts:
// 1935-1950): captured via snapshotMarkersFromCachedM0 on the reopened
// row, current via currentRegionMarkersForPromotion — #2710/#2715.
function bootPromotion(db: Database, dir: string, boundaryPermission: boolean, forceBand = false) {
    const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
    const foldDueArgs = {
        db,
        sessionId: SESSION_ID,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: dir,
        injectDocs: true,
    };
    const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
    return regionRotationPromotion({
        systemRegionLane: true,
        freezeM0M1: false,
        foldDue: false,
        boundaryPermission,
        forceBand,
        storedRegion: readSystemRegion(db, SESSION_ID),
        capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
        currentMarkers: currentRegionMarkersForPromotion(foldDueArgs),
    });
}

describe("region boot law: cold boot is a replay, not a fold", () => {
    it("quiescent boot: replay receipts, zero rotations (production composition), witness unmoved", async () => {
        const dir = docsDir();
        try {
            useTempDataHome("region-boot-quiescent-");
            const db = openDatabase();
            getOrCreateSessionMeta(db, SESSION_ID);
            insertMemory(db, {
                projectPath: PROJECT_PATH,
                category: "ARCHITECTURE",
                content: "boot law memory",
            });

            // Pre-restart warm passes: the hash baseline, then the region
            // install through the PRODUCTION rotation path (injectM0M1 with
            // the region fold option — the same entry materializeM0 uses at
            // the boundary, real captured markers, real materialized_at).
            freezeReduce(SESSION_ID);
            const warmHandler = buildHandler();
            await pass(warmHandler.handler, SESSION_ID, "Base host prompt");
            const metaWarm = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const hardSignals = bootHardSignals(metaWarm);
            const foldDueArgs = {
                db,
                sessionId: SESSION_ID,
                state: metaWarm,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
            };
            injectM0M1({
                ...foldDueArgs,
                messages: [
                    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
                ] as MessageLike[],
                isCacheBustingPass: true,
                systemRegion: { enabled: true, reason: "hard_fold" },
                hardSignals,
            } as never);
            const warmServe = await pass(warmHandler.handler, SESSION_ID, "Base host prompt");
            expect(warmServe).toContain("boot law memory");

            const before = rowWitness(db);
            expect(before.cached_m0_bytes).not.toBeNull();
            expect(before.cached_m1_bytes).toBeNull();
            expect(before.cached_m0_materialized_at).toBeGreaterThan(0);

            // ── Restart: close and reopen the same temp store; the handler
            // below is freshly constructed, so the process epoch is empty. ──
            closeDatabase();
            const bootDb = openDatabase();
            clearCtxReduceAvailability(SESSION_ID);
            freezeReduce(SESSION_ID);
            const bootHandler = buildHandler();
            const bootServe = await pass(bootHandler.handler, SESSION_ID, "Base host prompt");

            // Receipt 1: byte-identical boot serve across the reopen (#2622).
            expect(bootServe).toBe(warmServe);

            // Receipt 2: the named replay entry serves the stored row as a
            // cache_hit — no rematerialization, no head carriage, no m[1].
            const replay = prepareRegionReplay(bootDb, SESSION_ID);
            expect(replay).toBeDefined();
            expect(replay!.injected).toBe(true);
            expect(replay!.m0RematerializedThisPass).toBe(false);
            expect(replay!.decision).toEqual({ value: false, reason: "cache_hit" });
            expect(replay!.prependedMessageCount).toBe(0);
            expect(replay!.preparedMessages ?? []).toHaveLength(0);
            expect(replay!.m1Text).toBe("");

            // Receipt 3: zero folds — the region bytes and the
            // materialized_at witness are unmoved across the boot pass.
            const after = rowWitness(bootDb);
            expect(
                Buffer.from(after.cached_m0_bytes!).equals(Buffer.from(before.cached_m0_bytes!)),
            ).toBe(true);
            expect(after.cached_m0_materialized_at).toBe(before.cached_m0_materialized_at);
            expect(after.cached_m1_bytes).toBeNull();

            // Receipt 4: no fold is due on the boot pass (production
            // mustMaterialize, region mode, boot hardSignals shape).
            const bootState = getOrCreateSessionMeta(bootDb, SESSION_ID) as unknown as M0M1State;
            const foldDue = mustMaterialize({
                db: bootDb,
                sessionId: SESSION_ID,
                state: bootState,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
                hardSignals: bootHardSignals(bootState),
                systemRegionMode: true,
            });
            expect(foldDue.value).toBe(false);

            // Receipt 5: zero rotations through the production promotion
            // composition. The scheduler decision is the production one:
            // a quiescent boot (no usage this process, lastResponseTime 0)
            // defers, so no boundary permission exists to ride.
            const schedulerDecision = createScheduler({
                executeThresholdPercentage: 65,
            }).shouldExecute(
                bootState as never,
                { percentage: 0, inputTokens: 0 },
                Date.now(),
                SESSION_ID,
                MODEL_KEY,
            );
            expect(schedulerDecision).toBe("defer");
            expect(bootPromotion(bootDb, dir, schedulerDecision === "execute")).toEqual({
                promote: false,
                reason: null,
            });

            // Docs edits never promote (Task 3 demotion): with the boundary
            // permission and an edited docs file the composition stays
            // silent — the panel converges at the next legitimate fold.
            writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nchanged doc.\n");
            expect(bootPromotion(bootDb, dir, true)).toEqual({
                promote: false,
                reason: null,
            });
            // Control (comparator bite, warm): the same production
            // composition on a boundary pass with a genuine content trigger
            // MUST promote — the quiescent decline above is marker equality,
            // not a deadened comparator. (Unit 2 Task 3: the docs hash was
            // the original bite operand; it is demoted to the volatile
            // carrier, so the bite control uses the dashboard epoch — a
            // surviving compared member.)
            bumpProjectMemoryEpoch(bootDb, PROJECT_PATH);
            expect(bootPromotion(bootDb, dir, true)).toEqual({
                promote: true,
                reason: "project_memory_epoch",
            });
            // Control (boot-gate bite): the same stale manifest never
            // promotes without boundary permission — the ride-only gate
            // is what declines a boot pass, per L4.
            expect(bootPromotion(bootDb, dir, false)).toEqual({
                promote: false,
                reason: null,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("idle-restored boot (scheduler boots execute on the persisted clock): still replay, still zero folds", async () => {
        const dir = docsDir();
        try {
            useTempDataHome("region-boot-idle-");
            const db = openDatabase();
            getOrCreateSessionMeta(db, SESSION_ID);
            insertMemory(db, {
                projectPath: PROJECT_PATH,
                category: "ARCHITECTURE",
                content: "boot law memory",
            });
            freezeReduce(SESSION_ID);
            const warmHandler = buildHandler();
            await pass(warmHandler.handler, SESSION_ID, "Base host prompt");
            const metaWarm = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                state: metaWarm,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
                messages: [
                    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
                ] as MessageLike[],
                isCacheBustingPass: true,
                systemRegion: { enabled: true, reason: "hard_fold" },
                hardSignals: bootHardSignals(metaWarm),
            } as never);
            const warmServe = await pass(warmHandler.handler, SESSION_ID, "Base host prompt");
            const before = rowWitness(db);
            const materializedAt = before.cached_m0_materialized_at!;

            // The assembly census shape: a healthy session restores with a
            // pre-restart response clock past the TTL, so the scheduler
            // boots it `execute` (the ttl_idle reading the restore-only
            // law distrusted). The fold witness must still hold: the last
            // response predates the last materialization.
            const tIdle = materializedAt - 10 * 60 * 1000;
            updateSessionMeta(db, SESSION_ID, { lastResponseTime: tIdle, cacheTtl: "5m" });

            closeDatabase();
            const bootDb = openDatabase();
            clearCtxReduceAvailability(SESSION_ID);
            freezeReduce(SESSION_ID);
            const bootHandler = buildHandler();
            const bootServe = await pass(bootHandler.handler, SESSION_ID, "Base host prompt");
            expect(bootServe).toBe(warmServe);

            const bootState = getOrCreateSessionMeta(bootDb, SESSION_ID) as unknown as M0M1State;
            const schedulerDecision = createScheduler({
                executeThresholdPercentage: 65,
            }).shouldExecute(
                bootState as never,
                { percentage: 0, inputTokens: 0 },
                Date.now(),
                SESSION_ID,
                MODEL_KEY,
            );
            expect(schedulerDecision).toBe("execute");

            const replay = prepareRegionReplay(bootDb, SESSION_ID);
            expect(replay!.decision).toEqual({ value: false, reason: "cache_hit" });
            expect(replay!.m0RematerializedThisPass).toBe(false);

            // The self-consuming witness: cacheExpired is true by
            // construction on this boot, yet lastResponseTime does not
            // exceed materialized_at → no fold.
            const foldDue = mustMaterialize({
                db: bootDb,
                sessionId: SESSION_ID,
                state: bootState,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
                hardSignals: bootHardSignals(bootState),
                systemRegionMode: true,
            });
            expect(foldDue.value).toBe(false);
            expect(bootHardSignals(bootState).cacheExpired).toBe(true);

            // Boundary permission EXISTS this boot (scheduler execute), so
            // the zero-rotation claim leans entirely on the production
            // marker comparison.
            expect(bootPromotion(bootDb, dir, true)).toEqual({ promote: false, reason: null });

            const after = rowWitness(bootDb);
            expect(
                Buffer.from(after.cached_m0_bytes!).equals(Buffer.from(before.cached_m0_bytes!)),
            ).toBe(true);
            expect(after.cached_m0_materialized_at).toBe(before.cached_m0_materialized_at);

            // Control (witness bite): a response that completed AFTER the
            // last fold, followed by idle expiry, re-arms the ttl_idle
            // fold — the boot decline above is the witness, not absence
            // of the arm.
            // Arm window: the response completed AFTER the last fold, and
            // the idle gap since that response now exceeds the TTL. Both
            // landmarks must sit in the past for cacheExpired AND the
            // witness comparison to hold together.
            const tArmedResponse = Date.now() - 10 * 60 * 1000;
            updateSessionMeta(bootDb, SESSION_ID, { lastResponseTime: tArmedResponse });
            bootDb
                .prepare(
                    "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
                )
                .run(tArmedResponse - 5 * 60 * 1000, SESSION_ID);
            const armedState = getOrCreateSessionMeta(bootDb, SESSION_ID) as unknown as M0M1State;
            const armed = mustMaterialize({
                db: bootDb,
                sessionId: SESSION_ID,
                state: armedState,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
                hardSignals: bootHardSignals(armedState),
                systemRegionMode: true,
            });
            expect(armed.value).toBe(true);
            expect(armed.reason).toBe("ttl_idle");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/**
 * Unit 2 Step 2 — the region is four panels only.
 *
 * The delta half (m[1]-era content) must be gone from the region bytes: the
 * region carries the frozen panels and nothing else, and every delta class is
 * reachable ONLY through the volatile segment. Red-first for the Step 2
 * lift: before the lift the region body still ends with the delta half, so
 * the "region has no delta block" assertion fails.
 */
describe("region four-panel-only contract (Unit 2 Step 2)", () => {
    it("the installed region carries no delta block and no never-empty placeholder tail", async () => {
        const dir = docsDir();
        try {
            useTempDataHome("region-four-panel-");
            const db = openDatabase();
            getOrCreateSessionMeta(db, SESSION_ID);
            insertMemory(db, {
                projectPath: PROJECT_PATH,
                category: "ARCHITECTURE",
                content: "four panel memory",
            });
            freezeReduce(SESSION_ID);
            const handler = buildHandler();
            await pass(handler.handler, SESSION_ID, "Base host prompt");
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
                messages: [
                    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
                ] as MessageLike[],
                isCacheBustingPass: true,
                systemRegion: { enabled: true, reason: "hard_fold" },
                hardSignals: bootHardSignals(state),
            } as never);

            const region = readSystemRegion(db, SESSION_ID);
            expect(region).not.toBeNull();
            // Panels survive.
            expect(region!).toContain("<project-docs>");
            expect(region!).toContain("<project-memory>");
            expect(region!).toContain("four panel memory");
            // The delta half is gone: no since-block, no placeholder floor, no
            // delta-only blocks.
            expect(region!).not.toContain("<session-history-since>");
            expect(region!).not.toContain("(no new content since last materialization)");
            expect(region!).not.toContain("<new-compartments>");
            expect(region!).not.toContain("<new-memories>");
            expect(region!).not.toContain("<memory-updates>");
            expect(region!).not.toContain("<new-user-profile>");
            // Byte-exact tail: the region ends with the last panel's close tag,
            // i.e. nothing was concatenated after the panels.
            expect(region!.endsWith("</project-memory>")).toBe(true);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("the delta half moved to volatile, not dropped: post-fold memory surfaces via the segment", async () => {
        const dir = docsDir();
        try {
            useTempDataHome("region-delta-moved-");
            const db = openDatabase();
            getOrCreateSessionMeta(db, SESSION_ID);
            insertMemory(db, {
                projectPath: PROJECT_PATH,
                category: "ARCHITECTURE",
                content: "baseline panel memory",
            });
            freezeReduce(SESSION_ID);
            const handler = buildHandler();
            await pass(handler.handler, SESSION_ID, "Base host prompt");
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory: dir,
                injectDocs: true,
                messages: [
                    { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
                ] as MessageLike[],
                isCacheBustingPass: true,
                systemRegion: { enabled: true, reason: "hard_fold" },
                hardSignals: bootHardSignals(state),
            } as never);
            const regionBefore = readSystemRegion(db, SESSION_ID)!;

            // A memory written AFTER the fold is delta-class: it must reach the
            // wire through the volatile segment, never through the region.
            insertMemory(db, {
                projectPath: PROJECT_PATH,
                category: "CONSTRAINTS",
                content: "post fold delta memory",
            });
            const meta = getOrCreateSessionMeta(db, SESSION_ID);
            const rendered = recomputeRegionVolatileSegment({
                db,
                sessionId: SESSION_ID,
                meta,
                options: {
                    db,
                    sessionId: SESSION_ID,
                    state: meta as unknown as M0M1State,
                    projectPath: PROJECT_PATH,
                    projectDirectory: dir,
                    injectDocs: true,
                    isCacheBustingPass: true,
                } as never,
            });
            expect(rendered).not.toBeNull();
            expect(rendered!.text).toContain("post fold delta memory");
            expect(rendered!.text).toContain("<session-history-since>");
            // The segment is stored, and serving it requires the watermark to
            // name the region row it was rendered against.
            expect(serveRegionVolatile(getOrCreateSessionMeta(db, SESSION_ID))).toContain(
                "post fold delta memory",
            );
            const served = await pass(handler.handler, SESSION_ID, "Base host prompt");
            expect(served).toContain("post fold delta memory");
            // The region bytes did not move: the delta never re-enters them.
            expect(readSystemRegion(db, SESSION_ID)).toBe(regionBefore);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
