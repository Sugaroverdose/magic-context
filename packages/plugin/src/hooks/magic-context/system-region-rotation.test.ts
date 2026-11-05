/// <reference types="bun-types" />

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const lines: string[] = [];
mock.module("../../shared/logger", () => ({
    log: () => {},
    sessionLog: (_sessionId: string, message: string) => lines.push(message),
    flushLogger: () => {},
    setLogLineForwarder: () => {},
    writeForwardedLogLine: () => {},
    getLogFilePath: () => "/tmp/magic-context-test.log",
    getLoggerDiagnostics: () => ({
        swallowedWriteCount: 0,
        lastErrorMessage: null,
        lastErrorTime: null,
    }),
}));

const {
    decideSystemRegionRotation,
    decodeSystemRegionRow,
    executeSystemRegionRotation,
    readSystemRegion,
} = await import("../../features/magic-context/system-region");

import type { RegionMarkers } from "../../features/magic-context/system-region";
import type { Database } from "../../shared/sqlite";

function fixture(): Database {
    const raw = new BunDatabase(":memory:");
    raw.exec(`CREATE TABLE session_meta (
        session_id TEXT PRIMARY KEY,
        cached_m0_bytes BLOB
    );`);
    return raw as unknown as Database;
}

const BASE: RegionMarkers = {
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
    profileRenderEpoch: "upe1",
    profileVersion: 4,
};

function stored(region: string | null): { storedRegion: string | null } {
    return { storedRegion: region };
}

describe("system-region rotation decision: content triggers", () => {
    it("first render rotates only with the bust permission (A3: rotation IS the bust)", () => {
        // A rotation rewrites served bytes; per L4 no arm — install, content,
        // delta, or pressure — may claim rotate without the single per-pass
        // bust permission. Installs are the fold lane's job (mustMaterialize
        // region_first_install), which is itself a boundary.
        expect(
            decideSystemRegionRotation({
                ...stored(null),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: false,
            }).rotate,
        ).toBe(false);
        expect(
            decideSystemRegionRotation({
                ...stored(null),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: true,
            }).rotate,
        ).toBe(true);
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: null,
                currentMarkers: BASE,
                bustPermission: false,
            }).rotate,
        ).toBe(false);
    });

    it.each([
        ["project_memory_epoch", "projectMemoryEpoch", 2],
        ["max_mutation_id", "maxMutationId", 4],
        ["max_memory_mutation_id", "maxMemoryMutationId", 1],
        ["upgrade_state", "upgradeState", "down"],
        ["compartment_render_epoch", "compartmentRenderEpoch", 3],
        ["mural_enabled", "muralEnabled", true],
        ["render_budget_identity", "renderBudgetIdentity", "rb2"],
        ["memory_render_epoch", "memoryRenderEpoch", 2],
        ["rendered_budgets", "renderedBudgets", "b"],
        ["profile_render_epoch", "profileRenderEpoch", "upe2"],
    ] as const)("rotation reason=%s", (reason, field, value) => {
        // Content arms share the delta arms' gating: rotate only on a pass
        // that already holds the bust permission.
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: { ...BASE, [field]: value },
                bustPermission: false,
            }),
        ).toEqual({ rotate: false, reason: "none" });
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: { ...BASE, [field]: value },
                bustPermission: true,
            }),
        ).toEqual({ rotate: true, reason });
    });

    it("names first_render on the receipt", () => {
        expect(
            decideSystemRegionRotation({
                ...stored(null),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: true,
            }).reason,
        ).toBe("first_render");
    });
});

describe("system-region rotation decision: delta-class fields never rotate (Task 3 demotion)", () => {
    // Owner ruling (region-only Task 3): the delta-class fields surface on the
    // volatile segment and are absorbed on folds; they rotate the region on
    // NO pass, boundary-permitted or not — the only bust deciders are the
    // window manager and the harness. Fence anchor: re-adding a
    // DELTA_TRIGGER_FIELDS entry reddens these laws (unit) and the
    // production-composition demotion laws (system-region-wiring.test.ts).
    it.each([
        ["new compartment sequence", { maxCompartmentSeq: 8 }, "max_compartment_seq"],
        ["profile version", { profileVersion: 5 }, "profile_version"],
        ["maxMemoryId watermark", { maxMemoryId: 13 }, "max_memory_id"],
        ["project-docs hash", { projectDocsHash: "hash-b" }, "project_docs_hash"],
    ] as const)("%s never rotates, with or without the bust permission", (_label, patch) => {
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: { ...BASE, ...patch },
                bustPermission: false,
            }),
        ).toEqual({ rotate: false, reason: "none" });
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: { ...BASE, ...patch },
                bustPermission: true,
            }),
        ).toEqual({ rotate: false, reason: "none" });
    });

    it("no rotation when markers are identical", () => {
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: true,
            }),
        ).toEqual({ rotate: false, reason: "none" });
    });
});

