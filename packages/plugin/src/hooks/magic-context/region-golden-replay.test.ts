/// <reference types="bun-types" />

/**
 * Region golden replay law (assembly-v2 Unit 1, Step 1).
 *
 * Law A of the golden package: re-running the committed seeds through the
 * production rotation path must reproduce the committed region bytes
 * byte-exactly. The capture (scripts/region-golden/capture.ts) drives
 * `injectM0M1({ systemRegion: { enabled: true } })` → materializeM0 →
 * executeSystemRegionRotation (inject-compartments.ts) against a fresh temp
 * store seeded from the host context.db (read-only extraction); this law
 * replays the identical drive and compares bytes.
 *
 * Real windows carry the host row's stored-region sha256 in the manifest as
 * provenance; the byte-equality that matters is seed → production path →
 * committed bytes, so any regression in the renderers, the fold plumbing, or
 * the tokenizer reddens a named window here — before and after the sever
 * (Step 2) routes the region branch through `renderRegionBody`.
 *
 * Skips (does not fail) when the golden package is absent from the checkout;
 * the package is committed, so CI always runs it.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readSystemRegion } from "../../features/magic-context/system-region";
import { injectM0M1 } from "./inject-compartments";
import { getTokenEstimatorFingerprint } from "./read-session-formatting";
import type { ManifestWindow } from "./region-golden-harness";
import {
    buildRenderOptions,
    closeDatabase,
    GOLDEN_DIR,
    loadManifest,
    packagePresent,
    seedWindow,
} from "./region-golden-harness";

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

function replayWindow(window: ManifestWindow): Buffer {
    const manifest = loadManifest();
    const seeded = seedWindow(window, manifest);
    tempDirs.push(seeded.dataHome);
    const options = buildRenderOptions(window, seeded, {
        enabled: true,
        reason: "golden_replay",
    });
    Date.now = () => window.frozenNowMs;
    injectM0M1(options);
    const region = readSystemRegion(seeded.db, window.sessionId);
    if (region === null) throw new Error(`${window.id}: no sentinel-valid region after replay`);
    return Buffer.from(region, "utf8");
}

describe("region golden replay (Law A: byte-exact seed → production path)", () => {
    it.skipIf(!packagePresent())("golden package manifest is self-consistent", () => {
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

    it.skipIf(!packagePresent())(
        "the estimator fingerprint matches the capture (bytes depend on it)",
        () => {
            const manifest = loadManifest();
            expect(getTokenEstimatorFingerprint()).toBe(manifest.estimatorFingerprint);
        },
    );

    const manifest = packagePresent() ? loadManifest() : null;
    for (const window of manifest?.windows ?? []) {
        it.skipIf(!packagePresent())(`replays ${window.id} byte-exactly`, () => {
            const bytes = replayWindow(window);
            expect(bytes.toString("utf8")).toBe(
                readFileSync(join(GOLDEN_DIR, window.regionFile)).toString("utf8"),
            );
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(window.regionSha256);
        });
    }
});
