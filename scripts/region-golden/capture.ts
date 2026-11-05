/**
 * Region golden capture — assembly-v2 Unit 1 Step 1.
 *
 * Captures pre-refactor frozen-region bytes through the PRODUCTION rotation
 * path: `injectM0M1({ systemRegion: { enabled: true } })` → materializeM0 →
 * the `executeSystemRegionRotation` seam (inject-compartments.ts:2846).
 * Nothing here hand-builds region bytes.
 *
 * Real windows are extracted from the host context.db opened READ-ONLY,
 * re-seeded into a fresh temp store (XDG_DATA_HOME), and driven through the
 * production fold under a frozen clock and fixed TZ. Every window is driven
 * twice into independent stores; the two outputs must be byte-identical or
 * the capture fails.
 *
 * Usage:
 *   bun packages/plugin/scripts/region-golden/capture.ts \
 *     [--host-db <path>] [--out <dir>]
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../packages/plugin/src/features/magic-context/storage";
import { readSystemRegion } from "../../packages/plugin/src/features/magic-context/system-region";
import {
    injectM0M1,
    type M0M1RenderOptions,
    type M0M1State,
} from "../../packages/plugin/src/hooks/magic-context/inject-compartments";
import { getTokenEstimatorFingerprint } from "../../packages/plugin/src/hooks/magic-context/read-session-formatting";
import { createTestTempDirFromPath } from "../../packages/plugin/src/shared/test-temp-dir";

const HERE = import.meta.dirname;
const PLUGIN_ROOT = join(HERE, "..", "..", "packages", "plugin");
const DEFAULT_HOST_DB = join(
    process.env.HOME ?? "",
    ".local/share/cortexkit/magic-context/context.db",
);
const DEFAULT_OUT = join(PLUGIN_ROOT, "test-data", "region-goldens");
const DEFAULT_93EEA_DOCS = "/Users/Sugaroverdose/Git/magic-context";
/** Compartment-heading dates render in the process timezone; pin it. */
const CAPTURE_TZ = "UTC";

const IDENTITY_7BB9 = "git:7bb955f9b83f5ef2d1d91cf9424ab2b3b0357f7a";
const IDENTITY_93EE = "git:93eea8cdeebd2eb57f476137abf32fa0c42cd3f5";

interface WindowSpec {
    id: string;
    kind: "real" | "fixture";
    sessionId: string;
    identity: string;
    /** Real 93eea windows read their docs from this directory; null = empty docs dir. */
    docsDirectory: string | null;
    fixture?: FixtureSeed;
}

interface FixtureSeed {
    memories: Array<Record<string, unknown>>;
    compartments: Array<Record<string, unknown>>;
    userMemories: Array<Record<string, unknown>>;
    projectState: Record<string, unknown> | null;
    docsFiles: Array<{ name: string; content: string }>;
    compactionOff: boolean;
    modelKey: string;
    memoryBudget: number;
    historyBudget: number;
}

