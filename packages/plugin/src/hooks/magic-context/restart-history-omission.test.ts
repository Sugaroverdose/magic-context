/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

// Repro + regression guard for the "restart history omission" failure mode:
//
// A historian publish sets only IN-MEMORY deferred-refresh signals. If the
// process restarts before the next transform consumes them, and the first
// post-restart pass is a defer pass (below the execute threshold, within TTL),
// then:
//   - prepareCompartmentInjection rebuilds from DB with a COLD in-memory cache
//     and trims the live tail through the LATEST compartment boundary (incl. the
//     freshly published compartment B).
//   - injectM0M1, with isCacheBustingPass=false and no HARD trigger, replays the
//     STALE persisted cached_m1_bytes (which predates B).
// Net: B's raw messages are trimmed out AND B's summary is in neither m[0] nor
// m[1] → that slice of history silently disappears from what the model sees.
//
// The fix makes prepareCompartmentInjection cap its tail-trim at the compartment
// boundary the persisted m[1] actually covers when the m0/m1 path owns rendering
// and this is NOT a cache-busting pass — so a compartment newer than the cached
// m[1] keeps its raw messages in the tail until an exec pass folds it into m[1].

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import {
    clearInjectionCache,
    currentRegionMarkersForPromotion,
    injectM0M1,
    type M0HardSignals,
    type M0M1State,
    regionMarkersFromSnapshot,
    snapshotMarkersFromCachedM0,
} from "./inject-compartments";
import { readSystemRegion } from "../../features/magic-context/system-region";
import { regionRotationPromotion } from "./transform-postprocess-phase";
import type { MessageLike } from "./transform-operations";

const SESSION_ID = "ses_restart_omit";
const PROJECT_PATH = "/tmp/test-restart-omit-project";

let db: Database;
const tempDirs: string[] = [];

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

function makeProjectDir(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-restart-omit-"));
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
        p1: body,
    };
}

// Raw conversation messages with ids m0..mN matching the compartment boundaries.
function makeMessages(count: number): MessageLike[] {
    const out: MessageLike[] = [];
    for (let i = 0; i < count; i++) {
        out.push({
            info: { id: `m${i}`, role: i % 2 === 0 ? "user" : "assistant", sessionID: SESSION_ID },
            parts: [{ type: "text", text: `raw message ${i}` }],
        });
    }
    return out;
}

const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

function runProductionFlow(opts: {
    projectDirectory: string;
    isCacheBustingPass: boolean;
    messages: MessageLike[];
}): { m0: string; m1: string; tailIds: string[] } {
    // Region era (assembly-v2 Unit 1 Step 3): the head-era pair
    // (prepareCompartmentInjection + head-carrying injectM0M1) is one
    // off-wire fold. The fold's committed boundary trims the live array on
    // the bust lane; a defer pass replays the persisted boundary. History
    // summary bytes live inside the served region row, not on the array.
    const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
    // The production rotation-promotion lane (transform-postprocess-phase.ts):
    // a stale region manifest at a boundary turns the pass into the rotation
    // transaction. Defer passes carry no boundary permission and replay.
    let forceMaterializeReason: string | undefined;
    if (opts.isCacheBustingPass) {
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
            }),
        });
        if (promotion.promote && promotion.reason) forceMaterializeReason = promotion.reason;
    }
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        messages: opts.messages,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory: opts.projectDirectory,
        historyBudgetTokens: 98_000,
        isCacheBustingPass: opts.isCacheBustingPass,
        hardSignals: BASE_HARD,
        systemRegion: { enabled: true, reason: "hard_fold" },
        forceMaterializeReason,
    });
    const tailIds = opts.messages
        .map((m) => (typeof m.info.id === "string" ? m.info.id : ""));
    return {
        m0: result.m0Bytes ? result.m0Bytes.toString("utf8") : "",
        m1: result.m1Text ?? "",
        tailIds,
    };
}

