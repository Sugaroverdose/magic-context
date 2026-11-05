/// <reference types="bun-types" />

/**
 * Region golden replay law (assembly-v2 Unit 1, Step 1).
 *
 * Law A of the golden package: re-running the committed seeds through the
 * production rotation path must reproduce the committed region bytes
 * byte-exactly. The capture (scripts/region-golden/capture.ts) drives
 * `injectM0M1({ systemRegion: { enabled: true } })` → materializeM0 →
 * executeSystemRegionRotation (inject-compartments.ts:2846) against a fresh
 * temp store seeded from the host context.db (read-only extraction); this
 * law replays the identical drive and compares bytes.
 *
 * Real windows carry the host row's stored-region sha256 in the manifest
 * as provenance; the byte-equality that matters is seed → production path →
 * committed bytes, so any regression in the renderers, the fold plumbing, or
 * the tokenizer reddens a named window here — before the sever (Step 2)
 * replaces the drive with `renderRegionBody`.
 *
 * Skips (does not fail) when the golden package is absent from the checkout;
 * the package is committed, so CI always runs it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { readSystemRegion } from "../../features/magic-context/system-region";
import type { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import { injectM0M1, type M0M1RenderOptions, type M0M1State } from "./inject-compartments";
import { getTokenEstimatorFingerprint } from "./read-session-formatting";

const GOLDEN_DIR = join(import.meta.dirname, "..", "..", "..", "test-data", "region-goldens");

interface ManifestWindow {
    id: string;
    kind: "real" | "fixture";
    sessionId: string;
    identity: string;
    docsFiles: string[];
    modelKey: string;
    budgets: {
        memoryInjectionBudgetTokens: number;
        historyBudgetTokens: number;
        historyBudgetPolicyIdentity: string | null;
    };
    muralEnabled: boolean;
    compactionOff: boolean;
    temporalAwareness: boolean;
    memoryEnabled: boolean;
    injectDocs: boolean;
    frozenNowMs: number;
    timezone: string;
    estimatorFingerprint: string;
    regionFile: string;
    regionSha256: string;
    regionByteLength: number;
    m1PlaceholderHalf: boolean;
    storedRegionSha256: string | null;
    seedFile: string;
    docsFile: string | null;
}

interface Manifest {
    schemaVersion: number;
    capturedAt: string;
    captureCommit: string;
    timezone: string;
    estimatorFingerprint: string;
    windows: ManifestWindow[];
}

const packagePresent = existsSync(join(GOLDEN_DIR, "manifest.json"));
if (!packagePresent) {
    // Not an error path for the product; loud for the developer.
    console.warn(`[region-golden-replay] golden package absent: ${GOLDEN_DIR}`);
}

function loadManifest(): Manifest {
    return JSON.parse(readFileSync(join(GOLDEN_DIR, "manifest.json"), "utf8")) as Manifest;
}

function readGzJson(path: string): unknown {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as unknown;
}

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTz = process.env.TZ;
const originalNow = Date.now;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    Date.now = originalNow;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
});

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
    );
}

function insertRows(db: Database, table: string, rows: unknown): void {
    const list = rows as Array<Record<string, unknown>>;
    if (!Array.isArray(list) || list.length === 0) return;
    const target = new Set(tableColumns(db, table));
    const columns = Object.keys(list[0]).filter((name) => target.has(name));
    if (columns.length === 0) return;
    const placeholders = columns.map(() => "?").join(", ");
    const statement = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    );
    for (const row of list) {
        const values = columns.map((name) => {
            const value = row[name];
            if (value !== null && typeof value === "object" && "__b64" in (value as object)) {
                return Buffer.from(String((value as { __b64: string }).__b64), "base64");
            }
            return value;
        });
        statement.run(...(values as never[]));
    }
}

interface Seed {
    sessionMeta: Record<string, unknown>;
    compartments: Array<Record<string, unknown>>;
    rowidMap: Array<Record<string, unknown>>;
    m0Mutations: Array<Record<string, unknown>>;
    sessionProjects: Array<Record<string, unknown>>;
    memories: Array<Record<string, unknown>>;
    memoryMutations: Array<Record<string, unknown>>;
    userMemories: Array<Record<string, unknown>>;
    projectState: Array<Record<string, unknown>>;
    modelKey: string;
}

function sharedSlug(identity: string): string {
    return identity.replace(/[^a-z0-9]/g, "").slice(0, 12);
}

function replayWindow(window: ManifestWindow): Buffer {
    const manifest = loadManifest();
    const seed = readGzJson(join(GOLDEN_DIR, window.seedFile)) as Seed;
    if (window.kind === "real") {
        const slug = sharedSlug(window.identity);
        seed.memories = readGzJson(join(GOLDEN_DIR, "shared", `memories-${slug}.json.gz`)) as Array<
            Record<string, unknown>
        >;
        seed.memoryMutations = readGzJson(
            join(GOLDEN_DIR, "shared", `memory-mutation-log-${slug}.json.gz`),
        ) as Array<Record<string, unknown>>;
        seed.userMemories = readGzJson(
            join(GOLDEN_DIR, "shared", "user-memories.json.gz"),
        ) as Array<Record<string, unknown>>;
        seed.projectState = readGzJson(
            join(GOLDEN_DIR, "shared", "project-state.json.gz"),
        ) as Array<Record<string, unknown>>;
    }
    const docs = window.docsFile
        ? ((
              readGzJson(join(GOLDEN_DIR, window.docsFile)) as {
                  files: Array<{ name: string; content: string }>;
              }
          ).files ?? [])
        : [];

    const dataHome = createTestTempDirFromPath(join(tmpdir(), "mc-region-golden-replay"));
    tempDirs.push(dataHome);
    process.env.XDG_DATA_HOME = dataHome;
    process.env.TZ = manifest.timezone ?? window.timezone;
    const docsDir = join(dataHome, "docs");
    mkdirSync(docsDir, { recursive: true });
    for (const file of docs) {
        writeFileSync(join(docsDir, file.name), file.content, "utf8");
    }

    const db = openDatabase();
    if (!db) throw new Error(`${window.id}: openDatabase returned null`);
    insertRows(db, "session_meta", [seed.sessionMeta]);
    insertRows(db, "compartments", seed.compartments);
    insertRows(db, "message_fts_rowid_map", seed.rowidMap);
    insertRows(db, "m0_mutation_log", seed.m0Mutations);
    insertRows(db, "session_projects", seed.sessionProjects);
    insertRows(db, "memories", seed.memories);
    insertRows(db, "memory_mutation_log", seed.memoryMutations);
    insertRows(db, "user_memories", seed.userMemories);
    insertRows(db, "project_state", seed.projectState);
    const state = getOrCreateSessionMeta(db, window.sessionId) as unknown as M0M1State;
    const options: M0M1RenderOptions = {
        db,
        sessionId: window.sessionId,
        state,
        projectPath: window.identity,
        projectDirectory: docsDir,
        injectDocs: window.injectDocs,
        memoryEnabled: window.memoryEnabled,
        memoryInjectionBudgetTokens: window.budgets.memoryInjectionBudgetTokens,
        historyBudgetTokens: window.budgets.historyBudgetTokens,
        historyBudgetPolicyIdentity: window.budgets.historyBudgetPolicyIdentity ?? undefined,
        temporalAwareness: window.temporalAwareness,
        isCacheBustingPass: true,
        muralEnabled: window.muralEnabled,
        compactionOff: window.compactionOff,
        hardSignals: {
            systemHash: "",
            toolSetHash: "",
            modelKey: window.modelKey,
            cacheExpired: true,
            lastResponseTime: 0,
        },
        systemRegion: { enabled: true, reason: "golden_replay" },
    };
    Date.now = () => window.frozenNowMs;
    injectM0M1(options);
    const region = readSystemRegion(db, window.sessionId);
    if (region === null) throw new Error(`${window.id}: no sentinel-valid region after replay`);
    return Buffer.from(region, "utf8");
}

describe("region golden replay (Law A: byte-exact seed → production path)", () => {
    it.skipIf(!packagePresent)("golden package manifest is self-consistent", () => {
        const manifest = loadManifest();
        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.windows.length).toBeGreaterThanOrEqual(10);
        for (const window of manifest.windows) {
            const bytes = readFileSync(join(GOLDEN_DIR, window.regionFile));
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(window.regionSha256);
            expect(bytes.length).toBe(window.regionByteLength);
            expect(bytes.length).toBeGreaterThan(0);
        }
    });

    it.skipIf(!packagePresent)(
        "the estimator fingerprint matches the capture (bytes depend on it)",
        () => {
            const manifest = loadManifest();
            expect(getTokenEstimatorFingerprint()).toBe(manifest.estimatorFingerprint);
        },
    );

    const manifest = packagePresent ? loadManifest() : null;
    for (const window of manifest?.windows ?? []) {
        it.skipIf(!packagePresent)(`replays ${window.id} byte-exactly`, () => {
            const bytes = replayWindow(window);
            expect(bytes.toString("utf8")).toBe(
                readFileSync(join(GOLDEN_DIR, window.regionFile)).toString("utf8"),
            );
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(window.regionSha256);
        });
    }
});
