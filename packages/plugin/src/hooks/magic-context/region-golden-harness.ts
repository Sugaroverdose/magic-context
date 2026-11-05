/**
 * Shared harness for the region golden laws (assembly-v2 Unit 1). Loads a
 * manifest window's committed seed into a fresh temp store and builds the
 * production render options. Law A (region-golden-replay.test.ts) drives the
 * full production entry through this; Law B (region-golden-parity.test.ts)
 * drives the extracted region renderers through the SAME seeding, so the two
 * laws differ only in the byte-producer under test.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { M0M1RenderOptions, M0M1State } from "./inject-compartments";

export const GOLDEN_DIR = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "test-data",
    "region-goldens",
);

export interface ManifestWindow {
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

export interface Manifest {
    schemaVersion: number;
    capturedAt: string;
    captureCommit: string;
    timezone: string;
    estimatorFingerprint: string;
    windows: ManifestWindow[];
}

export interface Seed {
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

export function packagePresent(): boolean {
    return existsSync(join(GOLDEN_DIR, "manifest.json"));
}

export function loadManifest(): Manifest {
    return JSON.parse(readFileSync(join(GOLDEN_DIR, "manifest.json"), "utf8")) as Manifest;
}

export function readGzJson(path: string): unknown {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8")) as unknown;
}

export function sharedSlug(identity: string): string {
    return identity.replace(/[^a-z0-9]/g, "").slice(0, 12);
}

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
    );
}

export function insertRows(db: Database, table: string, rows: unknown): void {
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

export interface SeededWindow {
    db: Database;
    docsDir: string;
    state: M0M1State;
    dataHome: string;
}

/**
 * Materializes the window's committed seed into a fresh temp store (real
 * windows pull their project-scoped tables from the shared store), pins TZ,
 * and returns everything needed to build the production render options.
 * The caller owns the clock pin (Date.now) and cleanup.
 */
export function seedWindow(window: ManifestWindow, manifest: Manifest): SeededWindow {
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
    return { db, docsDir, state, dataHome };
}

export function buildRenderOptions(
    window: ManifestWindow,
    seeded: SeededWindow,
    systemRegion?: { enabled: true; reason: string },
): M0M1RenderOptions {
    return {
        db: seeded.db,
        sessionId: window.sessionId,
        state: seeded.state,
        projectPath: window.identity,
        projectDirectory: seeded.docsDir,
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
        ...(systemRegion ? { systemRegion } : {}),
    };
}

export { closeDatabase };
