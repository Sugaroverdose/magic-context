/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    hasCompleteCachedM0M1,
    injectM0M1,
    type M0M1State,
    mustMaterialize,
    prepareCachedM0M1Replay,
} from "./inject-compartments";
import {
    type RegionMarkers,
    readSystemRegion,
    SYSTEM_REGION_SENTINEL,
    writeSystemRegion,
} from "../../features/magic-context/system-region";
import type { MessageLike } from "./tag-messages";
import { regionRotationPromotion } from "./transform-postprocess-phase";

const SESSION_ID = "ses_region_wiring";
const PROJECT_PATH = "/tmp/test-region-wiring";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    insertMemory(db, {
        projectPath: PROJECT_PATH,
        category: "ARCHITECTURE",
        content: "wiring law memory",
    });
    return db;
}

function row(db: Database) {
    return db
        .prepare("SELECT cached_m0_bytes, cached_m1_bytes FROM session_meta WHERE session_id = ?")
        .get(SESSION_ID) as {
        cached_m0_bytes: Uint8Array | null;
        cached_m1_bytes: Uint8Array | null;
    };
}

function freshState(db: Database): M0M1State {
    const meta = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
    return meta;
}

function foldOptions(db: Database, messages: MessageLike[], regionEnabled: boolean) {
    return {
        db,
        sessionId: SESSION_ID,
        state: freshState(db),
        projectPath: PROJECT_PATH,
        projectDirectory: "",
        messages,
        isCacheBustingPass: true,
        systemRegion: regionEnabled ? { enabled: true, reason: "hard_fold" } : undefined,
    } as never;
}

describe("system-region wiring: gate on collapses the head lane", () => {
    it("first fold installs the region and prepends zero head messages", () => {
        const db = makeDb();
        const messages: MessageLike[] = [
            { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages, true));
        expect(result.prependedMessageCount).toBe(0);
        expect(messages.length).toBe(1);
        expect(messages[0].info.id).toBe("u1");
        const stored = row(db);
        expect(
            Buffer.from(stored.cached_m0_bytes!)
                .toString("utf8")
                .startsWith(SYSTEM_REGION_SENTINEL),
        ).toBe(true);
        expect(stored.cached_m1_bytes).toBeNull();
        expect(readSystemRegion(db, SESSION_ID)).toContain("wiring law memory");
    });

    it("second gated pass replays: no fold, no head, m1 stays null, no new region bytes", () => {
        const db = makeDb();
        injectM0M1(foldOptions(db, [], true));
        const before = row(db);
        const messages: MessageLike[] = [
            { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "next" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages, true));
        expect(result.prependedMessageCount).toBe(0);
        expect(result.m0RematerializedThisPass).toBe(false);
        expect(messages.length).toBe(1);
        const after = row(db);
        expect(Buffer.from(after.cached_m0_bytes!)).toEqual(Buffer.from(before.cached_m0_bytes!));
        expect(after.cached_m1_bytes).toBeNull();
    });

    it("gate off control: the head lane still prepends its two synthetic messages", () => {
        const db = makeDb();
        const messages: MessageLike[] = [
            { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages, false));
        expect(result.prependedMessageCount).toBe(2);
        expect(messages.length).toBe(3);
        expect(messages[0].info.role).toBe("user");
        expect((messages[0].info as { syntheticHead?: boolean }).syntheticHead).toBe(true);
        expect(Buffer.from(row(db).cached_m0_bytes!).toString("utf8")).not.toContain(
            SYSTEM_REGION_SENTINEL,
        );
    });
});

describe("system-region wiring: mustMaterialize arms in region mode", () => {
    it("a legacy raw row demands the region_first_install fold", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = ? WHERE session_id = ?",
        ).run(
            Buffer.from("<session-history>legacy</session-history>", "utf8"),
            Buffer.from("<m1/>", "utf8"),
            SESSION_ID,
        );
        const state = freshState(db);
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        expect(decision.value).toBe(true);
        expect(decision.reason).toBe("region_first_install");
    });

    it("a valid region row with a null m1 never re-triggers cached_m1_missing", () => {
        const db = makeDb();
        writeSystemRegion(db, SESSION_ID, "<project-memory>frozen</project-memory>");
        const state = freshState(db);
        state.cachedM1Bytes = null;
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        expect(decision.reason).not.toBe("cached_m1_missing");
    });

    it("without region mode the m1-missing arm keeps its bite (control)", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(Buffer.from("<session-history>head</session-history>", "utf8"), SESSION_ID);
        const state = freshState(db);
        state.cachedM1Bytes = null;
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });
        expect(decision.value).toBe(true);
        expect(decision.reason).toBe("cached_m1_missing");
    });
});

