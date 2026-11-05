/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

// Cache-stability gate for the SOFT+ / SOFT / HARD materialization taxonomy.
//
// This is THE regression guard for the m[0]/m[1] split. The contract:
//   SOFT+ (defer pass, nothing new)      → m[0] AND m[1] replay BYTE-IDENTICAL.
//   SOFT  (exec / cache-busting pass)    → m[1] re-renders, m[0] stays identical.
//   HARD  (TTL idle / system / tools /   → m[0] re-materializes (fold m[1] in),
//          model change, or content)        m[1] resets to placeholder.
//
// The bug this guards against: a routine historian publish (new compartment)
// must NEVER mutate m[0] — folding m[0] on every publish busts the Anthropic
// prompt-cache prefix for the whole conversation. New compartments are an m[1]
// delta that folds into m[0] only on a HARD bust.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPluginConfigDetailed } from "../../config";
import { historianRunConfig } from "../../config/live-run-config";
import { LiveConfigReader } from "../../config/live-snapshot";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { readSystemRegion } from "../../features/magic-context/system-region";
import { resolveHistorianModel } from "../../shared/model-resolution";
import { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    currentRegionMarkersForPromotion,
    injectM0M1,
    type M0HardSignals,
    mustMaterialize,
    regionMarkersFromSnapshot,
    snapshotMarkersFromCachedM0,
} from "./inject-compartments";
import { regionRotationPromotion } from "./transform-postprocess-phase";

const SESSION_ID = "ses_taxonomy";
const PROJECT_PATH = "/tmp/test-taxonomy-project";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-taxonomy-test-"));
    tempDirs.push(dir);
    return dir;
}

function compartment(seq: number, title: string, body: string): CompartmentInput {
    return {
        sequence: seq,
        startMessage: seq,
        endMessage: seq,
        startMessageId: `m${seq}`,
        endMessageId: `m${seq}`,
        title,
        content: body,
        // p1 present → stored as v2 (legacy=0), so upgrade_state stays "ready"
        // and does not itself trigger a HARD bust.
        p1: body,
    };
}

// The stable provider-identity baseline. Holding these constant means no HARD
// signal fires, isolating the compartment/SOFT behavior under test.
const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

interface PassResult {
    m0: string;
    m1: string;
    rematerialized: boolean;
    reason: string | null;
    systemHashPrev: string | null;
    systemHashNew: string | null;
    m0ModelKeyPrev: string | null;
    m0ModelKeyNew: string | null;
}

