/// <reference types="bun-types" />

/**
 * Region golden parity law (assembly-v2 Unit 1, Step 2).
 *
 * Law B of the golden package: the extracted region renderer —
 * `renderRegionM0` (panels: decay + memories + user-profile + mural, pressure
 * loop, never-empty floor) — must reproduce the committed golden region bytes
 * byte-exactly, driven through the same production readers and composition
 * materializeM0 uses (production-composition, #2715 precedent: every operand
 * comes from the production reader, never a hand-shaped fixture).
 *
 * Unit 2 Step 2: the delta half (`renderRegionM1` + the `renderRegionBody`
 * join) left the region and moved to the volatile segment, so the parity
 * composition is the panel text alone.
 *
 * The attack: if the sever changes any byte the rotation writes — renderer,
 * budget, decay, placeholder, join order, separator — a named window reddens
 * here. Law A pins the whole production drive; Law B pins that the region
 * producer alone IS the bytes the production path produced pre-sever. If a
 * future change routes the rotation back through private inline rendering
 * while these drift, Law A and this law's rotation half diverge.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
    getMemoriesByProject,
    getMemoriesByProjects,
} from "../../features/magic-context/memory/storage-memory";
import { readCurrentM0SnapshotMarkers, readProjectDocsForM0 } from "./inject-compartments";
import {
    buildRenderOptions,
    closeDatabase,
    GOLDEN_DIR,
    loadManifest,
    type ManifestWindow,
    packagePresent,
    seedWindow,
} from "./region-golden-harness";
import {
    readM0Compartments,
    renderRegionM0,
    resolveWorkspaceRenderContext,
    safeGetActiveUserMemories,
} from "./region-render";

const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalTz = process.env.TZ;
const originalNow = Date.now;
const tempDirs: string[] = [];

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

function renderWindowBody(window: ManifestWindow): string {
    const manifest = loadManifest();
    const seeded = seedWindow(window, manifest);
    tempDirs.push(seeded.dataHome);
    const options = buildRenderOptions(window, seeded);
    Date.now = () => window.frozenNowMs;

    // Production composition, mirroring materializeM0's read phase exactly
    // (inject-compartments.ts materializeM0: snapshot → docs hydration →
    // compaction-off compartment filter → memory reads → user memories).
    const workspace = resolveWorkspaceRenderContext({
        db: seeded.db,
        projectPath: window.identity,
    });
    const snapshotMarkers = readCurrentM0SnapshotMarkers({
        db: seeded.db,
        sessionId: window.sessionId,
        projectPath: window.identity,
        projectDirectory: seeded.docsDir,
        injectDocs: window.injectDocs,
        memoryEnabled: window.memoryEnabled,
        muralEnabled: window.muralEnabled,
        memoryInjectionBudgetTokens: window.budgets.memoryInjectionBudgetTokens,
        historyBudgetTokens: window.budgets.historyBudgetTokens,
        historyBudgetPolicyIdentity: window.budgets.historyBudgetPolicyIdentity ?? undefined,
        hardSignals: options.hardSignals,
        workspaceIdentitySet: {
            identities: workspace.identities,
            namesByIdentity: workspace.namesByIdentity,
        },
    });
    const docs = readProjectDocsForM0(seeded.docsDir, window.injectDocs);
    snapshotMarkers.projectDocsHash = docs.canonicalHash;
    const foldMaterializedAt = window.frozenNowMs;
    const compartments = window.compactionOff
        ? []
        : readM0Compartments(seeded.db, window.sessionId);
    const memories = window.identity
        ? workspace.isWorkspaced
            ? getMemoriesByProjects(
                  seeded.db,
                  workspace.expandedIdentities,
                  ["active", "permanent"],
                  foldMaterializedAt,
                  workspace.ownIdentities,
                  workspace.shareCategories,
              )
            : getMemoriesByProject(
                  seeded.db,
                  window.identity,
                  ["active", "permanent"],
                  foldMaterializedAt,
              )
        : [];
    const userMemories = window.memoryEnabled === false ? [] : safeGetActiveUserMemories(seeded.db);

    const m0 = renderRegionM0({
        db: seeded.db,
        sessionId: window.sessionId,
        projectPath: window.identity,
        options,
        docs,
        snapshotMarkers,
        foldMaterializedAt,
        compartments,
        facts: [],
        memories,
        userMemories,
        workspace,
    });
    // Unit 2 Step 2: the region is the four panels only. The delta half moved
    // to the volatile segment (region-volatile.ts), so the parity composition
    // is renderRegionM0's panel text with no join.
    return m0.m0Text;
}

describe("region golden parity (Law B: renderRegionM0 panels == committed bytes)", () => {
    const manifest = packagePresent() ? loadManifest() : null;
    for (const window of manifest?.windows ?? []) {
        it.skipIf(!packagePresent())(`renderRegionM0(${window.id}) is byte-exact`, () => {
            const golden = readFileSync(join(GOLDEN_DIR, window.regionFile)).toString("utf8");
            const body = renderWindowBody(window);
            expect(body.length).toBeGreaterThan(0);
            expect(body).toBe(golden);
            expect(createHash("sha256").update(body).digest("hex")).toBe(window.regionSha256);
        });
    }

    it("capture and replay seed from one table set (no independent builders)", () => {
        // Reviewer-recommended closure (Unit 2 round 1): a future re-capture
        // could reproduce committed bytes through the production path while
        // driveOnce drifted off the replay seeder's table set. Both sides
        // must go through seedGoldenStore — no per-table insertRows in either
        // the capture script or the harness itself.
        const capturePath = join(
            import.meta.dir,
            "..",
            "..",
            "..",
            "..",
            "..",
            "scripts",
            "region-golden",
            "capture.ts",
        );
        const capture = readFileSync(capturePath, "utf8");
        expect(capture).toContain("seedGoldenStore(db, extraction)");
        expect(capture).not.toMatch(/insertRows\(\s*db\s*,\s*"/);
        const harness = readFileSync(join(import.meta.dir, "region-golden-harness.ts"), "utf8");
        const seedBody = harness.slice(harness.indexOf("export function seedWindow("));
        expect(seedBody.slice(0, seedBody.indexOf("\n}"))).not.toMatch(/insertRows\(/);
    });
});
