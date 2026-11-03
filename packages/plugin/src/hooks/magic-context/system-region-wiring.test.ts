/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSystemRegionLane } from "../../config/system-region-lane";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    type RegionMarkers,
    readSystemRegion,
    SYSTEM_REGION_SENTINEL,
    writeSystemRegion,
} from "../../features/magic-context/system-region";
import {
    hasCompleteCachedM0M1,
    injectM0M1,
    type M0M1State,
    mustMaterialize,
    prepareCachedM0M1Replay,
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

    it("inert capability lane (head): the head lane still prepends its two synthetic messages", () => {
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
        expect(hasCompleteCachedM0M1(db, SESSION_ID, true)).toBe(true);
        const replay = prepareCachedM0M1Replay(db, SESSION_ID, true);
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

// Round-2 review C2c: a sentinel row must never be served as head text by a
// lane that does not run the region. Head-lane readers treat it as absent.
describe("system-region wiring: cross-lane reader discrimination", () => {
    function seedSentinelRow(sessionId: string) {
        const db = new Database(":memory:");
        initializeDatabase(db);
        getOrCreateSessionMeta(db, sessionId);
        db.prepare(
            "UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
        ).run(encodeSystemRegionRowSafe("<project-memory>foreign</project-memory>"), sessionId);
        return db;
    }
    function encodeSystemRegionRowSafe(text: string): Uint8Array {
        return new TextEncoder().encode(`<!-- mc:system-region v1 -->\n${text}`);
    }

    it("head lane: a sentinel row is first_render, not a complete prefix", async () => {
        const { mustMaterialize, prepareCachedM0M1Replay, hasCompleteCachedM0M1 } = await import(
            "./inject-compartments"
        );
        const db = seedSentinelRow("ses-c2-headlane");
        const state = getOrCreateSessionMeta(db, "ses-c2-headlane");
        expect(
            mustMaterialize({
                db,
                sessionId: "ses-c2-headlane",
                state,
                projectPath: "/p",
                projectDirectory: "",
                systemRegionMode: false,
            } as never).reason,
        ).toBe("first_render");
        expect(prepareCachedM0M1Replay(db, "ses-c2-headlane", false)).toBeUndefined();
        expect(hasCompleteCachedM0M1(db, "ses-c2-headlane", false)).toBe(false);
    });

    it("control region lane: the same row is a complete served prefix", async () => {
        const { prepareCachedM0M1Replay, hasCompleteCachedM0M1 } = await import(
            "./inject-compartments"
        );
        const db = seedSentinelRow("ses-c2-regionlane");
        expect(prepareCachedM0M1Replay(db, "ses-c2-regionlane", true)).toBeDefined();
        expect(hasCompleteCachedM0M1(db, "ses-c2-regionlane", true)).toBe(true);
    });
});

describe("prepareCachedM0M1Replay truth table (lint-refactor pin)", () => {
    it("head rows need m1; region rows never read m1", () => {
        const db = makeDb();
        expect(prepareCachedM0M1Replay(db, SESSION_ID)).toBeUndefined(); // no row
        db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
            Buffer.from("<session-history>head</session-history>", "utf8"),
            SESSION_ID,
        );
        // Head m0, null m1: refused (no empty-head serve).
        expect(prepareCachedM0M1Replay(db, SESSION_ID)).toBeUndefined();
        db.prepare("UPDATE session_meta SET cached_m1_bytes = ? WHERE session_id = ?").run(
            Buffer.from("<session-history-since>d</session-history-since>", "utf8"),
            SESSION_ID,
        );
        expect(prepareCachedM0M1Replay(db, SESSION_ID)?.injected).toBe(true);
        // Region m0 with null m1 on the region lane: serves, m1 text never read.
        writeSystemRegion(db, SESSION_ID, "<project-memory>r</project-memory>");
        const regionPass = prepareCachedM0M1Replay(db, SESSION_ID, true);
        expect(regionPass?.injected).toBe(true);
        // The region row owns the head text; the m1 slot must render as the
        // empty placeholder text, never as stored bytes.
        expect(regionPass?.m1Text).toBe("");
        // Region row off the region lane: refused.
        expect(prepareCachedM0M1Replay(db, SESSION_ID)).toBeUndefined();
    });
});

// Owner ruling (2026-11-03): the system_region.enabled flag is DEAD — no
// config switch; the region lane is an install-time capability, and
// recovery is rollback (spec flip), never a config flip. One exported
// decider, computed once per handler boot from transformMode + compaction
// (L0 spirit: one decider, threaded — no per-site re-derivation).
describe("system-region capability lane (flag deletion)", () => {
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
        { name: "rust transform mode", config: { transform_mode: "rust" }, want: false },
        {
            name: "rust + compaction on",
            config: { transform_mode: "rust", compaction: { enabled: true } },
            want: false,
        },
        { name: "compaction off (legacy false)", config: { compaction: false }, want: false },
        {
            name: "compaction off (object)",
            config: { compaction: { enabled: false } },
            want: false,
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