const REAL_WINDOWS: WindowSpec[] = [
    // git:7bb955f9… windows: production folds carried NO <project-docs> (stored
    // regions begin at <user-profile>), so the faithful docs input is empty.
    { id: "r-7bb9-qwen-seq200", kind: "real", sessionId: "ses_f0d4730c3ffelZOaqhSCvxxA9I", identity: IDENTITY_7BB9, docsDirectory: null },
    { id: "r-7bb9-qwen-seq762", kind: "real", sessionId: "ses_f8d5630e9ffe62EbC0BG9dkwZJ", identity: IDENTITY_7BB9, docsDirectory: null },
    { id: "r-7bb9-qwen-seq554", kind: "real", sessionId: "ses_f8b53e409ffecyc3NfEitZF5ln", identity: IDENTITY_7BB9, docsDirectory: null },
    { id: "r-7bb9-qwen-seq574", kind: "real", sessionId: "ses_fb30aa731ffeUB4yhoFDG4TnYl", identity: IDENTITY_7BB9, docsDirectory: null },
    { id: "r-7bb9-qwen-seq2", kind: "real", sessionId: "ses_e586ad922ffevlFuTTQR5Y7CqL", identity: IDENTITY_7BB9, docsDirectory: null },
    // git:93eea8cd… (magic-context) windows: folds carried the repo docs.
    { id: "r-93ee-qwen-seq13", kind: "real", sessionId: "ses_e5a7715b9ffe4baaxvZGkl4DSm", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-qwen-seq19", kind: "real", sessionId: "ses_e5bfffa68ffe7F0sH0mGjOtcLV", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-qwen-seq4", kind: "real", sessionId: "ses_e57cbf229ffeIEjbM4KB1ieQGf", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-qwen-seq1", kind: "real", sessionId: "ses_e5a71f58effeuyNFemmUivLmcE", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-qwen-seq2a", kind: "real", sessionId: "ses_e56a256c2ffewMonj3v1xTSjof", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-qwen-seq2b", kind: "real", sessionId: "ses_e5e0c5abbffega7Vm41hiKALP1", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    // Zero-compartment windows across the three census model keys.
    { id: "r-93ee-glm-seq0", kind: "real", sessionId: "ses_e586f38adffeDl3uvi8uQHJ79d", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-glmfree-seq0", kind: "real", sessionId: "ses_e5a5c6481ffe0hmgahrW5Bud7X", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
    { id: "r-93ee-glmgo-seq0", kind: "real", sessionId: "ses_e568ec7a6ffed3N6u2wdlny6MU", identity: IDENTITY_93EE, docsDirectory: DEFAULT_93EEA_DOCS },
];

const MEMORY_NOW = 1_700_000_000_000;

function fixtureMemories(prefix: string): Array<Record<string, unknown>> {
    const mk = (id: number, category: string, content: string) => ({
        id,
        project_path: "__placeholder__",
        category,
        content,
        normalized_hash: createHash("sha256").update(content).digest("hex").slice(0, 32),
        importance: 50,
        scope: null,
        shareable: 0,
        source_session_id: null,
        source_type: "manual",
        seen_count: 1,
        retrieval_count: 0,
        first_seen_at: MEMORY_NOW + id,
        created_at: MEMORY_NOW + id,
        updated_at: MEMORY_NOW + id,
        last_seen_at: MEMORY_NOW + id,
        last_retrieved_at: null,
        status: "active",
        expires_at: null,
        verification_status: null,
        verified_at: null,
        classified_at: null,
        superseded_by_memory_id: null,
        merged_from: null,
        metadata_json: null,
        mural_cue: null,
        mural_cue_hash: null,
        mural_cue_at: null,
        mural_cue_rejection_count: 0,
    });
    return [
        mk(1, "PROJECT_RULES", `${prefix}: always run the battery before reporting done.`),
        mk(2, "ARCHITECTURE", `${prefix}: the transform runs in the hooks/magic-context runtime.`),
        mk(3, "CONSTRAINTS", `${prefix}: region bytes must never carry time or randomness.`),
        mk(4, "CONFIG_VALUES", `${prefix}: XDG_DATA_HOME selects the store directory.`),
        mk(5, "NAMING", `${prefix}: files are kebab-case; index.ts only at entry points.`),
    ];
}

function fixtureCompartments(sessionId: string): Array<Record<string, unknown>> {
    const mk = (id: number, sequence: number, title: string, p1: string) => ({
        id,
        session_id: sessionId,
        harness: "opencode",
        sequence,
        start_message: sequence * 10,
        end_message: sequence * 10 + 9,
        start_message_id: `msg_fix_${sequence}_a`,
        end_message_id: `msg_fix_${sequence}_b`,
        title,
        content: p1,
        p1,
        p2: `${p1} (detail tier two)`,
        p3: `${p1} (tier three)`,
        p4: `${p1} (tier four)`,
        importance: 50 + sequence,
        episode_type: "task",
        legacy: 0,
        created_at: MEMORY_NOW + sequence,
        rebase_status: "ok",
    });
    return [
        mk(1, 0, "Sever plan drafted", "Moved the panel renderers out of the fold entry."),
        mk(2, 1, "Carriage deleted", "Removed the synthetic-head prepend lanes."),
        mk(3, 2, "Battery green", "Full plugin battery passed at the tip."),
    ];
}

function fixtureUserMemories(): Array<Record<string, unknown>> {
    return [
        {
            id: 1,
            content: "Prefers terse, directive instructions with explicit constraints.",
            status: "active",
            promoted_at: MEMORY_NOW,
            source_candidate_ids: null,
            source_candidate_provenance: null,
            created_at: MEMORY_NOW,
            updated_at: MEMORY_NOW,
        },
    ];
}

const FIXTURE_WINDOWS: WindowSpec[] = [
    {
        id: "f-empty",
        kind: "fixture",
        sessionId: "ses_fixture_empty",
        identity: "dir:00000000000001",
        docsDirectory: null,
        fixture: {
            memories: [],
            compartments: [],
            userMemories: [],
            projectState: null,
            docsFiles: [],
            compactionOff: false,
            modelKey: "fixture/model-a",
            memoryBudget: 4000,
            historyBudget: 30000,
        },
    },
    {
        id: "f-rich",
        kind: "fixture",
        sessionId: "ses_fixture_rich",
        identity: "dir:00000000000002",
        docsDirectory: null,
        fixture: {
            memories: fixtureMemories("fixture-rich"),
            compartments: fixtureCompartments("ses_fixture_rich"),
            userMemories: fixtureUserMemories(),
            projectState: null,
            docsFiles: [
                { name: "ARCHITECTURE.md", content: "# Architecture\n\nFixture architecture body.\n" },
                { name: "STRUCTURE.md", content: "# Structure\n\nFixture structure body.\n" },
            ],
            compactionOff: false,
            modelKey: "fixture/model-a",
            memoryBudget: 4000,
            historyBudget: 30000,
        },
    },
    {
        id: "f-compaction-off",
        kind: "fixture",
        sessionId: "ses_fixture_compaction_off",
        identity: "dir:00000000000003",
        docsDirectory: null,
        fixture: {
            memories: fixtureMemories("fixture-compaction-off"),
            compartments: fixtureCompartments("ses_fixture_compaction_off"),
            userMemories: [],
            projectState: null,
            docsFiles: [
                {
                    name: "ARCHITECTURE.md",
                    content: "# Architecture\n\nCompaction-off fixture docs ride the region.\n",
                },
            ],
            compactionOff: true,
            modelKey: "fixture/model-a",
            memoryBudget: 4000,
            historyBudget: 30000,
        },
    },
];

function encodeJsonValue(value: unknown): unknown {
    if (value instanceof Uint8Array) return { __b64: Buffer.from(value).toString("base64") };
    return value;
}

function extractRows(
    host: Database,
    sql: string,
    ...args: unknown[]
): Array<Record<string, unknown>> {
    const rows = host.query(sql).all(...(args as never[])) as Array<Record<string, unknown>>;
    return rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(row)) out[key] = encodeJsonValue(value);
        return out;
    });
}