function pass(opts: {
    projectDirectory: string;
    isCacheBustingPass: boolean;
    hard?: M0HardSignals;
    historyBudgetTokens?: number;
}): PassResult {
    // Mirror production: read fresh session_meta each pass (the persisted
    // region markers drive the decision), so byte-identity is proven through
    // the DB. Bust passes carry the production rotation-promotion lane
    // (transform-postprocess-phase): a stale region manifest at a boundary
    // turns the pass into the rotation transaction.
    const state = getOrCreateSessionMeta(db, SESSION_ID);
    const preExistingRegion = readSystemRegion(db, SESSION_ID) !== null;
    const priorModelKey = state.cachedM0ModelKey ?? null;
    const priorSystemHash = state.cachedM0SystemHash ?? null;
    const probe = mustMaterialize({
        db,
        sessionId: SESSION_ID,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: opts.projectDirectory,
        injectDocs: true,
        hardSignals: opts.hard ?? BASE_HARD,
        historyBudgetTokens: opts.historyBudgetTokens ?? 98_000,
        systemRegionMode: true,
    });
    // The production foldDueDecision gate: promotion runs only when the hard
    // comparison stayed silent.
    let forceMaterializeReason: string | undefined;
    if (opts.isCacheBustingPass && preExistingRegion && !probe.value) {
        const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
        const promotion = regionRotationPromotion({
            systemRegionLane: true,
            freezeM0M1: false,
            foldDue: false,
            boundaryPermission: true,
            forceBand: false,
            storedRegion: readSystemRegion(db, SESSION_ID),
            capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
            currentMarkers: currentRegionMarkersForPromotion({
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: PROJECT_PATH,
                projectDirectory: opts.projectDirectory,
                injectDocs: true,
                hardSignals: opts.hard ?? BASE_HARD,
                historyBudgetTokens: opts.historyBudgetTokens ?? 98_000,
            }),
        });
        if (promotion.promote && promotion.reason) forceMaterializeReason = promotion.reason;
    }
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: opts.projectDirectory,
        historyBudgetTokens: opts.historyBudgetTokens ?? 98_000,
        isCacheBustingPass: opts.isCacheBustingPass,
        hardSignals: opts.hard ?? BASE_HARD,
        systemRegion: { enabled: true, reason: "hard_fold" },
        forceMaterializeReason,
    });
    return {
        m0: result.m0Bytes ? result.m0Bytes.toString("utf8") : "",
        m1: result.m1Text ?? "",
        rematerialized: result.m0RematerializedThisPass,
        reason: result.decision.reason,
        systemHashPrev:
            result.decision.reason === "system_hash"
                ? (result.decision.systemHashPrev ?? priorSystemHash)
                : null,
        systemHashNew:
            result.decision.reason === "system_hash"
                ? (result.decision.systemHashNew ?? (opts.hard ?? BASE_HARD).systemHash)
                : null,
        m0ModelKeyPrev:
            result.decision.reason === "model_change"
                ? (result.decision.m0ModelKeyPrev ?? priorModelKey)
                : null,
        m0ModelKeyNew:
            result.decision.reason === "model_change"
                ? (result.decision.m0ModelKeyNew ?? (opts.hard ?? BASE_HARD).modelKey)
                : null,
    };
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("m[0]/m[1] materialization taxonomy", () => {
    it("SOFT+: a new compartment + defer passes replay m[0] AND m[1] byte-identical", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        // Baseline: compartment A folded into m[0] via first_render.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        expect(baseline.reason).toBe("first_render");

        // Publish compartment B (the routine historian publish).
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        // Defer passes: NOTHING re-renders. m[0] and m[1] are byte-identical to
        // the baseline — B does NOT leak in (it surfaces only on an exec pass).
        const d1 = pass({ projectDirectory, isCacheBustingPass: false });
        const d2 = pass({ projectDirectory, isCacheBustingPass: false });
        expect(d1.rematerialized).toBe(false);
        expect(d1.m0).toBe(baseline.m0);
        expect(d1.m1).toBe(baseline.m1);
        expect(d2.m0).toBe(baseline.m0);
        expect(d2.m1).toBe(baseline.m1);
        expect(d1.m1).not.toContain("Bravo delta");
    });

    it("SOFT (Unit 2 Task 3): a compartment delta on a bust pass does NOT rotate — the volatile carrier holds it", () => {
        // Region era, Unit 2: the DELTA_TRIGGER_FIELDS are emptied by owner
        // ruling. The compartment delta never originates and never rides a
        // rotation as a marker-comparison trigger: it is carried by the
        // volatile segment (sighting laws in region-volatile.test.ts) and
        // folds into the baseline only when a legitimate fold arrives — the
        // deferred fold-request consumer (postprocess family) or a HARD
        // signal. Here: the bust pass itself stays silent.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const baseline = pass({ projectDirectory, isCacheBustingPass: true });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        const soft = pass({ projectDirectory, isCacheBustingPass: true });
        // No rotation for a delta: the region bytes replay byte-identical and
        // no m[1] exists anywhere (the delta lane is the volatile segment).
        expect(soft.rematerialized).toBe(false);
        expect(soft.m1).toBe("");
        expect(soft.m0).toBe(baseline.m0);
        // The delta lands in the baseline at the next legitimate fold: the
        // HARD model-change arm below proves the same absorb-on-fold path
        // carries it.
        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
        });
        expect(hard.rematerialized).toBe(true);
        expect(hard.m0).toContain("Alpha baseline");
        expect(hard.m0).toContain("Bravo delta");
        // The rotation rode a HARD signal, not the delta: model identity moves.
        expect(hard.m0ModelKeyNew).toBe("anthropic/sonnet");
        const after = pass({ projectDirectory, isCacheBustingPass: false });
        expect(after.m0).toBe(hard.m0);
    });

    it("HARD (model change): rotates the region and adopts the new identity", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo delta")]);

        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "anthropic/sonnet" },
        });
        expect(hard.reason).toBe("model_change");
        expect(hard.m0ModelKeyPrev).toBe("anthropic/opus");
        expect(hard.m0ModelKeyNew).toBe("anthropic/sonnet");
        expect(hard.systemHashPrev).toBeNull();
        expect(hard.systemHashNew).toBeNull();
        expect(hard.rematerialized).toBe(true);
        // The one baseline carries both compartments; there is no m[1] lane.
        expect(hard.m0).toContain("Alpha baseline");
        expect(hard.m0).toContain("Bravo delta");
        expect(hard.m1).toBe("");
    });

    it("HARD (system hash change): re-materializes m[0]", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        const hard = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, systemHash: "sys-v2" },
        });
        expect(hard.reason).toBe("system_hash");
        expect(hard.systemHashPrev).toBe("sys-v1");
        expect(hard.systemHashNew).toBe("sys-v2");
        expect(hard.m0ModelKeyPrev).toBeNull();
        expect(hard.m0ModelKeyNew).toBeNull();
        expect(hard.rematerialized).toBe(true);
    });

    it("an EMPTY current HARD signal is never treated as a change (no spurious fold)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // Unknown signals this pass (e.g. before tool.definition fires) must NOT
        // fold — "" means "no signal", not "changed to empty".
        const unknown = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: {
                systemHash: "",
                modelKey: "",
                cacheExpired: false,
                lastResponseTime: 0,
            },
        });
        expect(unknown.rematerialized).toBe(false);
    });

    it("HARD (TTL idle): folds ONCE, then is idempotent across the multi-pass turn", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // Simulate "came back after idle": the m[0] baseline was materialized in
        // the past, and a response completed AFTER that baseline (lastResponseTime
        // > materializedAt). Both are real past timestamps so the post-fold
        // materializedAt (= now) exceeds lastResponseTime → idempotent.
        const tPast = Date.now() - 60 * 60 * 1000;
        db.prepare(
            "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
        ).run(tPast, SESSION_ID);
        const ttlHard: M0HardSignals = {
            ...BASE_HARD,
            cacheExpired: true,
            lastResponseTime: tPast + 1000,
        };

        const fold = pass({ projectDirectory, isCacheBustingPass: true, hard: ttlHard });
        expect(fold.reason).toBe("ttl_idle");
        expect(fold.rematerialized).toBe(true);

        // Same signals again within the turn: cacheExpired stays true, but the
        // fold advanced materializedAt to now, so lastResponseTime (past) is no
        // longer > materializedAt → no re-fold.
        const again = pass({ projectDirectory, isCacheBustingPass: true, hard: ttlHard });
        expect(again.rematerialized).toBe(false);
        expect(again.reason).not.toBe("ttl_idle");
    });

    it("consumer-contract: mustMaterialize respects cacheExpired=false (never-ttl lanes stay warm)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true });

        // "never" resolves to Infinity in parseCacheTtl, so hardCacheExpired is
        // always false. Verify mustMaterialize does NOT fire ttl_idle even when
        // lastResponseTime is ancient — the "never" lane stays warm.
        const tPast = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
        db.prepare(
            "UPDATE session_meta SET cached_m0_materialized_at = ? WHERE session_id = ?",
        ).run(tPast - 1000, SESSION_ID);
        const neverHard: M0HardSignals = {
            ...BASE_HARD,
            cacheExpired: false, // "never" → hardCacheExpired stays false
            lastResponseTime: tPast,
        };

        const result = pass({ projectDirectory, isCacheBustingPass: true, hard: neverHard });
        expect(result.reason).not.toBe("ttl_idle");
        expect(result.rematerialized).toBe(false);
    });

    it("pressure backstop (Unit 2 Task 3): an oversized region never folds for size — the request lane owns growth", () => {
        // §25.3 property: no size/pressure arm on the region fold decision —
        // growth is the volatile segment's authority, which REQUESTS a fold
        // (never re-renders region bytes on the requesting pass). On the
        // head lane this was the m[1]-cap refold; the region era has no such
        // arm. Both pass classes replay byte-identical.
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Ax")]);
        const smallBudget: M0HardSignals = BASE_HARD;
        const baseline = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: smallBudget,
            historyBudgetTokens: 60,
        });
        expect(baseline.reason).toBe("first_render");

        // Append several compartments → the region grows past 20% of the
        // 60-token budget.
        appendCompartments(db, SESSION_ID, [
            compartment(1, "B", "Bravo delta with enough words to consume tokens"),
            compartment(2, "C", "Charlie delta with more words again to consume more tokens"),
            compartment(3, "D", "Delta delta even more words here for tokens and tokens"),
        ]);
        const folded = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: smallBudget,
            historyBudgetTokens: 60,
        });
        // Task 3 (§25.3): there is NO size/pressure arm on the region — the
        // oversized region replays byte-identical even on this bust pass.
        // The growth authority moved to the volatile segment, which REQUESTS
        // a fold (sighting + consumer laws in region-volatile.test.ts and
        // the postprocess family); the region never folds for size.
        expect(folded.rematerialized).toBe(false);
        expect(folded.m1).toBe("");
        const replay = pass({
            projectDirectory,
            isCacheBustingPass: false,
            hard: smallBudget,
            historyBudgetTokens: 60,
        });
        expect(replay.m0).toBe(baseline.m0);
    });

    it("HARD markers persist across a simulated restart (DB read, not in-memory)", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        pass({ projectDirectory, isCacheBustingPass: true, hard: BASE_HARD });

        // Fresh state read from DB (mirrors a restart): the persisted markers must
        // match BASE_HARD so a same-identity pass does NOT spuriously fold.
        const restartState = getOrCreateSessionMeta(db, SESSION_ID);
        expect(restartState.cachedM0ModelKey).toBe("anthropic/opus");
        expect(restartState.cachedM0SystemHash).toBe("sys-v1");

        const noFold = pass({ projectDirectory, isCacheBustingPass: true, hard: BASE_HARD });
        expect(noFold.rematerialized).toBe(false);
    });
    it("does not hard-fold when the current model switches from canonical to Pi alias spelling", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        const canonical = { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" };
        pass({ projectDirectory, isCacheBustingPass: true, hard: canonical });

        const aliasOnly = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        expect(aliasOnly.rematerialized).toBe(false);
        expect(aliasOnly.reason).toBeNull();
    });

    it("persists a Pi-native baseline canonically, then accepts the reverse spelling flip", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        expect(getOrCreateSessionMeta(db, SESSION_ID).cachedM0ModelKey).toBe("openai/gpt-5.6-sol");
        const aliasOnly = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });

        expect(aliasOnly.rematerialized).toBe(false);
        expect(aliasOnly.reason).toBeNull();
    });

    it("does not hard-fold when an existing cached baseline stores a native alias", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });
        db.prepare("UPDATE session_meta SET cached_m0_model_key = ? WHERE session_id = ?").run(
            "openai-codex/gpt-5.6-sol",
            SESSION_ID,
        );

        const upgraded = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-sol" },
        });

        expect(upgraded.rematerialized).toBe(false);
        expect(upgraded.reason).toBeNull();
    });

    it("still hard-folds for different models in the same alias family", () => {
        db = makeDb();
        const projectDirectory = makeProjectDir();
        pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai-codex/gpt-5.6-sol" },
        });

        const realSwitch = pass({
            projectDirectory,
            isCacheBustingPass: true,
            hard: { ...BASE_HARD, modelKey: "openai/gpt-5.6-codex" },
        });

        expect(realSwitch.rematerialized).toBe(true);
        expect(realSwitch.reason).toBe("model_change");
    });
});

