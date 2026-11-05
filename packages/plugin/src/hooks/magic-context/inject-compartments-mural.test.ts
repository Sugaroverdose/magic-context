/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
    buildMagicContextSection,
    MEMORY_MURAL_BLOCK,
    MEMORY_MURAL_GUIDANCE,
} from "../../agents/magic-context-prompt";
import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage-meta-session";
import { readSystemRegion } from "../../features/magic-context/system-region";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    buildRegionMuralMessage,
    currentRegionMarkersForPromotion,
    hasServableRegion,
    hydrateCachedM0Mural,
    injectM0M1,
    type M0M1State,
    prepareRegionReplay,
    regionMarkersFromSnapshot,
    renderM0,
    snapshotMarkersFromCachedM0,
    stripMemoryMuralBlock,
} from "./inject-compartments";
import type { MessageLike } from "./tag-messages";
import { createTransform } from "./transform";
import { regionRotationPromotion } from "./transform-postprocess-phase";

const SESSION_ID = "ses_mural_inject";
const PROJECT_ID = "git:mural-project";

function makeDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    return db;
}

// A 1x1 transparent PNG data URL, standing in for a rendered mural.
const FAKE_MURAL_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function muralOption(dataUrl = FAKE_MURAL_DATA_URL, contentHash = "mural-hash-1") {
    return {
        enabled: true,
        supportsVision: true,
        dataUrl,
        contentHash,
    };
}

/**
 * The transform tail's mural carriage (region era): the frozen region carries
 * the legend; the PNG rides beside it as a synthetic image message. The fold
 * runs through the production rotation composition — a stored region whose
 * manifest is stale rotates on a bust pass (the same gate the postprocess
 * phase applies: promotion only when the hard comparison stayed silent).
 */
function productionFoldPass(
    db: Database,
    sessionId: string,
    state: M0M1State,
    args: Parameters<typeof injectM0M1>[0] & {
        projectDirectory?: string;
        forceReason?: string;
    },
): ReturnType<typeof injectM0M1> {
    const preExistingRegion = readSystemRegion(db, sessionId) !== null;
    // Production always passes the feature flag alongside (transform.ts wires
    // muralEnabled = config.mural.enabled); an explicit `mural` option without
    // it would persist muralEnabled: false and the fold would skip the image.
    const argsWithFlag = {
        ...(args.mural !== undefined && args.muralEnabled === undefined
            ? { ...args, muralEnabled: args.mural.enabled && args.mural.supportsVision }
            : args),
        // The production region lane: the fold's rotation reason and the
        // promotion successor both key on the lane flag, and the head-era
        // cross-lane first_render discrimination stays retired only while it
        // is set (mustMaterialize region arms).
        systemRegionLane: true,
    };
    let forceMaterializeReason: string | undefined = argsWithFlag.forceReason;
    if (argsWithFlag.isCacheBustingPass && !preExistingRegion && !forceMaterializeReason) {
        // First fold: the region row does not exist yet — production's first
        // pass materializes via the first_render trigger; an explicit mural
        // option makes this the fold that bakes the image.
        forceMaterializeReason = "first_render";
    }
    if (argsWithFlag.isCacheBustingPass && preExistingRegion && !forceMaterializeReason) {
        const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
        const promotion = regionRotationPromotion({
            systemRegionLane: true,
            freezeM0M1: false,
            foldDue: false,
            boundaryPermission: true,
            forceBand: false,
            storedRegion: readSystemRegion(db, sessionId),
            capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
            currentMarkers: currentRegionMarkersForPromotion({
                ...argsWithFlag,
                db,
                sessionId,
                state,
                injectDocs: true,
            }),
        });
        if (promotion.promote && promotion.reason) forceMaterializeReason = promotion.reason;
    }
    const out = injectM0M1({ ...argsWithFlag, forceMaterializeReason });
    if (out.m0RematerializedThisPass) {
        // Mirror materializeM0's post-COMMIT state sync so later direct
        // injectM0M1 calls in a test carry the fresh manifest identity (the
        // production fold mutates the same object it was handed).
        const fresh = getOrCreateSessionMeta(db, sessionId) as unknown as M0M1State;
        Object.assign(state, fresh);
    }
    return out;
}

