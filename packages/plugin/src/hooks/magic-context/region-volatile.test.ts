/// <reference types="bun-types" />

/**
 * Unit 2 Task 1 — the volatile segment carrier (region-only migration plan
 * Task 1, re-sequenced first per GLM round 1 A4).
 *
 * The volatile segment is the only non-H delta carrier: delta-class content
 * (memory mutations, compartments published after the region capture, memories
 * that overflow the frozen region panel, profile deltas, docs deltas) renders
 * into a small segment stored beside the region and served at the tail of
 * system[0] AFTER the region bytes. Region and volatile bytes are pure
 * functions of the store up to the captured watermark — zero time, zero
 * random, replay-only: every non-bust pass decodes persisted bytes.
 *
 * Law attack shape (constitution #2644): each law mutates the store AFTER the
 * volatile capture and proves the serve did not follow (replay-only), or
 * plants a real-writer delta and proves the named carrier puts the exact
 * content class on the wire.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import {
    closeDatabase,
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getOrCreateSessionMeta,
    openDatabase,
    readProjectDocsCanonical,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { writeRegionVolatile } from "../../features/magic-context/storage-meta-shared";
import { encodeSystemRegionRow } from "../../features/magic-context/system-region";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import {
    clearCtxReduceAvailability,
    resolveCtxReduceAvailabilityFromMessages,
} from "./ctx-reduce-availability";
import {
    buildRenderOptions,
    loadManifest,
    type SeededWindow,
    seedWindow,
} from "./region-golden-harness";
import { getGlobalUserProfileVersion } from "./region-render";
import {
    type RegionVolatileWatermark,
    renderRegionVolatile,
    serveRegionVolatile,
} from "./region-volatile";
import { createSystemPromptHashHandler } from "./system-prompt-hash";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTz = process.env.TZ;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalTz !== undefined) process.env.TZ = originalTz;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* Ignore EBUSY on Windows */
        }
    }
    tempDirs.length = 0;
    clearCtxReduceAvailability("ses-vol-serve");
});

function freshSeed(): { seeded: SeededWindow; window: ReturnType<typeof pickWindow> } {
    const manifest = loadManifest();
    const window = pickWindow(manifest);
    const seeded = seedWindow(window, manifest);
    tempDirs.push(seeded.dataHome);
    return { seeded, window };
}

function pickWindow(manifest: ReturnType<typeof loadManifest>) {
    const win = manifest.windows.find((w) => w.id === "f-rich");
    if (!win) throw new Error("f-rich window missing from the golden manifest");
    return win;
}

/**
 * The region-captured watermark, derived from the seeded store: every cursor
 * sits at the store's current maxima (the state the fold captured), with
 * per-law overrides for exactly the fields the law moves past the capture.
 * `materializedAt` is a far-future constant so every seeded row is visible
 * through the asOf gate (mirror of the fold's materialized-at).
 */
function watermarkFor(
    seeded: SeededWindow,
    window: { sessionId: string; identity: string; docsFile?: string },
    over: Partial<RegionVolatileWatermark> = {},
): RegionVolatileWatermark {
    const db = seeded.db;
    const maxSeq = (
        db
            .prepare(
                "SELECT COALESCE(MAX(sequence), 0) AS m FROM compartments WHERE session_id = ?",
            )
            .get(window.sessionId) as { m: number }
    ).m;
    const maxMem = (
        db
            .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM memories WHERE project_path = ?")
            .get(window.identity) as { m: number }
    ).m;
    const maxMut = (
        db
            .prepare(
                "SELECT COALESCE(MAX(id), 0) AS m FROM memory_mutation_log WHERE project_path = ?",
            )
            .get(window.identity) as { m: number }
    ).m;
    return {
        maxMemoryId: maxMem,
        maxCompartmentSeq: maxSeq,
        maxMemoryMutationId: maxMut,
        projectUserProfileVersion: getGlobalUserProfileVersion(db),
        projectDocsHash: window.docsFile
            ? readProjectDocsCanonical(seeded.docsDir).canonicalHash
            : "",
        materializedAt: 4102444800000,
        renderedMemoryIds: [],
        ...over,
    };
}

