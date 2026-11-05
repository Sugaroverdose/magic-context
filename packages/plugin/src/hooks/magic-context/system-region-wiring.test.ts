/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSystemRegionLane } from "../../config/system-region-lane";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { bumpProjectUserProfileVersion } from "../../features/magic-context/storage-project-state";
import {
    decideSystemRegionRotation,
    type RegionMarkers,
    readSystemRegion,
    SYSTEM_REGION_SENTINEL,
    writeSystemRegion,
} from "../../features/magic-context/system-region";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    currentRegionMarkersForPromotion,
    hasServableRegion,
    injectM0M1,
    type M0M1State,
    mustMaterialize,
    prepareRegionReplay,
    regionMarkersFromSnapshot,
    snapshotMarkersFromCachedM0,
} from "./inject-compartments";
import type { MessageLike } from "./tag-messages";
import { regionRotationPromotion } from "./transform-postprocess-phase";

const SRC_PLUGIN = join(import.meta.dir, "..", "..");

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

function foldOptions(db: Database, messages: MessageLike[]) {
    return {
        db,
        sessionId: SESSION_ID,
        state: freshState(db),
        projectPath: PROJECT_PATH,
        projectDirectory: "",
        messages,
        isCacheBustingPass: true,
        systemRegion: { enabled: true, reason: "hard_fold" },
    } as never;
}