describe("system-region rotation decision: no size/pressure arm (Fix C, §25.3)", () => {
    // The pending_growth arm rotated on the ABSOLUTE stored-region size —
    // every session past ~20% of the history budget stormed on every
    // boundary pass (field receipts: identical bytes=67,272, rotate+execute
    // 04:10:06→04:12:35). Deleted as redundant: growth is the marker
    // comparison, which owns a reason token per axis.
    it("a stored region far past any conceivable cap never rotates with identical markers", () => {
        const huge = "r".repeat(400_000);
        expect(
            decideSystemRegionRotation({
                ...stored(huge),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: true,
            }),
        ).toEqual({ rotate: false, reason: "none" });
        expect(
            decideSystemRegionRotation({
                ...stored(huge),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: false,
            }),
        ).toEqual({ rotate: false, reason: "none" });
    });

    it("the force band rotates only with the bust permission", () => {
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                forceBand: true,
                bustPermission: true,
            }),
        ).toEqual({ rotate: true, reason: "force_band" });
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                forceBand: true,
                bustPermission: false,
            }),
        ).toEqual({ rotate: false, reason: "none" });
    });

    it("the decider carries no pending-size vocabulary at all (structural, anti-reintroduction)", () => {
        const src = readFileSync(
            join(import.meta.dir, "..", "..", "features", "magic-context", "system-region.ts"),
            "utf8",
        );
        expect(src).not.toMatch(/pendingBytes/);
        expect(src).not.toMatch(/pending_growth/);
    });
});

describe("system-region rotation execution", () => {
    it("installs the region, captures the markers, and prints the receipt", () => {
        const db = fixture();
        lines.length = 0;
        let persisted: RegionMarkers | undefined;
        let persistedBlob: Buffer | undefined;
        expect(
            executeSystemRegionRotation(
                db,
                "ses",
                "max_memory_id",
                "region-bytes",
                BASE,
                (blob, markers) => {
                    persistedBlob = blob;
                    persisted = markers;
                },
            ),
        ).toBe(true);
        // The fold's single writer receives the sentinel-encoded payload and
        // the markers to capture, in one call (one transaction).
        expect(persisted).toEqual(BASE);
        expect(decodeSystemRegionRow(persistedBlob ?? null)).toBe("region-bytes");
        expect(
            lines.some((line) =>
                line.includes(
                    "system-region rotation: reason=max_memory_id executed=true bytes=12",
                ),
            ),
        ).toBe(true);
    });

    it("a persist throw propagates with no success receipt (L6: capture rides the fold transaction)", () => {
        const db = fixture();
        lines.length = 0;
        expect(() =>
            executeSystemRegionRotation(db, "sesthrow", "memory", "region-bytes", BASE, () => {
                throw new Error("db busy");
            }),
        ).toThrow("db busy");
        // The rotation performs no write of its own when a persist callback is
        // given, so the fold transaction owns (and can roll back) the install;
        // and an unlanded rotation never prints executed=true.
        expect(readSystemRegion(db, "sesthrow")).toBeNull();
        expect(lines.some((l) => l.includes("executed=true"))).toBe(false);
    });

    it("markers are never captured for a refused rotation", () => {
        const db = fixture();
        lines.length = 0;
        let persisted = false;
        expect(
            executeSystemRegionRotation(
                db,
                "sesn",
                "force_band",
                "<!-- mc:system-region v1 -->forged",
                BASE,
                () => {
                    persisted = true;
                },
            ),
        ).toBe(false);
        expect(persisted).toBe(false);
    });

    it("a refused write says executed=false and installs nothing", () => {
        const db = fixture();
        lines.length = 0;
        expect(executeSystemRegionRotation(db, "ses2", "first_render", "", BASE)).toBe(false);
        expect(readSystemRegion(db, "ses2")).toBeNull();
    });

    it("execution refuses a payload forging the sentinel and receipts executed=false", () => {
        const db = fixture();
        lines.length = 0;
        expect(
            executeSystemRegionRotation(
                db,
                "ses3",
                "force_band",
                "<!-- mc:system-region v1 -->forged",
                BASE,
            ),
        ).toBe(false);
        expect(
            lines.some((line) =>
                line.includes("system-region rotation: reason=force_band executed=false"),
            ),
        ).toBe(true);
    });

    it("the second refusal arm: a non-string payload never reaches the store", () => {
        const db = fixture();
        lines.length = 0;
        expect(
            executeSystemRegionRotation(
                db,
                "ses4",
                "first_render",
                undefined as unknown as string,
                BASE,
            ),
        ).toBe(false);
        expect(
            lines.some((line) =>
                line.includes("system-region rotation: reason=first_render executed=false"),
            ),
        ).toBe(true);
    });
});