describe("region-volatile: render contract", () => {
    it("renders nothing when the watermark equals the current store cursors", () => {
        const { seeded, window } = freshSeed();
        const options = buildRenderOptions(window, seeded);
        const out = renderRegionVolatile(options, watermarkFor(seeded, window));
        expect(out.text).toBe("");
        expect(out.memoryUpdateCount).toBe(0);
        expect(out.compartmentCount).toBe(0);
    });

    it("is deterministic: the same store state renders byte-identical bytes twice", () => {
        const { seeded, window } = freshSeed();
        const options = buildRenderOptions(window, seeded);
        const wm = watermarkFor(seeded, window);
        // Plant deltas so the render is non-trivial, then render twice.
        insertMemory(seeded.db, {
            projectPath: window.identity,
            category: "ARCHITECTURE",
            content: "volatile determinism fact",
            sourceType: "historian",
        });
        const first = renderRegionVolatile(options, wm).text;
        const second = renderRegionVolatile(options, wm).text;
        expect(first).not.toBe("");
        expect(second).toBe(first);
    });

    it("carries the <memory-updates> class for mutations newer than the captured cursor", () => {
        const { seeded, window } = freshSeed();
        const options = buildRenderOptions(window, seeded);
        // Real writers: the production memory insert for the region-rendered
        // baseline, then an update row in memory_mutation_log beyond the
        // captured cursor.
        const baseline = insertMemory(seeded.db, {
            projectPath: window.identity,
            category: "CONSTRAINTS",
            content: "baseline content before update",
            sourceType: "historian",
        });
        const wm = watermarkFor(seeded, window, { renderedMemoryIds: [baseline.id] });
        seeded.db
            .prepare(
                `INSERT INTO memory_mutation_log
                 (project_path, target_memory_id, mutation_type, new_content, category, queued_at)
                 VALUES (?, ?, 'update', 'updated content sighting', 'CONSTRAINTS', 2)`,
            )
            .run(window.identity, baseline.id);
        const out = renderRegionVolatile(options, wm);
        expect(out.text).toContain("<memory-updates>");
        expect(out.text).toContain(`<updated id="${baseline.id}"`);
        expect(out.text).toContain("updated content sighting");
        expect(out.memoryUpdateCount).toBe(1);
    });

    it("carries the overflow set: memories beyond the frozen region panel render as <new-memories>", () => {
        const { seeded, window } = freshSeed();
        const options = buildRenderOptions(window, seeded);
        const wm = watermarkFor(seeded, window);
        insertMemory(seeded.db, {
            projectPath: window.identity,
            category: "PROJECT_RULES",
            content: "overflowed memory sighting text",
            sourceType: "historian",
        });
        const out = renderRegionVolatile(options, wm);
        expect(out.text).toContain("<new-memories>");
        expect(out.text).toContain("overflowed memory sighting text");
    });

    it("carries the profile delta when the profile version moved past the capture", () => {
        const { seeded, window } = freshSeed();
        const options = buildRenderOptions(window, seeded);
        const wm = watermarkFor(seeded, window);
        seeded.db
            .prepare(
                `INSERT INTO user_memories (content, status, promoted_at, created_at, updated_at)
                 VALUES ('profile delta sighting', 'active', 1, 1, 1)`,
            )
            .run();
        seeded.db
            .prepare(
                `INSERT INTO project_state (project_path, project_user_profile_version, updated_at)
                 VALUES (?, 1, 1)
                 ON CONFLICT(project_path) DO UPDATE SET
                     project_user_profile_version = project_user_profile_version + 1`,
            )
            .run(GLOBAL_USER_PROFILE_PROJECT_PATH);
        const out = renderRegionVolatile(options, wm);
        expect(out.text).toContain("<new-user-profile>");
        expect(out.text).toContain("profile delta sighting");
    });

    it("carries compartments published after the capture inside <session-history-since>", () => {
        const { seeded, window } = freshSeed();
        const options = buildRenderOptions(window, seeded);
        const wm = watermarkFor(seeded, window);
        const maxSeq = seeded.db
            .prepare(
                "SELECT COALESCE(MAX(sequence), 0) AS m FROM compartments WHERE session_id = ?",
            )
            .get(window.sessionId) as { m: number };
        seeded.db
            .prepare(
                `INSERT INTO compartments (session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, importance, created_at)
                 VALUES (?, ?, 1, 2, 'msg_a', 'msg_z', 'post-capture compartment sighting', 'post-capture compartment sighting', 5, 1)`,
            )
            .run(window.sessionId, maxSeq.m + 1);
        const out = renderRegionVolatile(options, wm);
        expect(out.text).toContain("<session-history-since>");
        expect(out.text).toContain("<new-compartments>");
        expect(out.text).toContain("post-capture compartment sighting");
        expect(out.compartmentCount).toBe(1);
    });
});

describe("region-volatile: store and serve (replay-only)", () => {
    it("serveRegionVolatile decodes stored bytes verbatim — a live mutation after capture does not move the serve", () => {
        const { seeded, window } = freshSeed();
        const meta = getOrCreateSessionMeta(seeded.db, window.sessionId);
        writeRegionVolatile(
            seeded.db,
            window.sessionId,
            "<session-history-since>frozen volatile bytes</session-history-since>",
            meta.cachedM0MaterializedAt ?? 0,
        );
        // A memory lands AFTER the volatile capture.
        insertMemory(seeded.db, {
            projectPath: window.identity,
            category: "ARCHITECTURE",
            content: "late mutation must not reach the serve",
            sourceType: "historian",
        });
        expect(serveRegionVolatile(seeded.db, window.sessionId)).toBe(
            "<session-history-since>frozen volatile bytes</session-history-since>",
        );
    });

    it("writeRegionVolatile with empty text clears both columns (the absorbed state)", () => {
        const { seeded, window } = freshSeed();
        writeRegionVolatile(seeded.db, window.sessionId, "stale bytes", 111);
        writeRegionVolatile(seeded.db, window.sessionId, "", 111);
        const meta = getOrCreateSessionMeta(seeded.db, window.sessionId);
        expect(meta.regionVolatileBytes).toBeNull();
        expect(serveRegionVolatile(seeded.db, window.sessionId)).toBeNull();
    });
});