function carriageImage(db: Database, messages: MessageLike[]): string | undefined {
    // The transform tail's gate, verbatim: the carriage rides only beside a
    // servable region whose bytes carry the legend. The persisted mural
    // columns come from the region transaction, so the stored region is the
    // authority on whether the legend — and with it the image — ships.
    const regionText = readSystemRegion(db, SESSION_ID);
    if (regionText === null) return undefined;
    if (!regionText.includes("<memory-mural>")) return undefined;
    const hydrated = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
    if (!hydrated.cachedM0MuralDataUrl) {
        hydrated.cachedM0MuralDataUrl = null;
        hydrated.cachedM0MuralHash = null;
        hydrateCachedM0Mural(db, SESSION_ID, hydrated);
    }
    const muralMessage = buildRegionMuralMessage({
        muralDataUrl: hydrated.cachedM0MuralDataUrl,
        muralHash: hydrated.cachedM0MuralHash,
    });
    if (!muralMessage) return undefined;
    messages.unshift(muralMessage);
    return imageUrl(messages);
}

/** The transform's defer-pass lane: the frozen region replays byte-identical
 *  from the store (prepareRegionReplay), and the carriage rides beside it. */
function productionDeferPass(db: Database, messages: MessageLike[]): ReturnType<typeof injectM0M1> {
    const replay = prepareRegionReplay(db, SESSION_ID);
    if (replay) {
        // No carriage here: the mint is the transform tail (transform.ts
        // mural carriage beside the served region). Helpers that need the
        // image part call carriageImage explicitly.
        return replay;
    }
    throw new Error("no servable region to replay");
}

function imageUrl(messages: MessageLike[]): string | undefined {
    return (
        messages[0]?.parts.find((part) => (part as { type?: string }).type === "file") as
            | { url?: string }
            | undefined
    )?.url;
}

function replaceCurrentManifest(db: Database, content = "current mural"): string {
    const image = Buffer.from(content, "utf8");
    db.prepare(
        `INSERT OR REPLACE INTO mural_manifest
            (project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
         VALUES (?, ?, ?, ?, '[]', 1, 1)`,
    ).run(PROJECT_ID, image, "current-manifest-hash", Date.now());
    return `data:image/png;base64,${image.toString("base64")}`;
}