function tableColumns(db: Database, table: string): string[] {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (row) => row.name,
    );
}

function insertRows(db: Database, table: string, rows: Array<Record<string, unknown>>): void {
    if (rows.length === 0) return;
    const target = new Set(tableColumns(db, table));
    const columns = Object.keys(rows[0]).filter((name) => target.has(name));
    if (columns.length === 0) return;
    const placeholders = columns.map(() => "?").join(", ");
    const statement = db.prepare(
        `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`,
    );
    for (const row of rows) {
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

function clearCachedPrefixColumns(meta: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(meta)) {
        clean[column] =
            column.startsWith("cached_m0_") || column.startsWith("cached_m1_") ? null : value;
    }
    return clean;
}

interface ParsedIdentity {
    memoryBudget: number;
    historyBudget: number;
    historyPolicyIdentity: string | undefined;
    muralEnabled: boolean;
}

function parseStoredUpgradeIdentity(value: string | null): ParsedIdentity {
    const fallback: ParsedIdentity = {
        memoryBudget: 4000,
        historyBudget: 60000,
        historyPolicyIdentity: undefined,
        muralEnabled: false,
    };
    if (!value) return fallback;
    const parts = new Map<string, string>();
    for (const segment of value.split("|")) {
        const index = segment.indexOf(":");
        if (index > 0) parts.set(segment.slice(0, index), segment.slice(index + 1));
    }
    const budgets = parts.get("render-budgets") ?? "";
    const rendered = parts.get("rendered-budgets") ?? "";
    const memoryMatch = budgets.match(/^m(\d+(?:\.\d+)?)-h/);
    const policyMatch = budgets.match(/-h(.+)$/);
    const renderedMatch = rendered.match(/-h(\d+(?:\.\d+)?)$/);
    return {
        memoryBudget: memoryMatch ? Number(memoryMatch[1]) : fallback.memoryBudget,
        historyBudget: renderedMatch ? Number(renderedMatch[1]) : fallback.historyBudget,
        historyPolicyIdentity:
            policyMatch && policyMatch[1] && !/^\d+(?:\.\d+)?$/.test(policyMatch[1])
                ? policyMatch[1]
                : undefined,
        muralEnabled: parts.get("mural-enabled") === "1",
    };
}

interface WindowExtraction {
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
    storedRegionSha256: string | null;
}

function extractRealWindow(host: Database, spec: WindowSpec): WindowExtraction {
    const meta = host
        .query("SELECT * FROM session_meta WHERE session_id = ?")
        .get(spec.sessionId) as Record<string, unknown> | undefined;
    if (!meta) throw new Error(`${spec.id}: session ${spec.sessionId} missing from host db`);
    const stored = meta.cached_m0_bytes;
    const storedBlob = stored instanceof Uint8Array ? Buffer.from(stored) : null;
    if (!storedBlob || !storedBlob.toString("utf8").startsWith("<!-- mc:system-region v1 -->")) {
        throw new Error(`${spec.id}: stored row is not a region row — refuse to capture`);
    }
    if (meta.cached_m0_project_identity !== spec.identity) {
        throw new Error(
            `${spec.id}: identity drift ${String(meta.cached_m0_project_identity)} != ${spec.identity}`,
        );
    }
    return {
        sessionMeta: clearCachedPrefixColumns(meta),
        compartments: extractRows(
            host,
            "SELECT * FROM compartments WHERE session_id = ?",
            spec.sessionId,
        ),
        rowidMap: extractRows(
            host,
            "SELECT * FROM message_fts_rowid_map WHERE session_id = ?",
            spec.sessionId,
        ),
        m0Mutations: extractRows(
            host,
            "SELECT * FROM m0_mutation_log WHERE session_id = ?",
            spec.sessionId,
        ),
        sessionProjects: extractRows(
            host,
            "SELECT * FROM session_projects WHERE session_id = ?",
            spec.sessionId,
        ),
        memories: sharedCache.get(spec.identity)?.memories ?? [],
        memoryMutations: sharedCache.get(spec.identity)?.memoryMutations ?? [],
        userMemories: sharedUserMemories,
        projectState: sharedProjectState,
        modelKey: String(meta.cached_m0_model_key ?? ""),
        storedRegionSha256: createHash("sha256").update(storedBlob).digest("hex"),
    };
}

function buildFixtureWindow(spec: WindowSpec): WindowExtraction {
    const fx = spec.fixture;
    if (!fx) throw new Error(`${spec.id}: fixture seed missing`);
    return {
        sessionMeta: {
            session_id: spec.sessionId,
            harness: "opencode",
            is_subagent: 0,
            last_response_time: 0,
        },
        compartments: fx.compartments,
        rowidMap: [],
        m0Mutations: [],
        sessionProjects: [
            {
                session_id: spec.sessionId,
                harness: "opencode",
                project_path: spec.identity,
                updated_at: MEMORY_NOW,
            },
        ],
        memories: fx.memories.map((row) => ({ ...row, project_path: spec.identity })),
        memoryMutations: [],
        userMemories: fx.userMemories,
        projectState: fx.projectState ? [fx.projectState] : [],
        modelKey: fx.modelKey,
        storedRegionSha256: null,
    };
}

function driveOnce(
    spec: WindowSpec,
    extraction: WindowExtraction,
    docsFiles: Array<{ name: string; content: string }>,
    parsed: ParsedIdentity,
    frozenNowMs: number,
): Buffer {
    const dataHome = createTestTempDirFromPath(join(tmpdir(), "mc-region-golden-home"));
    const docsDir = join(dataHome, "docs");
    process.env.XDG_DATA_HOME = dataHome;
    process.env.TZ = CAPTURE_TZ;
    const originalNow = Date.now;
    try {
        mkdirSync(docsDir, { recursive: true });
        for (const file of docsFiles) {
            writeFileSync(join(docsDir, file.name), file.content, "utf8");
        }
        const db = openDatabase();
        if (!db) throw new Error(`${spec.id}: openDatabase returned null`);
        insertRows(db, "session_meta", [extraction.sessionMeta]);
        insertRows(db, "compartments", extraction.compartments);
        insertRows(db, "message_fts_rowid_map", extraction.rowidMap);
        insertRows(db, "m0_mutation_log", extraction.m0Mutations);
        insertRows(db, "session_projects", extraction.sessionProjects);
        insertRows(db, "memories", extraction.memories);
        insertRows(db, "memory_mutation_log", extraction.memoryMutations);
        insertRows(db, "user_memories", extraction.userMemories);
        insertRows(db, "project_state", extraction.projectState);
        const state = getOrCreateSessionMeta(db, spec.sessionId) as unknown as M0M1State;
        const options: M0M1RenderOptions = {
            db,
            sessionId: spec.sessionId,
            state,
            projectPath: spec.identity,
            projectDirectory: docsDir,
            injectDocs: true,
            memoryEnabled: true,
            memoryInjectionBudgetTokens: parsed.memoryBudget,
            historyBudgetTokens: parsed.historyBudget,
            historyBudgetPolicyIdentity: parsed.historyPolicyIdentity,
            temporalAwareness: true,
            isCacheBustingPass: true,
            muralEnabled: parsed.muralEnabled,
            compactionOff: spec.fixture?.compactionOff ?? false,
            hardSignals: {
                systemHash: "",
                toolSetHash: "",
                modelKey: extraction.modelKey,
                cacheExpired: true,
                lastResponseTime: 0,
            },
            systemRegion: { enabled: true, reason: "golden_capture" },
        };
        Date.now = () => frozenNowMs;
        injectM0M1(options);
        const region = readSystemRegion(db, spec.sessionId);
        if (region === null) throw new Error(`${spec.id}: no sentinel-valid region installed`);
        return Buffer.from(region, "utf8");
    } finally {
        Date.now = originalNow;
        closeDatabase();
        delete process.env.XDG_DATA_HOME;
        rmSync(dataHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
}

const sharedCache = new Map<
    string,
    { memories: Array<Record<string, unknown>>; memoryMutations: Array<Record<string, unknown>> }
>();
let sharedUserMemories: Array<Record<string, unknown>> = [];
let sharedProjectState: Array<Record<string, unknown>> = [];

function gzipJson(value: unknown): Buffer {
    return gzipSync(Buffer.from(JSON.stringify(value), "utf8"), { mtime: 0 });
}

interface CorpusWindow {
    id: string;
    docsSource: string;
    modelKey: string;
    budgets: {
        memoryInjectionBudgetTokens: number;
        historyBudgetTokens: number;
        historyBudgetPolicyIdentity: string | null;
    };
    muralEnabled: boolean;
    frozenNowMs: number;
    seedFile: string;
    docsFile: string | null;
}

interface CorpusManifest {
    windows: CorpusWindow[];
}

function gunzipJson(path: string): unknown {
    return JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
}

/**
 * Re-drive a window from the committed corpus inputs (seed rows, shared
 * snapshots, docs bytes, budgets, frozen clock) instead of the live host db.
 * A re-capture over an unchanged corpus must therefore differ from the
 * committed bytes only where the code changed — which is what the golden
 * attribution rule requires (a golden that moved for any other reason stops
 * the lane).
 */
function resolveFromCorpus(
    corpus: CorpusManifest,
    corpusDir: string,
    spec: WindowSpec,
): {
    extraction: WindowExtraction;
    docsFiles: Array<{ name: string; content: string }>;
    docsSource: string;
    parsed: ParsedIdentity;
    frozenNowMs: number;
} {
    const w = corpus.windows.find((candidate) => candidate.id === spec.id);
    if (!w) throw new Error(`${spec.id}: window missing from the corpus manifest`);
    let extraction: WindowExtraction;
    let docsFiles: Array<{ name: string; content: string }>;
    let parsed: ParsedIdentity;
    if (spec.kind === "fixture") {
        // Fixtures are code-defined: the seed on disk was written from the
        // same code, so drive from the spec (the docs inline in the fixture
        // are the input of record).
        extraction = buildFixtureWindow(spec);
        docsFiles = spec.fixture?.docsFiles ?? [];
        parsed = {
            memoryBudget: spec.fixture?.memoryBudget ?? 4000,
            historyBudget: spec.fixture?.historyBudget ?? 30000,
            historyPolicyIdentity: undefined,
            muralEnabled: false,
        };
    } else {
        const seed = gunzipJson(join(corpusDir, w.seedFile)) as WindowExtraction;
        const slug = spec.identity.replace(/[^a-z0-9]/g, "").slice(0, 12);
        extraction = {
            ...seed,
            memories: gunzipJson(join(corpusDir, "shared", `memories-${slug}.json.gz`)) as Array<
                Record<string, unknown>
            >,
            memoryMutations: gunzipJson(
                join(corpusDir, "shared", `memory-mutation-log-${slug}.json.gz`),
            ) as Array<Record<string, unknown>>,
            userMemories: gunzipJson(join(corpusDir, "shared", "user-memories.json.gz")) as Array<
                Record<string, unknown>
            >,
            projectState: gunzipJson(join(corpusDir, "shared", "project-state.json.gz")) as Array<
                Record<string, unknown>
            >,
        };
        docsFiles = w.docsFile
            ? ((gunzipJson(join(corpusDir, w.docsFile)) as { files: Array<{ name: string; content: string }> }).files ?? [])
            : [];
        parsed = {
            memoryBudget: w.budgets.memoryInjectionBudgetTokens,
            historyBudget: w.budgets.historyBudgetTokens,
            historyPolicyIdentity: w.budgets.historyBudgetPolicyIdentity ?? undefined,
            muralEnabled: !!w.muralEnabled,
        };
    }
    return { extraction, docsFiles, docsSource: w.docsSource, parsed, frozenNowMs: w.frozenNowMs };
}

function copyRealDocs(docsDirectory: string): Array<{ name: string; content: string }> {
    const copied: Array<{ name: string; content: string }> = [];
    for (const name of ["ARCHITECTURE.md", "STRUCTURE.md"]) {
        const source = join(docsDirectory, name);
        if (!existsSync(source)) continue;
        copied.push({ name, content: readFileSync(source, "utf8") });
    }
    return copied;
}

function main(): void {
    const argv = process.argv.slice(2);
    const argValue = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const hostDbPath = argValue("--host-db") ?? DEFAULT_HOST_DB;
    const outDir = argValue("--out") ?? DEFAULT_OUT;
    const corpusDir = argValue("--from-corpus");
    if (corpusDir && outDir === corpusDir) {
        throw new Error("--from-corpus must differ from --out (the corpus is read through)");
    }
    const corpus = corpusDir
        ? (JSON.parse(
              readFileSync(join(corpusDir, "manifest.json"), "utf8"),
          ) as CorpusManifest)
        : null;
    const host = corpusDir ? null : new Database(hostDbPath, { readonly: true });

    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(join(outDir, "bytes"), { recursive: true });
    mkdirSync(join(outDir, "windows"), { recursive: true });
    mkdirSync(join(outDir, "shared"), { recursive: true });

    if (host) {
        sharedUserMemories = extractRows(host, "SELECT * FROM user_memories");
        sharedProjectState = extractRows(host, "SELECT * FROM project_state");
    }
    const identities = new Set<string>(REAL_WINDOWS.map((window) => window.identity));
    for (const identity of identities) {
        if (!host) break;
        sharedCache.set(identity, {
            memories: extractRows(
                host,
                "SELECT * FROM memories WHERE project_path = ?",
                identity,
            ),
            memoryMutations: extractRows(
                host,
                "SELECT * FROM memory_mutation_log WHERE project_path = ?",
                identity,
            ),
        });
    }

    const manifestWindows: Array<Record<string, unknown>> = [];
    // A corpus-driven re-capture must reproduce the committed package's clock,
    // so the frozen instant comes from the corpus, not from the wall.
    let frozenNowMs = 0;

    for (const spec of [...REAL_WINDOWS, ...FIXTURE_WINDOWS]) {
        let extraction: WindowExtraction;
        let docsFiles: Array<{ name: string; content: string }>;
        let docsSource: string;
        let parsed: ParsedIdentity;
        if (corpus) {
            const inputs = resolveFromCorpus(corpus, corpusDir!, spec);
            extraction = inputs.extraction;
            docsFiles = inputs.docsFiles;
            docsSource = inputs.docsSource;
            parsed = inputs.parsed;
            if (frozenNowMs === 0) frozenNowMs = inputs.frozenNowMs;
        } else {
            if (!host) throw new Error("no host database");
            extraction = extractRealWindow(host, spec);
            if (spec.kind === "fixture") {
                docsFiles = spec.fixture?.docsFiles ?? [];
                docsSource = "fixture-inline";
            } else if (spec.docsDirectory) {
                docsFiles = copyRealDocs(spec.docsDirectory);
                docsSource = spec.docsDirectory;
            } else {
                docsFiles = [];
                docsSource = "empty";
            }
            parsed =
                spec.kind === "real"
                    ? parseStoredUpgradeIdentity(
                          (
                              host
                                  .query(
                                      "SELECT cached_m0_upgrade_state FROM session_meta WHERE session_id = ?",
                                  )
                                  .get(spec.sessionId) as {
                                  cached_m0_upgrade_state: string | null;
                              }
                          ).cached_m0_upgrade_state,
                      )
                    : {
                          memoryBudget: spec.fixture?.memoryBudget ?? 4000,
                          historyBudget: spec.fixture?.historyBudget ?? 30000,
                          historyPolicyIdentity: undefined,
                          muralEnabled: false,
                      };
            if (frozenNowMs === 0) frozenNowMs = Date.now();
        }

        // Determinism self-check: two independent temp stores, byte-identical.
        const first = driveOnce(spec, extraction, docsFiles, parsed, frozenNowMs);
        const second = driveOnce(spec, extraction, docsFiles, parsed, frozenNowMs);
        if (!first.equals(second)) {
            throw new Error(`${spec.id}: capture not deterministic across runs`);
        }

        writeFileSync(join(outDir, "bytes", `${spec.id}.region`), first);
        // Project-scoped rows live once under shared/ (keyed by identity); the
        // per-window seed carries only session-scoped rows to keep the package
        // lean. Real windows read the shared tables through the same identity
        // at replay; fixtures are self-contained inline.
        const seedForDisk: WindowExtraction =
            spec.kind === "real"
                ? {
                      ...extraction,
                      memories: [],
                      memoryMutations: [],
                      userMemories: [],
                      projectState: [],
                  }
                : extraction;
        writeFileSync(
            join(outDir, "windows", `${spec.id}.seed.json.gz`),
            gzipJson(seedForDisk),
        );
        if (docsFiles.length > 0) {
            writeFileSync(
                join(outDir, "windows", `${spec.id}.docs.json.gz`),
                gzipJson({ files: docsFiles }),
            );
        }

        const m1Placeholder = first.toString("utf8").endsWith(
            "\n\n<session-history-since>(no new content since last materialization)</session-history-since>",
        );
        manifestWindows.push({
            id: spec.id,
            kind: spec.kind,
            sessionId: spec.sessionId,
            identity: spec.identity,
            docsSource,
            docsFiles: docsFiles.map((file) => file.name),
            modelKey: extraction.modelKey,
            budgets: {
                memoryInjectionBudgetTokens: parsed.memoryBudget,
                historyBudgetTokens: parsed.historyBudget,
                historyBudgetPolicyIdentity: parsed.historyPolicyIdentity ?? null,
            },
            muralEnabled: parsed.muralEnabled,
            compactionOff: spec.fixture?.compactionOff ?? false,
            temporalAwareness: true,
            memoryEnabled: true,
            injectDocs: true,
            frozenNowMs,
            timezone: CAPTURE_TZ,
            estimatorFingerprint: getTokenEstimatorFingerprint(),
            regionFile: `bytes/${spec.id}.region`,
            regionSha256: createHash("sha256").update(first).digest("hex"),
            regionByteLength: first.length,
            m1PlaceholderHalf: m1Placeholder,
            storedRegionSha256: extraction.storedRegionSha256,
            seedFile: `windows/${spec.id}.seed.json.gz`,
            docsFile: docsFiles.length > 0 ? `windows/${spec.id}.docs.json.gz` : null,
        });
        console.log(
            `${spec.id}: ${first.length} bytes m1Placeholder=${m1Placeholder} sha=${createHash("sha256").update(first).digest("hex").slice(0, 16)}`,
        );
    }

    for (const identity of identities) {
        const shared = sharedCache.get(identity);
        if (!shared) continue;
        const short = identity.replace(/[^a-z0-9]/g, "").slice(0, 12);
        writeFileSync(join(outDir, "shared", `memories-${short}.json.gz`), gzipJson(shared.memories));
        writeFileSync(
            join(outDir,
                "shared",
                `memory-mutation-log-${short}.json.gz`),
            gzipJson(shared.memoryMutations),
        );
    }
    if (corpus) {
        // Corpus-driven re-capture: the shared row snapshots and the per-window
        // seeds are the committed inputs — copy them through unchanged so the
        // only possible byte movement is in the rendered regions.
        for (const dir of ["shared", "windows"] as const) {
            for (const name of readdirSync(join(corpusDir!, dir))) {
                writeFileSync(
                    join(outDir, dir, name),
                    readFileSync(join(corpusDir!, dir, name)),
                );
            }
        }
    } else {
        writeFileSync(join(outDir, "shared", "user-memories.json.gz"), gzipJson(sharedUserMemories));
        writeFileSync(join(outDir, "shared", "project-state.json.gz"), gzipJson(sharedProjectState));
    }

    const commit = Bun.spawnSync(["git", "-C", PLUGIN_ROOT, "rev-parse", "HEAD"])
        .stdout.toString()
        .trim();
    writeFileSync(
        join(outDir, "manifest.json"),
        JSON.stringify(
            {
                schemaVersion: 1,
                capturedAt: new Date(frozenNowMs).toISOString(),
                captureCommit: commit,
                hostDb: corpus ? `corpus:${corpusDir}` : hostDbPath,
                timezone: CAPTURE_TZ,
                estimatorFingerprint: getTokenEstimatorFingerprint(),
                windows: manifestWindows,
            },
            null,
            2,
        ),
    );
    host?.close();
    console.log(`wrote ${manifestWindows.length} windows to ${outDir}`);
}

main();