function buildHandler(opts: { systemRegionLane?: boolean }) {
    return createSystemPromptHashHandler({
        db: openDatabase(),
        dreamerEnabled: false,
        resolveModel: () => ({ providerID: "provider", modelID: "default-model" }),
        historyRefreshSessions: new Set<string>(),
        systemPromptRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
        systemRegionLane: opts.systemRegionLane,
    });
}

function useTempDataHome(prefix: string): void {
    const dir = createTestTempDirFromPath(join(tmpdir(), prefix));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
}

function freezeReduce(sessionId: string): void {
    resolveCtxReduceAvailabilityFromMessages(sessionId, [
        { info: { id: "u", role: "user" }, parts: [{ type: "text", text: "hello" }] },
    ] as never);
}

async function pass(sessionId: string, system: string): Promise<string> {
    const { handler } = buildHandler({ systemRegionLane: true });
    const output = { system: [system] };
    await handler({ sessionID: sessionId }, output as never);
    return output.system[0];
}

describe("region-volatile: the serve path appends volatile after the region bytes", () => {
    const SESSION = "ses-vol-serve";

    function seedServed(region: string | null, volatile: string | null, epoch: number): void {
        useTempDataHome("srg-vol-serve-");
        const db = openDatabase();
        getOrCreateSessionMeta(db, SESSION);
        updateSessionMeta(db, SESSION, {
            cachedM0Bytes: region === null ? null : encodeSystemRegionRow(region),
            cachedM0MaterializedAt: epoch,
        });
        if (volatile !== null) writeRegionVolatile(db, SESSION, volatile, epoch);
        freezeReduce(SESSION);
    }

    it("emits host, region, then volatile as the tail of system[0]", async () => {
        seedServed(
            "REGION BODY",
            "<session-history-since>volatile delta sighting</session-history-since>",
            4242,
        );
        const text = await pass(SESSION, "HOST GUIDANCE");
        const hostAt = text.indexOf("HOST GUIDANCE");
        const regionAt = text.indexOf("\n\nREGION BODY");
        const volatileAt = text.indexOf(
            "\n\n<session-history-since>volatile delta sighting</session-history-since>",
        );
        expect(hostAt).toBe(0);
        expect(regionAt).toBeGreaterThan(hostAt);
        expect(volatileAt).toBeGreaterThan(regionAt);
        expect(text.endsWith("</session-history-since>")).toBe(true);
    });

    it("serves nothing extra when the volatile segment is empty (no trailing separator)", async () => {
        seedServed("REGION BODY", null, 4242);
        const text = await pass(SESSION, "HOST GUIDANCE");
        expect(text).toContain("REGION BODY");
        expect(text.endsWith("REGION BODY")).toBe(true);
    });

    it("never serves volatile derived from a different region epoch (stale-watermark refusal)", async () => {
        seedServed(
            "REGION BODY",
            "<session-history-since>stale epoch bytes</session-history-since>",
            4242,
        );
        // Break the pairing after the write: volatile names 4242, the region
        // row now names 9999 — bytes rendered against an older region.
        updateSessionMeta(openDatabase(), SESSION, { cachedM0MaterializedAt: 9999 });
        expect(await pass(SESSION, "HOST GUIDANCE")).not.toContain("stale epoch bytes");
    });

    it("the volatile tail does not move the watched hash (hash covers host bytes only)", async () => {
        seedServed(
            "REGION BODY",
            "<session-history-since>tail bytes v1</session-history-since>",
            4242,
        );
        const first = await pass(SESSION, "HOST GUIDANCE");
        expect(first).toContain("tail bytes v1");
        const hashBefore = getOrCreateSessionMeta(openDatabase(), SESSION).systemPromptHash;
        // Rotate the volatile row content — the served tail moves, the watched
        // hash (host bytes only) must not.
        writeRegionVolatile(
            openDatabase(),
            SESSION,
            "<session-history-since>tail bytes v2</session-history-since>",
            4242,
        );
        const second = await pass(SESSION, "HOST GUIDANCE");
        expect(second).toContain("tail bytes v2");
        const meta = getOrCreateSessionMeta(openDatabase(), SESSION);
        expect(meta.systemPromptHash).toBe(hashBefore);
    });
});