describe("m[0] mural image fold (on-demand render → wire)", () => {
    it("keeps the Rust mural block byte-equal and the system prompt unchanged", () => {
        const rust = readFileSync(
            new URL("../../../../../crates/mc-module/src/m0_compose.rs", import.meta.url),
            "utf8",
        );
        const literal = rust.match(/const MEMORY_MURAL_BLOCK: &str =\s*("[^;]+");/)![1]!;
        expect(JSON.parse(literal)).toBe(MEMORY_MURAL_BLOCK);
        expect(buildMagicContextSection(null, 0)).not.toContain(MEMORY_MURAL_GUIDANCE);
    });

    it("emits the legend only with an enabled vision image", () => {
        const base = {
            projectDocs: "",
            userProfileBaseline: [],
            compartments: [],
            memories: [],
            facts: [],
        };
        expect(renderM0({ ...base, mural: muralOption() })).toContain(MEMORY_MURAL_BLOCK);
        for (const mural of [
            undefined,
            { ...muralOption(), enabled: false },
            { ...muralOption(), supportsVision: false },
            { ...muralOption(), dataUrl: "" },
        ]) {
            expect(renderM0({ ...base, mural })).not.toContain(MEMORY_MURAL_GUIDANCE);
        }
        for (const block of [
            MEMORY_MURAL_BLOCK,
            "<memory-mural>\nThe project memory mural image follows.\n</memory-mural>",
        ]) {
            expect(stripMemoryMuralBlock(`before\n\n${block}\n\nafter`)).toBe("before\n\nafter");
        }
    });

    it("replays a pre-legend baseline unchanged until the next HARD fold", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const args = {
                db,
                sessionId: SESSION_ID,
                state,
                projectPath: undefined,
                mural: muralOption(),
                hardSignals: {
                    systemHash: "old",
                    modelKey: "anthropic/test-model",
                    cacheExpired: false,
                    lastResponseTime: 0,
                },
            };
            injectM0M1({ ...args, messages: [], isCacheBustingPass: true });
            const legacy = Buffer.from(
                state.cachedM0Bytes!.toString("utf8").replace(`${MEMORY_MURAL_GUIDANCE}\n`, ""),
            );
            db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
                legacy,
                SESSION_ID,
            );
            state.cachedM0Bytes = legacy;
            const deferred = injectM0M1({ ...args, messages: [], isCacheBustingPass: false });
            expect(deferred.m0RematerializedThisPass).toBe(false);
            expect(deferred.m0Bytes).toEqual(legacy);
            const folded = injectM0M1({
                ...args,
                hardSignals: { ...args.hardSignals, systemHash: "next" },
                messages: [],
                isCacheBustingPass: false,
            });
            expect(folded.m0RematerializedThisPass).toBe(true);
            expect(folded.m0Bytes?.toString("utf8")).toContain(MEMORY_MURAL_GUIDANCE);
        } finally {
            closeQuietly(db);
        }
    });
    it("folds the <memory-mural> block and image part when a mural is supplied, and replays it on defer", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;

            const hardMessages: MessageLike[] = [];
            const first = productionFoldPass(db, SESSION_ID, state, {
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                mural: muralOption(),
                forceReason: "hard_fold",
            });
            expect(first.injected).toBe(true);
            // The region carries the mural marker block.
            expect(first.m0Bytes?.toString("utf8")).toContain(MEMORY_MURAL_BLOCK);
            // The carriage rides beside the region as a synthetic image message.
            carriageImage(db, hardMessages);
            const head = hardMessages[0];
            const imagePart = head?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            ) as { type: string; mime?: string; url?: string } | undefined;
            expect(imagePart).toBeDefined();
            expect(imagePart?.mime).toBe("image/png");
            expect(imagePart?.url).toBe(FAKE_MURAL_DATA_URL);

            // A defer pass (no mural option supplied) must replay the SAME baked-in
            // data URL from the persisted region, not drop the image — the
            // "swaps only on a rotation" rule.
            const deferMessages: MessageLike[] = [];
            const second = productionDeferPass(db, deferMessages);
            expect(second.m0Bytes).toEqual(first.m0Bytes);
            carriageImage(db, deferMessages);
            const deferImage = deferMessages[0]?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            ) as { url?: string } | undefined;
            expect(deferImage?.url).toBe(FAKE_MURAL_DATA_URL);
        } finally {
            closeQuietly(db);
        }
    });

    it("lets a new mural ride the next natural HARD instead of triggering one", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const hardSignals = (systemHash: string) => ({
                systemHash,
                modelKey: "anthropic/test-model",
                cacheExpired: false,
                lastResponseTime: 0,
            });
            const firstMessages: MessageLike[] = [];
            const first = productionFoldPass(db, SESSION_ID, state, {
                db,
                sessionId: SESSION_ID,
                messages: firstMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                muralEnabled: true,
                mural: muralOption(FAKE_MURAL_DATA_URL, "mural-hash-a"),
                hardSignals: hardSignals("system-a"),
            });
            expect(first.m0RematerializedThisPass).toBe(true);

            const nextDataUrl = "data:image/png;base64,Yg==";
            const deferMessages: MessageLike[] = [];
            const deferred = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: false,
                muralEnabled: true,
                mural: muralOption(nextDataUrl, "mural-hash-b"),
                hardSignals: hardSignals("system-a"),
            });
            expect(deferred.decision).toEqual({ value: false, reason: null });
            expect(deferred.m0RematerializedThisPass).toBe(false);
            expect(deferred.m0Bytes).toEqual(first.m0Bytes);
            expect(carriageImage(db, deferMessages)).toBe(FAKE_MURAL_DATA_URL);
            expect(state.cachedM0MuralHash).toBe("mural-hash-a");

            const hardMessages: MessageLike[] = [];
            const folded = productionFoldPass(db, SESSION_ID, state, {
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state,
                projectPath: undefined,
                isCacheBustingPass: false,
                muralEnabled: true,
                mural: muralOption(nextDataUrl, "mural-hash-b"),
                hardSignals: hardSignals("system-b"),
            });
            expect(folded.decision).toMatchObject({ value: true, reason: "system_hash" });
            expect(folded.m0RematerializedThisPass).toBe(true);
            expect(carriageImage(db, hardMessages)).toBe(nextDataUrl);
            expect(state.cachedM0MuralHash).toBe("mural-hash-b");
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once when mural is disabled, removes the image, then defers byte-identically", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const firstMessages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: firstMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                muralEnabled: true,
                mural: muralOption(),
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(carriageImage(db, firstMessages)).toBe(FAKE_MURAL_DATA_URL);

            const disabledMessages: MessageLike[] = [];
            const disabled = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: disabledMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(disabled.decision).toEqual({
                value: true,
                reason: "render_config:mural(true→false)",
            });
            expect(disabled.m0RematerializedThisPass).toBe(true);
            expect(imageUrl(disabledMessages)).toBeUndefined();
            expect(disabled.m0Bytes?.toString("utf8")).not.toContain("<memory-mural>");
            expect(disabled.m0Bytes?.toString("utf8")).not.toContain(MEMORY_MURAL_GUIDANCE);

            const deferMessages: MessageLike[] = [];
            const defer = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: deferMessages,
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 8_000,
                historyBudgetTokens: 60_000,
            });
            expect(defer.m0RematerializedThisPass).toBe(false);
            expect(defer.m0Bytes).toEqual(disabled.m0Bytes);
            expect(carriageImage(db, deferMessages)).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });

    it("folds once when memory or history render budgets change", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_000,
                historyBudgetTokens: 2_000,
            });
            const changed = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_001,
                historyBudgetTokens: 2_000,
            });
            expect(changed.decision).toEqual({
                value: true,
                reason: "render_config:budget(m1000-h2000→m1001-h2000)",
            });
            expect(changed.m0RematerializedThisPass).toBe(true);

            const unchanged = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
                muralEnabled: false,
                memoryInjectionBudgetTokens: 1_001,
                historyBudgetTokens: 2_000,
            });
            expect(unchanged.m0RematerializedThisPass).toBe(false);
            expect(unchanged.m0Bytes).toEqual(changed.m0Bytes);
        } finally {
            closeQuietly(db);
        }
    });

    it("replays the persisted frozen image after restart instead of the current project manifest", () => {
        const db = makeDb();
        try {
            const hardState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const hardMessages: MessageLike[] = [];
            productionFoldPass(db, SESSION_ID, hardState, {
                db,
                sessionId: SESSION_ID,
                messages: hardMessages,
                state: hardState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
                forceReason: "hard_fold",
            });
            carriageImage(db, hardMessages);

            const currentManifestUrl = replaceCurrentManifest(db);
            const restartedState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            expect(restartedState.cachedM0MuralDataUrl).toBe(FAKE_MURAL_DATA_URL);
            expect(restartedState.cachedM0MuralHash).toBe("mural-hash-1");

            const deferMessages: MessageLike[] = [];
            productionDeferPass(db, deferMessages);
            carriageImage(db, deferMessages);
            const restartedCarriage = () => imageUrl(deferMessages);
            expect(restartedCarriage()).toBe(FAKE_MURAL_DATA_URL);
            expect(restartedCarriage()).not.toBe(currentManifestUrl);
            // Region era: the carriage is a pure function of the persisted
            // mural columns — the restarted defer ships the same image part.
            expect(deferMessages[0]?.parts[0]).toEqual(hardMessages[0]?.parts[0]);
        } finally {
            closeQuietly(db);
        }
    });

    it("hydrates a sibling cached-row mural payload during adoption", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });

            const siblingDataUrl = "data:image/png;base64,c2libGluZy1tdXJhbA==";
            db.prepare(
                `UPDATE session_meta
                    SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ?,
                        cached_m0_materialized_at = cached_m0_materialized_at + 1
                  WHERE session_id = ?`,
            ).run(siblingDataUrl, "sibling-hash", SESSION_ID);

            // Region era: the carriage reads the persisted mural columns on
            // every pass (the transform hydrates the state before each fold),
            // so a sibling's adoption write is what the NEXT pass serves —
            // no in-process adoption probe remains.
            const messages: MessageLike[] = [];
            expect(carriageImage(db, messages)).toBe(siblingDataUrl);
            const stateAfterHydration = getOrCreateSessionMeta(
                db,
                SESSION_ID,
            ) as unknown as M0M1State;
            expect(stateAfterHydration.cachedM0MuralDataUrl).toBe(siblingDataUrl);
            expect(stateAfterHydration.cachedM0MuralHash).toBe("sibling-hash");
        } finally {
            closeQuietly(db);
        }
    });

    it("falls back to internally consistent text-only m0 when a legacy row lacks the payload", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages: [],
                state,
                projectPath: PROJECT_ID,
                isCacheBustingPass: true,
                mural: muralOption(),
            });
            const currentManifestUrl = replaceCurrentManifest(db);
            db.prepare(
                `UPDATE session_meta
                    SET cached_m0_mural_data_url = NULL, cached_m0_mural_hash = NULL
                  WHERE session_id = ?`,
            ).run(SESSION_ID);

            const restartedState = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const messages: MessageLike[] = [];
            injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state: restartedState,
                projectPath: PROJECT_ID,
                isCacheBustingPass: false,
            });
            // The stored region keeps its legend (bytes freeze between
            // rotations); the payload columns are the image authority. With
            // the mural columns NULLed, no image may ride — and a real legacy
            // (non-sentinel) row is refused outright by the reader contract
            // (prepareRegionReplay → undefined → no region served, no carriage).
            const legacyCarriage = () => carriageImage(db, messages);
            expect(legacyCarriage()).toBeUndefined();
            expect(legacyCarriage()).not.toBe(currentManifestUrl);
            expect(messages).toHaveLength(0);
        } finally {
            closeQuietly(db);
        }
    });

    it("omits the mural block entirely when no mural is supplied and the feature is off", () => {
        const db = makeDb();
        try {
            const state = getOrCreateSessionMeta(db, SESSION_ID) as unknown as M0M1State;
            const messages: MessageLike[] = [];
            const result = injectM0M1({
                db,
                sessionId: SESSION_ID,
                messages,
                state,
                projectPath: undefined,
                isCacheBustingPass: true,
                // muralEnabled defaults undefined → no image path.
            });
            expect(result.m0Bytes?.toString("utf8")).not.toContain("<memory-mural>");
            const imagePart = messages[0]?.parts.find(
                (part) => (part as { type?: string }).type === "file",
            );
            expect(imagePart).toBeUndefined();
        } finally {
            closeQuietly(db);
        }
    });
});

