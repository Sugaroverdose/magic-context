/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { rmSync } from "node:fs";

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

import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import {
    decodeSystemRegionRow,
    readSystemRegion,
    SYSTEM_REGION_SENTINEL,
} from "../../features/magic-context/system-region";
import { Database } from "../../shared/sqlite";
import { materializeM0 } from "./inject-compartments";

const SESSION_ID = "ses_region_fold";
const PROJECT_PATH = "/tmp/test-region-fold";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

function makeDb(): Database {
    const d = new Database(":memory:");
    initializeDatabase(d);
    getOrCreateSessionMeta(d, SESSION_ID);
    return d;
}

afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
    lines.length = 0;
});

function seedPanels(db: Database): void {
    insertMemory(db, {
        projectPath: PROJECT_PATH,
        category: "ARCHITECTURE",
        content: "the region owns the panels after residency",
    });
}

function row(db: Database): {
    cached_m0_bytes: Uint8Array | null;
    cached_m1_bytes: Uint8Array | null;
    cached_m0_max_memory_id: number | null;
} {
    return db
        .prepare(
            "SELECT cached_m0_bytes, cached_m1_bytes, cached_m0_max_memory_id FROM session_meta WHERE session_id = ?",
        )
        .get(SESSION_ID) as {
        cached_m0_bytes: Uint8Array | null;
        cached_m1_bytes: Uint8Array | null;
        cached_m0_max_memory_id: number | null;
    };
}

describe("system-region fold: materialization boundary installs the region", () => {
    it("gate on: the fold writes the sentinel region (m0 + m1 concatenated), clears m1, captures markers, prints the receipt", () => {
        const db = makeDb();
        seedPanels(db);
        const result = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegion: { enabled: true, reason: "first_render" },
        });
        const stored = row(db);
        expect(stored.cached_m0_bytes).not.toBeNull();
        const served = readSystemRegion(db, SESSION_ID);
        // Assemble-once law: the served region is exactly the concatenation of
        // what this fold rendered for the two panels — never a second render.
        expect(served).toBe(`${result.m0Text}\n\n${result.m1Text}`);
        expect(served).toContain("the region owns the panels after residency");
        // m[1] has no separate slot in region mode; its bytes live in the region.
        expect(stored.cached_m1_bytes).toBeNull();
        // Markers are captured with the region (decide compares against these).
        expect(stored.cached_m0_max_memory_id).toBe(result.snapshotMarkers.maxMemoryId);
        expect(
            lines.some((line) =>
                line.includes("system-region rotation: reason=first_render executed=true"),
            ),
        ).toBe(true);
    });

    it("gate off (control): today's head bytes persist unchanged, no sentinel, no receipt", () => {
        const db = makeDb();
        seedPanels(db);
        const result = materializeM0({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
        });
        const stored = row(db);
        const m0 = Buffer.from(stored.cached_m0_bytes!).toString("utf8");
        expect(m0).toBe(result.m0Text);
        expect(m0).not.toContain(SYSTEM_REGION_SENTINEL);
        expect(Buffer.from(stored.cached_m1_bytes!).toString("utf8")).toBe(result.m1Text);
        expect(lines.some((line) => line.includes("system-region rotation"))).toBe(false);
        // And the honest reader says: this is not a region.
        expect(readSystemRegion(db, SESSION_ID)).toBeNull();
    });

    it("R11 boot law: a legacy raw row is never served, and the next gated fold replaces it with the region", () => {
        const db = makeDb();
        seedPanels(db);
        // A row written by the head lane yesterday (raw m[0] bytes, no sentinel).
        db.prepare("UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?").run(
            Buffer.from("<session-history>legacy baseline bytes</session-history>", "utf8"),
            SESSION_ID,
        );
        expect(readSystemRegion(db, SESSION_ID)).toBeNull();
        expect(decodeSystemRegionRow(Buffer.from("legacy", "utf8"))).toBeNull();

        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegion: { enabled: true, reason: "first_render" },
        });
        const served = readSystemRegion(db, SESSION_ID);
        expect(served).not.toContain("legacy baseline bytes");
        expect(served).toContain("the region owns the panels after residency");
    });

    it("the region write is atomic with the memory_block identity the head fold persists", () => {
        const db = makeDb();
        seedPanels(db);
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegion: { enabled: true, reason: "first_render" },
        });
        // Same-transaction law: the region bytes and their id manifest never
        // diverge (the AFT "Injected 256" lesson).
        const meta = db
            .prepare(
                "SELECT memory_block_count, memory_block_ids, cached_m0_bytes FROM session_meta WHERE session_id = ?",
            )
            .get(SESSION_ID) as {
            memory_block_count: number;
            memory_block_ids: string;
            cached_m0_bytes: Uint8Array;
        };
        expect(meta.memory_block_count).toBeGreaterThan(0);
        expect(JSON.parse(meta.memory_block_ids).length).toBe(meta.memory_block_count);
        expect(
            Buffer.from(meta.cached_m0_bytes).toString("utf8").startsWith(SYSTEM_REGION_SENTINEL),
        ).toBe(true);
    });
});

