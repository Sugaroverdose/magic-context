/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { ABSOLUTE_EMERGENCY_PERCENTAGE } from "../../shared/escalation-bands";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { clearWindowOverlayCacheForTest, setWindowOverlayPath } from "../../shared/window-geometry";
import { persistV2UsageReading } from "./usage-persist";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    clearModelsDevCache();
    setWindowOverlayPath(undefined);
    clearWindowOverlayCacheForTest();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function makeTempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}

// A model whose window is configured at 272K, both in the catalog and in a
// measured overlay cell (the strongest wall the resolver knows).
async function configure272kWindow(): Promise<void> {
    const overlayPath = join(makeTempDir("v2-usage-overlay-"), "window-overlay.json");
    writeFileSync(
        overlayPath,
        JSON.stringify({
            schema: "fusiform-window-overlay/v1",
            generated_at: "2026-09-11T00:00:00Z",
            minted_provider_ids: [],
            cells: [
                {
                    provider_id: "test-provider",
                    model_id: "test-model",
                    facts: {
                        "window.enforced": {
                            value: { kind: "stated", value: 272_000 },
                            grade: "measured",
                            units: "provider",
                            boundary: "Observed",
                            source_ref: "usage persist fixture",
                            observed_at: "2026-09-11T00:00:00Z",
                        },
                    },
                },
            ],
        }),
    );
    setWindowOverlayPath(overlayPath);
    await refreshModelLimitsFromApi({
        config: {
            providers: async () => ({
                data: {
                    providers: [
                        {
                            id: "test-provider",
                            models: {
                                "test-model": { limit: { context: 272_000, output: 128_000 } },
                            },
                        },
                    ],
                },
            }),
        },
    });
}

describe("persistV2UsageReading", () => {
    it("treats provider usage above the configured window as real pressure on every reading", async () => {
        process.env.XDG_DATA_HOME = makeTempDir("v2-usage-persist-");
        await configure272kWindow();
        const db = openDatabase();
        const sessionID = "ses-v2-above-window";
        const contextUsageMap: TransformDeps["contextUsageMap"] = new Map();
        const draftModel = { providerID: "test-provider", id: "test-model" };
        const persist = (inputTokens: number) =>
            persistV2UsageReading({
                db,
                sessionID,
                draftModel,
                reading: {
                    inputTokens,
                    limit: 240_000,
                    admissionLimit: 240_000,
                    modelKey: "test-provider/test-model",
                },
                rawContextLimit: 272_000,
                hostCompactionReducedUsage: false,
                contextUsageMap,
            });

        persist(147_839);
        expect(getOrCreateSessionMeta(db, sessionID).lastInputTokens).toBe(147_839);

        // The provider accepted a 300K request on a model configured at 272K:
        // that is the real prompt size, so it becomes the pressure reading.
        expect(persist(300_000)).toBe(false);
        let meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastInputTokens).toBe(300_000);
        expect(meta.lastContextPercentage).toBeGreaterThanOrEqual(ABSOLUTE_EMERGENCY_PERCENTAGE);
        expect(contextUsageMap.get(sessionID)?.usage.inputTokens).toBe(300_000);

        // Staying above the configured window keeps counting on every reading.
        persist(310_000);
        meta = getOrCreateSessionMeta(db, sessionID);
        expect(meta.lastInputTokens).toBe(310_000);
        expect(meta.lastContextPercentage).toBeGreaterThanOrEqual(ABSOLUTE_EMERGENCY_PERCENTAGE);
        expect(contextUsageMap.get(sessionID)?.usage.percentage).toBeGreaterThanOrEqual(
            ABSOLUTE_EMERGENCY_PERCENTAGE,
        );
    });
});