it("class-B protected_tokens edit remains boot-bound across a live-config defer pass", () => {
    const projectDirectory = makeProjectDir();
    const configHome = makeProjectDir();
    const oldHome = process.env.HOME;
    const oldConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.HOME = configHome;
    process.env.XDG_CONFIG_HOME = configHome;
    const configDir = join(configHome, "cortexkit");
    mkdirSync(configDir, { recursive: true });
    const configFile = join(configDir, "magic-context.jsonc");
    try {
        writeFileSync(
            configFile,
            JSON.stringify({
                protected_tokens: 16000,
                toast_duration_ms: 1500,
                historian: { opencode: { model: "old/model" } },
            }),
        );
        const load = () => loadPluginConfigDetailed(projectDirectory, false).config;
        const boot = load();
        const reader = new LiveConfigReader(projectDirectory, boot, load, () => {});
        reader.poll();
        db = makeDb();
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        const seeded = pass({ projectDirectory, isCacheBustingPass: true });
        writeFileSync(
            configFile,
            JSON.stringify({
                protected_tokens: 24000,
                toast_duration_ms: 2900,
                historian: { opencode: { model: "new/model-long" } },
            }),
        );
        const run = historianRunConfig(boot, reader.poll().effective);
        expect(run.protected_tokens).toBe(16000);
        expect(run.toast_duration_ms).toBe(2900);
        expect(resolveHistorianModel(run, "opencode").primary?.model).toBe("new/model-long");
        const deferred = pass({ projectDirectory, isCacheBustingPass: false });
        expect(deferred.m0).toBe(seeded.m0);
        expect(deferred.m1).toBe(seeded.m1);
        expect(deferred.rematerialized).toBe(false);
    } finally {
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
        if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = oldConfigHome;
    }
});
