/// <reference types="bun-types" />

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";

const SRC_ROOT = join(import.meta.dir, "..", "..");

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

const { clearAllSystemRegions, clearSystemRegion, readSystemRegion } = await import(
    "../../features/magic-context/system-region"
);

import { encodeSystemRegionRow } from "../../features/magic-context/system-region";

function freshDb() {
    const db = new BunDatabase(":memory:");
    initializeDatabase(db);
    return db as never;
}

function seedRegion(db: never, sessionId: string, content = "<project-memory>x</project-memory>") {
    getOrCreateSessionMeta(db, sessionId);
    db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
        encodeSystemRegionRow(content),
        sessionId,
    );
    expect(readSystemRegion(db, sessionId)).toBe(content);
}

function clearedLines(): string[] {
    return lines.filter((line) => line.includes("system-region cleared"));
}

describe("system-region clear funnel: sole receipted eraser (L3/L7)", () => {
    it("the production tree has no raw cached_m0_bytes eraser outside the sanctioned funnel", () => {
        // Sanctioned writers: the funnel (system-region.ts) and the fold-row
        // transaction path (storage-meta-shared updateSessionMeta, reached
        // only through the fold's persist callback). Everything else that
        // nulls or overwrites the region column is a law violation — this is
        // how the un-receipted-eraser class stays dead, not just this fix.
        const allowed = new Set([
            relative(SRC_ROOT, join(SRC_ROOT, "features/magic-context/system-region.ts")),
            relative(SRC_ROOT, join(SRC_ROOT, "features/magic-context/storage-meta-shared.ts")),
        ]);
        const offenders: string[] = [];
        const walk = (dir: string) => {
            for (const entry of readdirSync(dir)) {
                const full = join(dir, entry);
                if (statSync(full).isDirectory()) {
                    walk(full);
                    continue;
                }
                if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
                const rel = relative(SRC_ROOT, full);
                if (allowed.has(rel)) continue;
                const text = readFileSync(full, "utf8");
                // UPDATE ... SET cached_m0_bytes = NULL / ? / values
                if (/cached_m0_bytes\s*=\s*(NULL|\?)/i.test(text)) offenders.push(rel);
            }
        };
        walk(SRC_ROOT);
        expect(offenders).toEqual([]);
    });

    it("clearSystemRegion receipts the event and leaves the row unreadable as a region", () => {
        const db = freshDb();
        seedRegion(db, "ses-clear-funnel");
        lines.length = 0;
        clearSystemRegion(db, "ses-clear-funnel", "test_reason");
        expect(readSystemRegion(db, "ses-clear-funnel")).toBeNull();
        expect(clearedLines()).toEqual(["system-region cleared reason=test_reason"]);
    });

    it("clearAllSystemRegions receipts once with the cleared count", () => {
        const db = freshDb();
        seedRegion(db, "ses-bulk-1");
        seedRegion(db, "ses-bulk-2");
        getOrCreateSessionMeta(db, "ses-bulk-plain");
        lines.length = 0;
        expect(clearAllSystemRegions(db, "migration")).toBe(2);
        expect(readSystemRegion(db, "ses-bulk-1")).toBeNull();
        expect(readSystemRegion(db, "ses-bulk-2")).toBeNull();
        expect(clearedLines()).toEqual(["system-region cleared reason=migration count=2"]);
    });

    it("a no-op clear is not an event: no receipt without a region row", () => {
        const db = freshDb();
        getOrCreateSessionMeta(db, "ses-clear-noop");
        lines.length = 0;
        clearSystemRegion(db, "ses-clear-noop", "test_reason");
        expect(clearedLines()).toEqual([]);
    });

    it("identity merge clears region rows through the funnel with a named receipt", async () => {
        const { mergeProjectIdentities } = await import(
            "../../features/magic-context/storage-identity-merge"
        );
        const db = freshDb();
        seedRegion(db, "ses-merge-a");
        seedRegion(db, "ses-merge-b");
        db.prepare(
            "UPDATE session_meta SET cached_m0_project_identity = ? WHERE session_id IN (?, ?)",
        ).run("/identity/from", "ses-merge-a", "ses-merge-b");
        // Give the merge a changed row to process (it early-returns on a
        // zero-change audit — and the raw eraser historically lived behind
        // that early return).
        const { insertMemory } = await import("../../features/magic-context/memory/storage-memory");
        insertMemory(db, {
            projectPath: "/identity/from",
            category: "ARCHITECTURE",
            content: "merge me",
        });
        lines.length = 0;
        mergeProjectIdentities(db, "/identity/from", "/identity/to");
        expect(readSystemRegion(db, "ses-merge-a")).toBeNull();
        expect(readSystemRegion(db, "ses-merge-b")).toBeNull();
        const receipts = clearedLines().filter((line) => line.includes("reason=identity_merge"));
        expect(receipts.length).toBe(1);
        expect(receipts[0]).toContain("count=2");
        // Next-pass repair: the cleared row folds a fresh region, as designed.
        const { mustMaterialize } = await import("./inject-compartments");
        const decision = mustMaterialize({
            db,
            sessionId: "ses-merge-a",
            state: getOrCreateSessionMeta(db, "ses-merge-a"),
            projectPath: "/identity/to",
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        // A cleared row folds immediately: null bytes short-circuit to
        // first_render; a stale head-era row would say region_first_install.
        expect(["first_render", "region_first_install"]).toContain(decision.reason);
    });

    it("session clone clears the destination region row through the funnel", async () => {
        const { copySessionStateForClone } = await import(
            "../../features/magic-context/storage-clone"
        );
        const db = freshDb();
        seedRegion(db, "ses-clone-src");
        seedRegion(db, "ses-clone-dst");
        lines.length = 0;
        copySessionStateForClone(db, "ses-clone-src", "ses-clone-dst", {
            resolveBoundaryOrdinal: () => 1,
            includeTag: () => true,
            includeMessageId: () => true,
            selectPendingPiMarker: () => null,
        } as never);
        expect(readSystemRegion(db, "ses-clone-dst")).toBeNull();
        expect(clearedLines().some((line) => line.includes("reason=storage_clone"))).toBe(true);
        // The source row is untouched by a clone.
        expect(readSystemRegion(db, "ses-clone-src")).toBe("<project-memory>x</project-memory>");
    });

    it("compaction-off transition clears the region through the funnel with a receipt", async () => {
        const { reconcileCompactionMode } = await import("./compaction-off-transition");
        const db = freshDb();
        seedRegion(db, "ses-off-transition");
        lines.length = 0;
        reconcileCompactionMode({
            db,
            sessionId: "ses-off-transition",
            compactionOff: true,
            historianRunnable: false,
            compartmentInProgress: false,
            cleanupMarkers: () =>
                ({
                    cleaned: true,
                    clearedMarkerCount: 0,
                    markerStates: [],
                }) as never,
        });
        expect(readSystemRegion(db, "ses-off-transition")).toBeNull();
        expect(
            clearedLines().some((line) => line.includes("reason=compaction_off_transition")),
        ).toBe(true);
    });
});
