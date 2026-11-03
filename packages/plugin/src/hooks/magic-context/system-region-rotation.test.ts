/// <reference types="bun-types" />

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";

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
} = await import("./system-region");

import type { Database } from "../../shared/sqlite";
import type { RegionMarkers } from "./system-region";

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
    profileVersion: 4,
};

function stored(region: string | null): { storedRegion: string | null } {
    return { storedRegion: region };
}

describe("system-region rotation decision: content triggers", () => {
    it("first render rotates", () => {
        expect(
            decideSystemRegionRotation({
                ...stored(null),
                capturedMarkers: BASE,
                currentMarkers: BASE,
                bustPermission: false,
            }).rotate,
        ).toBe(true);
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
    ] as const)("rotation reason=%s", (reason, field, value) => {
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: { ...BASE, [field]: value },
                bustPermission: false,
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

describe("system-region rotation decision: deliberate non-triggers", () => {
    // The m[1]-delta members must never rotate the region on their own; they
    // fold in at the next genuine boundary (the mustMaterialize non-trigger list).
    it.each([
        ["new compartment sequence", { maxCompartmentSeq: 8 }],
        ["profile version", { profileVersion: 5 }],
        ["maxMemoryId watermark", { maxMemoryId: 13 }],
        ["project-docs hash", { projectDocsHash: "hash-b" }],
    ] as const)("no rotation for %s", (_label, patch) => {
        expect(
            decideSystemRegionRotation({
                ...stored("r"),
                capturedMarkers: BASE,
                currentMarkers: { ...BASE, ...patch },
                bustPermission: true,
            }).rotate,
        ).toBe(false);
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

describe("system-region rotation decision: pressure arms are ride-only", () => {
    const pressure = {
        ...stored("r"),
        capturedMarkers: BASE,
        currentMarkers: BASE,
        pendingBytes: 90_000,
        pendingBytesCap: 40_000,
        pendingBytesMinFloor: 10_000,
    };

    it("a large pending delta rotates on a busting pass", () => {
        expect(decideSystemRegionRotation({ ...pressure, bustPermission: true })).toEqual({
            rotate: true,
            reason: "pending_growth",
        });
    });

    it("the same delta on a non-busting pass never rotates (ride-only law)", () => {
        expect(decideSystemRegionRotation({ ...pressure, bustPermission: false })).toEqual({
            rotate: false,
            reason: "none",
        });
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

    it("pending growth below the floor or cap does not rotate even with permission", () => {
        expect(
            decideSystemRegionRotation({
                ...pressure,
                pendingBytes: 9_000,
                bustPermission: true,
            }),
        ).toEqual({ rotate: false, reason: "none" });
        expect(
            decideSystemRegionRotation({
                ...pressure,
                pendingBytes: 40_000,
                bustPermission: true,
            }),
        ).toEqual({ rotate: false, reason: "none" });
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
                "pending_growth",
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
                    "system-region rotation: reason=pending_growth executed=true bytes=12",
                ),
            ),
        ).toBe(true);
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
