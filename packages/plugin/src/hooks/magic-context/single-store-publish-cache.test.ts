/// <reference types="bun-types" />
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";

// Cache rule for a fold the Rust module writes straight into context.db.
//
// A historian publish must never cause a cache bust by itself: its compartments reach
// m[1] on the next pass that is already busting, and m[0] folds them in only on a HARD
// bust. The host's own fold path (appendCompartments) holds that by leaving session_meta
// alone. The module's single-store writer does the same. Its visibility chunk replaces
// the session's compartments from the fold's first sequence upward and replaces the
// session facts, and it leaves the cached m[0]/m[1] untouched. That is the
// `replace_compartments_from_first_sequence` path in crates/mc-module/src/host_store.rs.
//
// `applyModuleVisibilityChunk` below issues the same statements that chunk issues. The
// Rust side separately pins that the real writer leaves session_meta byte-identical
// (single_store_pins.rs, a_republish_replaces_the_sessions_compartments_from_its_first_sequence).

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    appendCompartments,
    type CompartmentInput,
} from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { readSystemRegion } from "../../features/magic-context/system-region";
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
import { regionRotationPromotion } from "./transform-postprocess-phase";

const SESSION_ID = "ses_single_store_cache";
const PROJECT_PATH = "/tmp/test-single-store-cache-project";
const PUBLISH_MS = 1_700_000_000_000;

let db: Database;
const tempDirs: string[] = [];

const BASE_HARD: M0HardSignals = {
    systemHash: "sys-v1",
    modelKey: "anthropic/opus",
    cacheExpired: false,
    lastResponseTime: 0,
};

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

/** The statements of the module's visibility chunk, in its order. Touches no session_meta. */
function applyModuleVisibilityChunk(
    database: Database,
    sessionId: string,
    compartments: CompartmentInput[],
    facts: Array<{ category: string; content: string }>,
): void {
    database.transaction(() => {
        database.prepare("DELETE FROM session_facts WHERE session_id = ?").run(sessionId);
        for (const fact of facts) {
            database
                .prepare(
                    "INSERT INTO session_facts (session_id, category, content, created_at, updated_at, harness) VALUES (?, ?, ?, ?, ?, 'opencode')",
                )
                .run(sessionId, fact.category, fact.content, PUBLISH_MS, PUBLISH_MS);
        }
        const first = Math.min(...compartments.map((c) => c.sequence));
        database
            .prepare(
                "DELETE FROM compartment_events WHERE session_id = ? AND compartment_id IN (SELECT id FROM compartments WHERE session_id = ? AND sequence >= ?)",
            )
            .run(sessionId, sessionId, first);
        database
            .prepare("DELETE FROM compartments WHERE session_id = ? AND sequence >= ?")
            .run(sessionId, first);
        for (const c of compartments) {
            database
                .prepare(
                    "INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, p1, p2, p3, p4, importance, episode_type, legacy, created_at, harness) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 50, NULL, 0, ?, 'opencode')",
                )
                .run(
                    sessionId,
                    c.sequence,
                    c.startMessage,
                    c.endMessage,
                    c.startMessageId ?? "",
                    c.endMessageId ?? "",
                    c.title,
                    c.content,
                    c.p1 ?? null,
                    PUBLISH_MS,
                );
        }
    })();
}