describe("system-region wiring: gate on collapses the head lane", () => {
    it("first fold installs the region and prepends zero head messages", () => {
        const db = makeDb();
        const messages: MessageLike[] = [
            { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages));
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
        injectM0M1(foldOptions(db, []));
        const before = row(db);
        const messages: MessageLike[] = [
            { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "next" }] },
        ];
        const result = injectM0M1(foldOptions(db, messages));
        expect(result.prependedMessageCount).toBe(0);
        expect(result.m0RematerializedThisPass).toBe(false);
        expect(messages.length).toBe(1);
        const after = row(db);
        expect(Buffer.from(after.cached_m0_bytes!)).toEqual(Buffer.from(before.cached_m0_bytes!));
        expect(after.cached_m1_bytes).toBeNull();
    });

    it("headless carriage: even with the capability operand omitted, the fold installs a region and splices no heads", () => {
        // The head lane is deleted (assembly-v2 Unit 1 Step 3): there is no
        // invocation of injectM0M1 that prepends synthetic messages, even a
        // caller that omits systemRegion entirely (posture: lane constant true,
        // step 4). The fold falls back to the hard_fold reason.
        const db = makeDb();
        const messages: MessageLike[] = [
            { info: { id: "u3", role: "user" }, parts: [{ type: "text", text: "hi" }] },
        ];
        const options = foldOptions(db, messages) as { systemRegion?: unknown };
        delete options.systemRegion;
        const result = injectM0M1(options as never);
        expect(result.prependedMessageCount).toBe(0);
        expect(messages.length).toBe(1);
        expect(messages[0].info.id).toBe("u3");
        expect(Buffer.from(row(db).cached_m0_bytes!).toString("utf8")).toContain(
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

    it("the legacy regionMode=false reading behaves identically: no cached_m1_missing arm exists (control)", () => {
        // Unit 1 Step 3 deleted the head-lane arm and its discrimination; a
        // poison row folds on every reader, and a null m[1] is never a trigger.
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
        expect(decision.reason).toBe("region_first_install");
        const healthy = makeDb();
        writeSystemRegion(healthy, SESSION_ID, "<project-memory>frozen</project-memory>");
        const healthyState = freshState(healthy);
        healthyState.cachedM1Bytes = null;
        const none = mustMaterialize({
            db: healthy,
            sessionId: SESSION_ID,
            state: healthyState,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });
        expect(none.reason).not.toBe("cached_m1_missing");
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
        systemRegionLane: true,
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
        // Unit 2 Task 3 demotion: the delta-class fields never promote, even
        // with the boundary permission — they ride the volatile segment
        // (per-field live-writer laws in the demotion block below).
        expect(
            regionRotationPromotion({ ...base, currentMarkers: live({ maxMemoryId: 13 }) }),
        ).toEqual({ promote: false, reason: null });
        // Without the boundary, content triggers never promote either (ride-only, L4).
        expect(
            regionRotationPromotion({
                ...base,
                boundaryPermission: false,
                currentMarkers: live({ projectMemoryEpoch: 2 }),
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

    it("an inert capability lane and freezeM0M1 decline even with a stale manifest", () => {
        // Inert-CAPABILITY control (the flag's inert-gate control, re-pointed):
        // the boot predicate yields lane=false for rust/compaction-off installs
        // (table laws below); the promotion must go fully dead on that.
        const stale = { ...base, currentMarkers: live({ projectMemoryEpoch: 2 }) };
        expect(regionRotationPromotion({ ...stale, systemRegionLane: false })).toEqual({
            promote: false,
            reason: null,
        });
        expect(regionRotationPromotion({ ...stale, freezeM0M1: true })).toEqual({
            promote: false,
            reason: null,
        });
        expect(regionRotationPromotion({ ...stale, systemRegionLane: false })).toEqual({
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

    it("region bytes past any cap never promote — promotion is marker/force-band only (Fix C, §25.3)", () => {
        // Obsoleted arm law rewritten to its inverse: the old size arm
        // promoted here; the deleted pending_growth class must stay dead,
        // including as a reintroduced parameter (historyBudgetTokens is no
        // longer even an input of the wrapper — the cap had one consumer).
        const big = { ...base, storedRegion: `<b>${"x".repeat(200_000)}</b>` };
        expect(regionRotationPromotion(big)).toEqual({ promote: false, reason: null });
        // Marker movement still promotes on the same oversized region.
        expect(
            regionRotationPromotion({
                ...big,
                currentMarkers: live({ projectMemoryEpoch: 2 }),
            }),
        ).toEqual({ promote: true, reason: "project_memory_epoch" });
    });
});

describe("system-region wiring: replay plumbing is sentinel-aware", () => {
    it("a sentinel row counts as a servable region and replays without heads", () => {
        const db = makeDb();
        writeSystemRegion(db, SESSION_ID, "<project-memory>frozen</project-memory>");
        expect(hasServableRegion(db, SESSION_ID)).toBe(true);
        const replay = prepareRegionReplay(db, SESSION_ID);
        expect(replay).toBeDefined();
        expect(replay!.preparedMessages.length).toBe(0);
    });

    it("control: a raw head row is never servable", () => {
        const db = makeDb();
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(Buffer.from("<session-history>head</session-history>", "utf8"), SESSION_ID);
        expect(hasServableRegion(db, SESSION_ID)).toBe(false);
        expect(prepareRegionReplay(db, SESSION_ID)).toBeUndefined();
    });
});

// Reader contract (#2637), headless era: the region reader refuses everything
// it cannot serve. A legacy head row — any bytes without the sentinel — is
// first_render (empty region), never served as region text; a sentinel-prefixed
// row that fails decode (corrupt/forged) is refused too.
describe("system-region wiring: reader discrimination over stored rows", () => {
    function seedRow(sessionId: string, bytes: Uint8Array) {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(bytes, sessionId);
        return db;
    }

    it("a legacy head row is first_render and never servable", async () => {
        const { mustMaterialize, prepareRegionReplay, hasServableRegion } = await import(
            "./inject-compartments"
        );
        const db = seedRow(
            "ses-c2-headrow",
            Buffer.from("<session-history>legacy</session-history>", "utf8"),
        );
        const state = getOrCreateSessionMeta(db, "ses-c2-headrow");
        expect(
            mustMaterialize({
                db,
                sessionId: "ses-c2-headrow",
                state,
                projectPath: "/p",
                projectDirectory: "",
                systemRegionMode: true,
            } as never).reason,
        ).toBe("region_first_install");
        expect(prepareRegionReplay(db, "ses-c2-headrow")).toBeUndefined();
        expect(hasServableRegion(db, "ses-c2-headrow")).toBe(false);
    });

    it("a sentinel row is servable whole", async () => {
        const { prepareRegionReplay, hasServableRegion } = await import("./inject-compartments");
        const db = seedRow(
            "ses-c2-regionrow",
            Buffer.from(
                `<!-- mc:system-region v1 -->\n<project-memory>foreign</project-memory>`,
                "utf8",
            ),
        );
        expect(prepareRegionReplay(db, "ses-c2-regionrow")).toBeDefined();
        expect(hasServableRegion(db, "ses-c2-regionrow")).toBe(true);
    });
});

describe("prepareRegionReplay truth table (lint-refactor pin)", () => {
    it("head rows are never served; region rows never read the m1 slot", () => {
        const db = makeDb();
        expect(prepareRegionReplay(db, SESSION_ID)).toBeUndefined(); // no row
        db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
            Buffer.from("<session-history>head</session-history>", "utf8"),
            SESSION_ID,
        );
        // Legacy head m0 with a full m1 companion: still refused (head rows
        // are not region bytes; the reader contract treats them as absent).
        db.prepare("UPDATE session_meta SET cached_m1_bytes = ? WHERE session_id = ?").run(
            Buffer.from("<session-history-since>d</session-history-since>", "utf8"),
            SESSION_ID,
        );
        expect(prepareRegionReplay(db, SESSION_ID)).toBeUndefined();
        // Region row: serves, m1 text is the empty placeholder, never stored bytes.
        writeSystemRegion(db, SESSION_ID, "<project-memory>r</project-memory>");
        const regionPass = prepareRegionReplay(db, SESSION_ID);
        expect(regionPass?.injected).toBe(true);
        expect(regionPass?.m1Text).toBe("");
    });
});

// Owner ruling (2026-11-03): the system_region.enabled flag is DEAD — no
// config switch; the region lane is an install-time capability, and
// recovery is rollback (spec flip), never a config flip. One exported
// decider, computed once per handler boot from transformMode + compaction
// (L0 spirit: one decider, threaded — no per-site re-derivation).
describe("system-region capability lane (flag deletion)", () => {
    // Unit 1 Step 4 (plan:20): the predicate is a pure constant. The rust and
    // compaction-off rows retired here asked the lane to refuse service; the
    // rust refusal moved upstream to the config-resolution funnel
    // (transform-mode.ts named boot refusal) and compaction-off rides the
    // region (binary-authority ruling). system-region-lane-law.test.ts pins
    // the pure-constant structure; this table pins call-site stability.
    const TABLE: Array<{
        name: string;
        config: { transform_mode?: "ts" | "rust"; compaction?: { enabled?: boolean } | false };
        want: boolean;
    }> = [
        { name: "ts + compaction on (defaults)", config: {}, want: true },
        {
            name: "ts explicit + compaction on",
            config: { transform_mode: "ts", compaction: { enabled: true } },
            want: true,
        },
        { name: "compaction off (legacy false)", config: { compaction: false }, want: true },
        {
            name: "compaction off (object)",
            config: { compaction: { enabled: false } },
            want: true,
        },
    ];
    for (const row of TABLE) {
        it(`isSystemRegionLane: ${row.name} -> ${row.want}`, () => {
            expect(isSystemRegionLane(row.config)).toBe(row.want);
        });
    }

    // N1 (round 10): the census guards a DEAD key, so its survivability IS
    // the guard. Denied shapes: property access (`.system_region`) and
    // bracket access (`["system_region"]` / `['system_region']`) — neither
    // matches the predicate module's rationale comment (no leading dot, no
    // bracket+quote). Roots follow the repo's own F1/#2665 eraser-census
    // standard: every production tree that could read config, in any
    // language touching the shared store. No wholesale directory exemptions;
    // a sanctioned reader needs a named member (list is empty by design —
    // the key is deleted).
    const FLAG_READ = /\.system_region\b|\[['"]system_region['"]\]|\[`system_region`\]/;
    const PKG = join(SRC_PLUGIN, "..", "..");
    const CENSUS_TS_ROOTS: Array<[string, string]> = [
        [SRC_PLUGIN, "plugin/"],
        [join(PKG, "pi-plugin", "src"), "pi/"],
        [join(PKG, "cli", "src"), "cli/"],
        [join(SRC_PLUGIN, "..", "scripts"), "plugin-scripts/"],
        [join(PKG, "dashboard", "src"), "dashboard/"],
        [join(PKG, "pi-plugin", "scripts"), "pi-scripts/"],
    ];
    const CENSUS_RS_ROOTS = [join(PKG, "..", "crates"), join(PKG, "dashboard", "src-tauri", "src")];
    // Named exemptions for sanctioned readers: none. Add a member only with
    // a written justification, like the eraser census requires.
    const ALLOWED_READERS = new Set<string>();
    function walkProdAll(
        dir: string,
        prefix: string,
        exts: string[],
    ): Array<{ rel: string; full: string }> {
        const out: Array<{ rel: string; full: string }> = [];
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                if (entry === "node_modules" || entry === "target") continue;
                out.push(...walkProdAll(full, `${prefix}${entry}/`, exts));
            } else if (exts.some((ext) => entry.endsWith(ext)) && !entry.endsWith(".test.ts")) {
                out.push({ rel: `${prefix}${entry}`, full });
            }
        }
        return out;
    }
    function censusOffenders(): string[] {
        const offenders: string[] = [];
        const files = [
            ...CENSUS_TS_ROOTS.flatMap(([root, prefix]) =>
                walkProdAll(root, prefix, [".ts", ".tsx", ".mjs", ".cjs"]),
            ),
            ...CENSUS_RS_ROOTS.flatMap((root) =>
                statSync(root).isDirectory()
                    ? walkProdAll(root, "rs/", [".rs"]).filter((f) => !f.full.endsWith("_tests.rs"))
                    : [],
            ),
        ];
        for (const { rel, full } of files) {
            if (ALLOWED_READERS.has(rel)) continue;
            if (FLAG_READ.test(readFileSync(full, "utf8"))) offenders.push(rel);
        }
        return offenders;
    }

    it("no production file reads the deleted config key (dot + bracket, full roots)", () => {
        expect(censusOffenders()).toEqual([]);
    });

    it("planted-rogue control: each denied shape inside a covered root reddens the census", () => {
        const plants: Array<{ name: string; body: string; dir?: string }> = [
            {
                name: "dot-access rogue (plugin/src)",
                body: "export const v = (c: { system_region?: unknown }) => c.system_region;\n",
            },
            {
                name: "bracket-access rogue (plugin/src)",
                body: 'export const v = (c: Record<string, unknown>) => c["system_region"];\n',
            },
            {
                name: "backtick-bracket rogue (plugin/src)",
                body: "export const v = (c: Record<string, unknown>) => c[`system_region`];\n",
            },
            {
                name: "bracket-access rogue (pi-plugin/scripts)",
                body: 'export const v = (c: Record<string, unknown>) => c["system_region"];\n',
                dir: join(PKG, "pi-plugin", "scripts"),
            },
        ];
        for (const plant of plants) {
            const kind = plant.name.startsWith("dot")
                ? "dot"
                : plant.name.startsWith("backtick")
                  ? "backtick"
                  : "bracket";
            const target = join(plant.dir ?? SRC_PLUGIN, `__census-rogue-${kind}.ts`);
            writeFileSync(target, plant.body);
            try {
                const found = censusOffenders();
                expect(found.some((o) => o.includes("__census-rogue-"))).toBe(true);
            } finally {
                rmSync(target, { force: true });
            }
        }
        // Removed plants must not leave residue reddening the steady law.
        expect(censusOffenders()).toEqual([]);
    });
});

// Storm defect (field-verified, §25): the promotion comparator compared the
// captured side (real persisted docs hash, written by the fold at
// materializeM0's docs.canonicalHash) against the current side produced by
// readCurrentM0SnapshotMarkers — which LEGITIMATELY hardcodes
// projectDocsHash: "" (head-lane placeholder: the HARD renderer replaces it
// before persist). While projectDocsHash was still a compared member, on a
// real projectDirectory the pair could never be equal: every
function docsDir(): string {
    const dir = createTestTempDirFromPath(join(tmpdir(), "region-docs-"));
    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nfrozen panel doc.\n");
    writeFileSync(join(dir, "STRUCTURE.md"), "# Structure\n\nmap.\n");
    return dir;
}

function installedRegion(dir: string): { db: Database; state: M0M1State } {
    const db = makeDb();
    const messages: MessageLike[] = [
        { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
    ];
    injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: freshState(db),
        projectPath: PROJECT_PATH,
        projectDirectory: dir,
        messages,
        isCacheBustingPass: true,
        systemRegion: { enabled: true, reason: "hard_fold" },
    } as never);
    return { db, state: freshState(db) };
}

const foldDueArgsFor = (db: Database, state: M0M1State, dir: string) => ({
    db,
    sessionId: SESSION_ID,
    state,
    projectPath: PROJECT_PATH,
    projectDirectory: dir,
});

// boundary-permission pass rotated with reason=project_docs_hash,
// executed=true, byte-identical region, forever — and each fake bust drove
// the LKG drop chain (chain B). The laws below compose currentMarkers
// through the PRODUCTION reader exactly as the promotion call site does
// (Fix A's shared helper), never a hand-shaped live({}) fixture — the
// shape that hid the defect for 11 rounds.
describe("system-region wiring: promotion comparator convergence (storm, Fix A)", () => {
    it("a warm boundary pass with unchanged docs must NOT promote (production composition)", () => {
        const dir = docsDir();
        try {
            const { db, state } = installedRegion(dir);
            // Sanity: the fold persisted a REAL docs hash on the captured
            // side (this is what made the placeholder pair unequal).
            expect(state.cachedM0ProjectDocsHash).toBeTruthy();
            const storedRegion = readSystemRegion(db, SESSION_ID);
            expect(storedRegion).not.toBeNull();
            const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
            expect(captured).not.toBeNull();
            // Exactly the promotion call-site composition (Fix A helper —
            // the wiring calls the SAME function, pinned below).
            const currentMarkers = currentRegionMarkersForPromotion(foldDueArgsFor(db, state, dir));
            const promotion = regionRotationPromotion({
                systemRegionLane: true,
                freezeM0M1: false,
                foldDue: false,
                boundaryPermission: true,
                forceBand: false,
                storedRegion,
                capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
                currentMarkers,
                historyBudgetTokens: 40000,
            });
            expect(promotion.promote).toBe(false);
            expect(promotion.reason).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("receipt honesty: unchanged docs leaves rotate=false for all four DELTA_TRIGGER fields", () => {
        // The four fields the captured side can legitimately differ from a
        // raw snapshot read on: docs included. With the production-composed
        // current side, none of them may fire.
        const dir = docsDir();
        try {
            const { db, state } = installedRegion(dir);
            const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
            expect(captured).not.toBeNull();
            const current = currentRegionMarkersForPromotion(foldDueArgsFor(db, state, dir));
            const capturedMarkers = regionMarkersFromSnapshot(captured!);
            for (const field of [
                "projectDocsHash",
                "projectMemoryEpoch",
                "maxMemoryId",
                "maxMemoryMutationId",
            ] as const) {
                expect(current[field], `field ${field}`).toBe(capturedMarkers[field]);
            }
            const decision = decideSystemRegionRotation({
                storedRegion: readSystemRegion(db, SESSION_ID),
                capturedMarkers,
                currentMarkers: current,
                bustPermission: true,
                forceBand: false,
            });
            expect(decision.rotate).toBe(false);
            expect(decision.reason).toBe("none");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a docs edit never promotes: the docs delta rides the volatile segment (Task 3 demotion)", () => {
        // Re-expressed from the Fix C control law (which pinned
        // reason=project_docs_hash promotion). Fix A's production composition
        // still matters — with the DELTA arm emptied, the docs hash must not
        // rotate the region on ANY pass; the ARCHITECTURE/STRUCTURE panel
        // converges at the next legitimate fold (owner ruling: docs are a
        // scheduled component, not the harness). The live canonical hash keeps
        // the pair CONVERGED at folds (no placeholder forever) — pinned by the
        // unchanged-docs law above and the absorb-on-fold law in
        // region-volatile.test.ts.
        const dir = docsDir();
        try {
            const { db, state } = installedRegion(dir);
            writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nchanged doc.\n");
            const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
            expect(captured).not.toBeNull();
            const promotion = regionRotationPromotion({
                systemRegionLane: true,
                freezeM0M1: false,
                foldDue: false,
                boundaryPermission: true,
                forceBand: false,
                storedRegion: readSystemRegion(db, SESSION_ID),
                capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
                currentMarkers: currentRegionMarkersForPromotion(foldDueArgsFor(db, state, dir)),
                historyBudgetTokens: 40000,
            });
            expect(promotion).toEqual({ promote: false, reason: null });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("anti-vacuity: the promotion wiring composes currentMarkers only through the shared helper", () => {
        // The live({}) fixture class hid the storm: a law may not hand-shape
        // the current side. The wiring file must obtain currentMarkers from
        // currentRegionMarkersForPromotion (the same export the laws above
        // call), and never inline the placeholder read into the promotion
        // composition.
        const wiring = readFileSync(
            join(SRC_PLUGIN, "hooks", "magic-context", "transform-postprocess-phase.ts"),
            "utf8",
        );
        expect(wiring).toContain("currentRegionMarkersForPromotion(");
        expect(
            /currentMarkers:\s*regionMarkersFromSnapshot\(\s*readCurrentM0SnapshotMarkers/.test(
                wiring,
            ),
        ).toBe(false);
        // And the helper itself hydrates docs from the canonical single
        // source — the fold-persist helper — not a reimplementation.
        const inject = readFileSync(
            join(SRC_PLUGIN, "hooks", "magic-context", "inject-compartments.ts"),
            "utf8",
        );
        const helperStart = inject.indexOf("export function currentRegionMarkersForPromotion(");
        expect(helperStart).toBeGreaterThan(-1);
        const helper = inject.slice(helperStart, inject.indexOf("\nexport ", helperStart + 1));
        expect(helper).toContain("readCurrentM0SnapshotMarkers(");
        expect(helper).toContain("readProjectDocsForM0(");
        expect(helper).not.toContain("createHash"); // no canonicalization reimplementation
    });

    // Fix C (§25.3): the promotion wrappers wired pendingBytes = the
    // ABSOLUTE stored region size into the decider's pending-growth arm,
    // with the design's floor omitted. Any session whose region exceeds
    // ~20% of the history budget rotated with reason=pending_growth on
    // every boundary pass (field receipts 04:10:06→04:12:35: rotate+execute
    // every pass, identical bytes=67,272). Ruling: REDUNDANT arm deleted —
    // see §25.3 for the head-lane precedent (all three pressure triggers
    // are m[1]-delta measures; the region is the m[0] analogue and has no
    // unbounded-volatile-delta counterpart; the four DELTA markers already
    // measure every pending growth axis with its own reason token).
    it("quiescent warm session with a region far past the cap must NOT rotate (Fix C)", () => {
        const dir = docsDir();
        try {
            const { db, state } = installedRegion(dir);
            const bigRegion = "r".repeat(200_000); // > 40_000 * 0.2 * 4 = 32_000 cap
            writeSystemRegion(db, SESSION_ID, bigRegion);
            const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
            expect(captured).not.toBeNull();
            const promotion = regionRotationPromotion({
                systemRegionLane: true,
                freezeM0M1: false,
                foldDue: false,
                boundaryPermission: true,
                forceBand: false,
                storedRegion: bigRegion,
                capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
                currentMarkers: currentRegionMarkersForPromotion(foldDueArgsFor(db, state, dir)),
                historyBudgetTokens: 40_000,
            });
            expect(promotion).toEqual({ promote: false, reason: null });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("anti-vacuity: every decider input at both promotion call sites is production-sourced, none size-derived (Fix C generalization)", () => {
        // Generalizes the Fix A anti-vacuity law to EVERY
        // decideSystemRegionRotation input at the call sites — the unit
        // pressure fixture passed while production passed region bytes as
        // queue delta. Wrapper inputs: production fields only, bust gate as
        // the documented constant true (boundaryPermission gates upstream),
        // and the pending-size class absent entirely.
        const phase = readFileSync(
            join(SRC_PLUGIN, "hooks", "magic-context", "transform-postprocess-phase.ts"),
            "utf8",
        );
        const at = phase.indexOf("export function regionRotationPromotion(");
        expect(at).toBeGreaterThan(-1);
        const wrapper = phase.slice(at, at + phase.slice(at).indexOf("\nexport ") + 1);
        const callAt = wrapper.indexOf("decideSystemRegionRotation({");
        expect(callAt).toBeGreaterThan(-1);
        const deciderCall = wrapper.slice(callAt, wrapper.indexOf("})", callAt));
        for (const field of ["storedRegion", "capturedMarkers", "currentMarkers", "forceBand"]) {
            expect(deciderCall).toContain(`${field}: input.${field}`);
        }
        expect(deciderCall).toMatch(/bustPermission:\s*true/);
        expect(deciderCall).not.toMatch(/pendingBytes/);
        expect(phase).not.toMatch(/pendingBytes/);
        const pi = readFileSync(
            join(SRC_PLUGIN, "..", "..", "pi-plugin", "src", "inject-compartments-pi.ts"),
            "utf8",
        );
        expect(pi).not.toMatch(/pendingBytes/);
        // Caller site: the boundary arm set is the computed permission, not
        // a literal; the stored region comes from the store reader; the
        // force band is the gated conjunction.
        expect(phase).toMatch(/const storedRegion = readSystemRegion\(args\.db, args\.sessionId\)/);
        expect(phase).toMatch(
            /boundaryPermission,\s*\n\s*forceBand: emergencyDropEligible && boundaryPermission/,
        );
    });
});

describe("system-region wiring: delta-class fields are demoted to the volatile carrier (Unit 2 Task 3)", () => {
    // Owner ruling (region-only migration Task 3): the only bust deciders are
    // the window manager (scheduler folds) and the harness (system hash).
    // Memories, compartments, profile, and docs only SCHEDULE their changes
    // onto the volatile segment — a live bump of any DELTA field on a warm
    // quiescent session must never rotate the region, and the segment shows
    // the delta instead. Red-first per field: real writers, production
    // promotion composition (the shared helper), boundary permission granted.
    function promotionAfterBump(
        dir: string,
        bump: (db: Database) => void,
    ): {
        promotion: { promote: boolean; reason: string | null };
        regionBefore: string | null;
        db: Database;
        dir: string;
    } {
        const { db, state } = installedRegion(dir);
        const regionBefore = readSystemRegion(db, SESSION_ID);
        expect(regionBefore).not.toBeNull();
        bump(db);
        const captured = state.snapshotMarkers ?? snapshotMarkersFromCachedM0(state);
        expect(captured).not.toBeNull();
        const promotion = regionRotationPromotion({
            systemRegionLane: true,
            freezeM0M1: false,
            foldDue: false,
            boundaryPermission: true,
            forceBand: false,
            storedRegion: regionBefore,
            capturedMarkers: captured ? regionMarkersFromSnapshot(captured) : null,
            currentMarkers: currentRegionMarkersForPromotion(foldDueArgsFor(db, state, dir)),
            historyBudgetTokens: 40000,
        });
        return { promotion, regionBefore, db, dir };
    }

    const expectNoRotation = (t: ReturnType<typeof promotionAfterBump>) => {
        expect(t.promotion).toEqual({ promote: false, reason: null });
        // Zero rotation: the stored region is byte-identical after the pass.
        expect(readSystemRegion(t.db, SESSION_ID)).toBe(t.regionBefore);
    };

    it("a real memory insert (maxMemoryId bump) never rotates on a boundary pass", () => {
        const dir = docsDir();
        try {
            expectNoRotation(
                promotionAfterBump(dir, (db) => {
                    insertMemory(db, {
                        projectPath: PROJECT_PATH,
                        category: "CONSTRAINTS",
                        content: "delta demotion sighting: new memory after install",
                    });
                }),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a published compartment (maxCompartmentSeq bump) never rotates on a boundary pass", () => {
        const dir = docsDir();
        try {
            expectNoRotation(
                promotionAfterBump(dir, (db) => {
                    const maxSeq = (
                        db
                            .prepare(
                                "SELECT COALESCE(MAX(sequence), -1) AS m FROM compartments WHERE session_id = ?",
                            )
                            .get(SESSION_ID) as { m: number }
                    ).m;
                    db.prepare(
                        `INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, importance, created_at)
                         VALUES (?, ?, 1, 2, 'msg_a', 'msg_b', 'post-install compartment', 'post-install compartment sighting', 5, 1)`,
                    ).run(SESSION_ID, maxSeq + 1);
                }),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a user-profile version bump (profileVersion) never rotates on a boundary pass", () => {
        const dir = docsDir();
        try {
            expectNoRotation(
                promotionAfterBump(dir, (db) => {
                    bumpProjectUserProfileVersion(db);
                }),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a docs edit on disk (projectDocsHash) never rotates on a boundary pass", () => {
        const dir = docsDir();
        try {
            expectNoRotation(
                promotionAfterBump(dir, () => {
                    writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nedited doc.\n");
                }),
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