beforeEach(() => {
    db = makeDb();
    clearInjectionCache(SESSION_ID);
});

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("restart history omission", () => {
    it("does NOT drop a compartment published just before a restart on the first defer pass", () => {
        const projectDirectory = makeProjectDir();

        // Baseline: compartment A covers m0; materialize m[0]/m[1] with A only.
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // Historian publishes compartment B covering m1 (raw messages m2+ remain
        // the live tail). In production this also sets in-memory deferred signals.
        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo just-published")]);

        // RESTART: the in-memory injection cache is lost and the process state
        // rehydrates from the persisted region row, whose captured markers
        // predate B (the region only advances on cache-busting rotations).
        clearInjectionCache(SESSION_ID);

        // First post-restart pass is a DEFER pass (below execute threshold): the
        // rehydrated deferred-history signal is NOT consumable here, so
        // isCacheBustingPass=false.
        const post = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });

        // The invariant: B must NOT silently vanish. Either its summary is present
        // (in m[1] or m[0]) OR its raw messages are still in the live tail. The
        // bug is when BOTH are false.
        const bInSummary =
            post.m1.includes("Bravo just-published") || post.m0.includes("Bravo just-published");
        // B's boundary is m1, so its raw slice is messages with id m1 (and the
        // tail m2+). If trimmed through B's boundary, m1 is gone from the tail.
        const bRawStillPresent = post.tailIds.includes("m1");

        expect(bInSummary || bRawStillPresent).toBe(true);

        // Specifically: on the cold defer pass, B is NOT yet in the summary
        // (m[1] replays stale), so its raw messages MUST be retained in the tail.
        expect(bInSummary).toBe(false);
        expect(bRawStillPresent).toBe(true);

        // And the NEXT exec (cache-busting) pass folds B into the region (the
        // head-era m[1] is retired: the summary serves inside system[0]) and
        // the tail trims forward — no permanent duplication.
        const exec = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });
        expect(exec.m0).toContain("Bravo just-published");
        expect(exec.tailIds).not.toContain("m1");
    });

    it("does NOT drop the first compartment when m[0] was materialized before any compartment existed (null persisted boundary)", () => {
        // Regression for the null-boundary hole in the restart-omission fix: the
        // cold-rebuild trim must distinguish "cached m[0] exists but boundary is
        // null" (m[0] materialized before any compartment → its m[1] covers NOTHING
        // → must NOT trim) from "no cached m[0] / legacy v1" (fall back to latest
        // boundary). Falling back to the latest boundary in the null case
        // reintroduces exactly the history loss the fix exists to prevent.
        const projectDirectory = makeProjectDir();

        // Materialize m[0]/m[1] with ZERO compartments → persisted baseline
        // boundary is null (lastCompartmentBoundaryId([]) === null).
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        // First compartment C publishes (covers m1). Persisted cached_m1_bytes
        // still predates C and the baseline boundary is still null.
        appendCompartments(db, SESSION_ID, [compartment(1, "C", "Charlie first-ever")]);

        // RESTART: cold in-memory cache.
        clearInjectionCache(SESSION_ID);

        // First post-restart DEFER pass.
        const post = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });

        const cInSummary =
            post.m1.includes("Charlie first-ever") || post.m0.includes("Charlie first-ever");
        const cRawStillPresent = post.tailIds.includes("m1");

        // Must not vanish: C's summary isn't in the stale m[1] yet, so its raw
        // messages MUST remain in the tail (the null-boundary no-trim path).
        expect(cInSummary).toBe(false);
        expect(cRawStillPresent).toBe(true);
    });

    it("failed prefix preparation preserves raw history both before and after cache clearing", () => {
        // Preparation no longer advances modern coverage before persistence.
        // A failed render therefore retains the newly published raw range even
        // before the failure handler clears the cache.
        const projectDirectory = makeProjectDir();

        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        runProductionFlow({
            projectDirectory,
            isCacheBustingPass: true,
            messages: makeMessages(6),
        });

        appendCompartments(db, SESSION_ID, [compartment(1, "B", "Bravo just-published")]);

        // Region era: the head-era "failed preparation" was a cold
        // prepareCompartmentInjection render that never persisted. The region
        // fold is all-or-nothing inside its transaction — a fold that fails
        // writes nothing — so the failure arm is a failed fold: the pass must
        // leave the persisted boundary (and the raw range it has not yet
        // covered) untouched.
        const beforeClear = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });
        expect(beforeClear.m1.includes("Bravo just-published")).toBe(false);
        expect(beforeClear.tailIds.includes("m1")).toBe(true);

        clearInjectionCache(SESSION_ID);
        const afterClear = runProductionFlow({
            projectDirectory,
            isCacheBustingPass: false,
            messages: makeMessages(6),
        });
        expect(afterClear.m1.includes("Bravo just-published")).toBe(false);
        expect(afterClear.tailIds.includes("m1")).toBe(true);
    });
});