describe("system-region wiring: rotation promotion (L3/L4)", () => {
    const captured: RegionMarkers = {
        projectMemoryEpoch: 1,
        maxCompartmentSeq: 7,
        maxMemoryId: 12,
        maxMutationId: 3,
        maxMemoryMutationId: 0,
        projectDocsHash: "hash-a",
        upgradeState: "up",
        compartmentRenderEpoch: "2",
        muralEnabled: false,
        renderBudgetIdentity: "rb",
        memoryRenderEpoch: "1",
        renderedBudgets: null,
        profileVersion: 4,
    };
    const live = (over: Partial<RegionMarkers>): RegionMarkers => ({ ...captured, ...over });
    const base = {
        systemRegionEnabled: true,
        compactionOff: false,
        freezeM0M1: false,
        foldDue: false,
        boundaryPermission: true,
        forceBand: false,
        storedRegion: "<!-- mc:system-region v1 -->panel bytes",
        capturedMarkers: captured,
        currentMarkers: live({}),
        historyBudgetTokens: 40000,
    };

    it("stale manifest on a boundary pass promotes the fold into a rotation", () => {
        expect(
            regionRotationPromotion({ ...base, currentMarkers: live({ projectMemoryEpoch: 2 }) }),
        ).toEqual({ promote: true, reason: "project_memory_epoch" });
        // m[1]-delta fields promote on the boundary: region mode has no m[1],
        // so these are the fields whose change re-rendered m[1] on bust passes.
        expect(
            regionRotationPromotion({ ...base, currentMarkers: live({ maxMemoryId: 13 }) }),
        ).toEqual({ promote: true, reason: "max_memory_id" });
        // Without the boundary they never promote (ride-only, L4).
        expect(
            regionRotationPromotion({
                ...base,
                boundaryPermission: false,
                currentMarkers: live({ maxMemoryId: 13 }),
            }),
        ).toEqual({ promote: false, reason: null });
    });

    it("no boundary permission: a stale manifest never promotes (ride-only)", () => {
        expect(
            regionRotationPromotion({
                ...base,
                boundaryPermission: false,
                currentMarkers: live({ projectMemoryEpoch: 2 }),
            }),
        ).toEqual({ promote: false, reason: null });
    });

    it("fresh manifest on a warm boundary pass never promotes (never originates a bust)", () => {
        expect(regionRotationPromotion(base)).toEqual({ promote: false, reason: null });
    });

    it("a fold already due is left to mustMaterialize (no double decision)", () => {
        expect(
            regionRotationPromotion({
                ...base,
                foldDue: true,
                currentMarkers: live({ projectMemoryEpoch: 2 }),
            }),
        ).toEqual({ promote: false, reason: null });
    });

    it("an absent region is installed by the fold path, not promoted here", () => {
        expect(regionRotationPromotion({ ...base, storedRegion: null })).toEqual({
            promote: false,
            reason: null,
        });
    });

    it("compaction-off and freezeM0M1 decline even with a stale manifest", () => {
        const stale = { ...base, currentMarkers: live({ projectMemoryEpoch: 2 }) };
        expect(regionRotationPromotion({ ...stale, compactionOff: true })).toEqual({
            promote: false,
            reason: null,
        });
        expect(regionRotationPromotion({ ...stale, freezeM0M1: true })).toEqual({
            promote: false,
            reason: null,
        });
        expect(regionRotationPromotion({ ...stale, systemRegionEnabled: false })).toEqual({
            promote: false,
            reason: null,
        });
    });

    it("force band re-tiers an aged region even with a fresh manifest", () => {
        expect(regionRotationPromotion({ ...base, forceBand: true })).toEqual({
            promote: true,
            reason: "force_band",
        });
    });

    it("region bytes past the growth cap promote on the boundary", () => {
        const big = {
            ...base,
            storedRegion: `<b>${"x".repeat(200_000)}</b>`,
            historyBudgetTokens: 40000,
        };
        expect(regionRotationPromotion(big).promote).toBe(true);
        // Inert control: a region under the cap with fresh markers does not.
        expect(regionRotationPromotion(base).promote).toBe(false);
    });
});

describe("system-region wiring: replay plumbing is sentinel-aware", () => {
    it("a sentinel row counts as a complete cached prefix and replays without heads", () => {
        const db = makeDb();
        writeSystemRegion(db, SESSION_ID, "<project-memory>frozen</project-memory>");
        expect(hasCompleteCachedM0M1(db, SESSION_ID)).toBe(true);
        const replay = prepareCachedM0M1Replay(db, SESSION_ID);
        expect(replay).toBeDefined();
        expect(replay!.preparedMessages.length).toBe(0);
    });

    it("control: a raw m0 row with null m1 is not complete", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(Buffer.from("<session-history>head</session-history>", "utf8"), SESSION_ID);
        expect(hasCompleteCachedM0M1(db, SESSION_ID)).toBe(false);
        expect(prepareCachedM0M1Replay(db, SESSION_ID)).toBeUndefined();
    });
});