/**
 * Production-composition laws for the mural carriage (#2710 class): these
 * drive the real createTransform tail, so any edit to the gate at
 * transform.ts (mural carriage group) reddens the shipped behavior, not a
 * mirror. The carriageImage helper above exists for the fold-side laws; it
 * copies the gate shape and can desync — these two cannot.
 */
describe("mural carriage at the production transform tail", () => {
    async function tailCarriageUrl(compactionOff: boolean): Promise<string | undefined> {
        const db = makeDb();
        try {
            // The production mural source: cue-pool memories under the
            // identity this transform resolves (memoryConfig.enabled →
            // resolveProjectIdentityForSession(cwd)); the fold's
            // resolveMuralForM0 → resolveMuralWire renders deterministically
            // from them. The vision probe is a catalog lookup, not part of
            // the gate under test — pinned true for a deterministic run.
            const { resolveProjectIdentityForSession } = await import(
                "../../features/magic-context/memory/project-identity"
            );
            const { insertMemory } = await import(
                "../../features/magic-context/memory/storage-memory"
            );
            const identity = resolveProjectIdentityForSession(process.cwd(), undefined);
            expect(identity).toBeTruthy();
            const { setMuralCue, computeCueContentHash } = await import(
                "../../features/magic-context/mural/storage-mural-cues"
            );
            for (let i = 0; i < 3; i++) {
                const content = `Tail law architecture fact ${i}: ${"pins the deterministic mural cue pool; ".repeat(60)}`;
                const memory = insertMemory(db, {
                    projectPath: identity as string,
                    category: "ARCHITECTURE",
                    content,
                });
                setMuralCue(
                    db,
                    identity as string,
                    memory.id,
                    `Tail law fact ${i}: ordered control flow, Unicode α preserved.`,
                    computeCueContentHash(content),
                );
            }
            const modelsCache = await import("../../shared/models-dev-cache");
            const visionSpy = (await import("bun:test"))
                .spyOn(modelsCache, "modelSupportsVision")
                .mockImplementation(() => true);
            const transform = createTransform({
                tagger: createTagger(),
                scheduler: { shouldExecute: () => false },
                contextUsageMap: new Map(),
                db,
                historyRefreshSessions: new Set<string>(),
                deferredHistoryRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set(),
                lastHeuristicsTurnId: new Map(),
                clearReasoningAge: 1000,
                protectedTokens: 0,
                historianRunnable: false,
                systemRegionLane: true,
                compactionOff,
                muralEnabled: true,
                memoryConfig: { enabled: true, injectionBudgetTokens: 120 },
                liveModelBySession: new Map([
                    [SESSION_ID, { providerID: "anthropic", modelID: "claude-opus-5" }],
                ]),
            } as never);
            // Pass 1 prices the fold (first_render); pass 2 is the steady
            // defer replay — the carriage must ride beside the replayed region.
            let out: MessageLike[] | undefined;
            try {
                for (let pass = 0; pass < 2; pass++) {
                    const output = {
                        messages: [
                            {
                                info: { id: "tail-user", role: "user", sessionID: SESSION_ID },
                                parts: [{ type: "text", text: "hello" }],
                            },
                        ],
                    } as never;
                    await transform({}, output);
                    out = (output as { messages: unknown[] }).messages as MessageLike[];
                }
            } finally {
                visionSpy.mockRestore();
            }
            expect(readSystemRegion(db, SESSION_ID)).toContain("<memory-mural>");
            // The carriage is the persisted column verbatim — the gate's own
            // invariant (pure function of the rotation markers).
            const persisted = getOrCreateSessionMeta(db, SESSION_ID).cachedM0MuralDataUrl;
            expect(persisted).toBeTruthy();
            const emitted = imageUrl(out ?? []);
            expect(emitted).toBe(persisted);
            return emitted;
        } finally {
            closeQuietly(db);
        }
    }

    it("the transform tail emits the PNG beside the servable region (compaction-on)", async () => {
        expect(await tailCarriageUrl(false)).toStartWith("data:image/png;base64,");
    });

    it("the transform tail emits the PNG for a compaction-off install too (no stranded legend)", async () => {
        // Owner ruling (assembly-v2, binary authority): compaction-off rides
        // the region with no serve carve-out. The legend ships inside the
        // region bytes for an off install regardless of this gate, so an
        // off-mode gate that skips the image strands legend-without-image.
        expect(await tailCarriageUrl(true)).toStartWith("data:image/png;base64,");
    });
});