describe("system-region receipts: store-derived operands cannot wedge the fold lane (H1)", () => {
    const OPERAND = `evil operand\twith spaces and ${"x".repeat(200)} trailing`;

    it("a corrupt stored budget identity mints a receipt-safe reason; the fold proceeds and self-heals", () => {
        const db = makeDb();
        seedPanels(db);
        materializeM0({
            db,
            sessionId: SESSION_ID,
            state: getOrCreateSessionMeta(db, SESSION_ID),
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegion: { enabled: true, reason: "first_render" },
        });
        // Corrupt only the render-budgets operand the budget arm interpolates
        // verbatim; every other component stays as the healthy fold wrote it.
        const stored = (
            db
                .prepare("SELECT cached_m0_upgrade_state AS v FROM session_meta WHERE session_id = ?")
                .get(SESSION_ID) as { v: string | null }
        ).v!;
        expect(stored).toContain("|render-budgets:");
        db.prepare("UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?").run(
            stored.replace(/(\|render-budgets:)[^|]*/, `$1${OPERAND}`),
            SESSION_ID,
        );
        const state = getOrCreateSessionMeta(db, SESSION_ID);
        const { mustMaterialize } = require("./inject-compartments") as {
            mustMaterialize: (a: never) => { value: boolean; reason: string | null };
        };
        const decision = mustMaterialize({
            db,
            sessionId: SESSION_ID,
            state,
            projectPath: PROJECT_PATH,
            projectDirectory: "",
            systemRegionMode: true,
        } as never);
        expect(decision.value).toBe(true);
        expect(decision.reason).toStartWith("render_config:budget(");
        // Mint-site sanitization: the reason is receipt-safe — no whitespace,
        // clamped length, grammar-valid for the funnel.
        expect(decision.reason).not.toMatch(/\s/);
        expect(decision.reason.length).toBeLessThanOrEqual(48 + 1 + 120);
        // The fold lane proceeds with this reason: no throw inside the
        // materialization transaction, rotation installed, receipt carries the
        // sanitized token.
        expect(() =>
            materializeM0({
                db,
                sessionId: SESSION_ID,
                state: getOrCreateSessionMeta(db, SESSION_ID),
                projectPath: PROJECT_PATH,
                projectDirectory: "",
                systemRegion: { enabled: true, reason: decision.reason! },
            }),
        ).not.toThrow();
        expect(readSystemRegion(db, SESSION_ID)).not.toBeNull();
        expect(
            lines.some(
                (line) =>
                    line.startsWith("system-region rotation:") &&
                    line.includes(`reason=${decision.reason}`) &&
                    line.includes("executed=true"),
            ),
        ).toBe(true);
        // Self-heal: the successful rewrite replaced the corrupt operand.
        const healed = getOrCreateSessionMeta(db, SESSION_ID);
        expect(healed.cachedM0UpgradeState ?? "").not.toContain("evil");
        expect(healed.cachedM0UpgradeState ?? "").not.toMatch(/render-budgets:\S*\s/);
    });

    it("the shrink arm is parser-gated: a whitespace-bearing stored operand can never mint", async () => {
        const { renderedBudgetShrinkReason } = await import("./compartment-render-epoch");
        // Baseline: clean operands fire and mint a whitespace-free token.
        const clean = renderedBudgetShrinkReason("m1000-h60000", "m900-h60000");
        expect(clean).toStartWith("render_config:budget_shrink(");
        expect(clean).not.toMatch(/\s/);
        // The mint is reachable only for operands matching ^m\d+(\.\d+)?-h\d+$
        // — a corrupt (whitespace/oversize/garbage) stored operand is rejected
        // by the parser, so this arm structurally cannot emit store text.
        expect(renderedBudgetShrinkReason("m 1000-h60000", "m900-h60000")).toBeNull();
        expect(renderedBudgetShrinkReason(`m${"9".repeat(400)}-h1`, "m900-h60000")).toBeNull();
        expect(renderedBudgetShrinkReason("garbage", "m900-h60000")).toBeNull();
    });
});