function sha256(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function pass(projectDirectory: string, isCacheBustingPass: boolean) {
    const state = getOrCreateSessionMeta(db, SESSION_ID);
    let forceMaterializeReason: string | undefined;
    if (isCacheBustingPass) {
        // Region era: a published-history advance rides the rotation promotion
        // (the production composition, #2710/#2715/#2718) — the region successor
        // of the head-era exec-pass m[1] refresh. A bust without a promotion
        // reason is a plain replay.
        const foldDueArgs = {
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory,
            injectDocs: true,
        };
        const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
        const promotion = regionRotationPromotion({
            systemRegionLane: true,
            freezeM0M1: false,
            foldDue: false,
            boundaryPermission: true,
            forceBand: false,
            storedRegion: readSystemRegion(db, SESSION_ID),
            capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
            currentMarkers: currentRegionMarkersForPromotion(foldDueArgs),
        });
        if (promotion.promote) forceMaterializeReason = promotion.reason;
    }
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state,
        projectPath: PROJECT_PATH,
        projectDirectory,
        historyBudgetTokens: 98_000,
        isCacheBustingPass,
        hardSignals: BASE_HARD,
        systemRegionLane: true,
        forceMaterializeReason,
    });
    // Region era: the served prefix is the frozen system region plus nothing
    // else — the head carriage is retired, m[1] reconciles inside the region
    // at the next rotation.
    const region = readSystemRegion(db, SESSION_ID) ?? "";
    return {
        region,
        prefix: sha256(region),
        rematerialized: result.m0RematerializedThisPass,
    };
}

function sessionMetaCache(): unknown {
    return db
        .prepare(
            "SELECT quote(cached_m0_bytes) AS m0, quote(cached_m1_bytes) AS m1, cached_m0_system_hash AS sys, cached_m0_max_compartment_seq AS seq FROM session_meta WHERE session_id = ?",
        )
        .get(SESSION_ID);
}

afterEach(() => {
    if (db) db.close();
    clearInjectionCache(SESSION_ID);
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

describe("a fold written by the single-store module", () => {
    function setup(): string {
        db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, SESSION_ID);
        const dir = createTestTempDirFromPath(join(tmpdir(), "mc-single-store-cache-"));
        tempDirs.push(dir);
        appendCompartments(db, SESSION_ID, [compartment(0, "A", "Alpha baseline")]);
        return dir;
    }

    // Region era: the served prefix is the frozen region row. Capture it only
    // after the first install pass — a first pass legitimately rotates (it
    // installs), so the replay baseline is the state the row reaches after
    // that pass, not the absent row before it.
    function installedBaseline(projectDirectory: string): { region: string; prefix: string } {
        pass(projectDirectory, true);
        const region = readSystemRegion(db, SESSION_ID) ?? "";
        return { region, prefix: sha256(region) };
    }

    it("leaves the cached pair alone, so defer passes replay the served prefix byte-identically", () => {
        const projectDirectory = setup();
        const baseline = installedBaseline(projectDirectory);
        const cacheBefore = sessionMetaCache();

        applyModuleVisibilityChunk(
            db,
            SESSION_ID,
            [compartment(1, "B", "Bravo module fold")],
            [{ category: "Decisions", content: "keep the guards armed" }],
        );
        expect(sessionMetaCache()).toEqual(cacheBefore);

        const d1 = pass(projectDirectory, false);
        const d2 = pass(projectDirectory, false);
        expect(d1.rematerialized).toBe(false);
        expect(d1.prefix).toBe(baseline.prefix);
        expect(d2.prefix).toBe(baseline.prefix);
        expect(d1.region).not.toContain("Bravo module fold");
    });

    it("surfaces the fold's compartments in m[1] on the next busting pass, without touching m[0]", () => {
        const projectDirectory = setup();
        const baseline = installedBaseline(projectDirectory);

        applyModuleVisibilityChunk(
            db,
            SESSION_ID,
            [compartment(1, "B", "Bravo module fold")],
            [{ category: "Decisions", content: "keep the guards armed" }],
        );
        pass(projectDirectory, false);

        // Region era: the module publish reaches the wire on the next pass
        // that holds the boundary permission — the rotation promotion folds it
        // into the frozen region. A rotation rewrites the region by definition,
        // so the head-era "without touching m[0]" leg has no successor; the
        // publish-never-busts leg is the defer pair above.
        const busting = pass(projectDirectory, true);
        expect(busting.region).toContain("Bravo module fold");
        expect(busting.region).not.toBe(baseline.region);
        const stable = pass(projectDirectory, false);
        expect(stable.region).toBe(busting.region);
    });
});
