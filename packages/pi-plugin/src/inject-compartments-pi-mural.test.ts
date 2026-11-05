import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_MURAL_BLOCK } from "@magic-context/core/agents/magic-context-prompt";
import { resolveMuralWire } from "@magic-context/core/features/magic-context/mural/render-trigger";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { encodeCachedM0UpgradeIdentity } from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import {
	clearModelsDevCache,
	refreshModelLimitsFromApi,
} from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import { injectM0M1Pi, type PiM0M1State } from "./inject-compartments-pi";
import { createTestDb, userMessage } from "./test-utils.test";

const SESSION_ID = "ses_pi_mural_inject";

// 1x1 transparent PNG data URL (same fixture as OpenCode mural inject tests).
const FAKE_MURAL_DATA_URL =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const FAKE_MURAL_BASE64 = FAKE_MURAL_DATA_URL.slice(
	"data:image/png;base64,".length,
);

function muralOption(
	dataUrl = FAKE_MURAL_DATA_URL,
	contentHash = "mural-hash-1",
) {
	return {
		enabled: true,
		supportsVision: true,
		dataUrl,
		contentHash,
	};
}

function baseState(overrides: Partial<PiM0M1State> = {}): PiM0M1State {
	return {
		sessionId: SESSION_ID,
		projectIdentity: "git:pi-mural",
		projectDirectory: "/tmp/pi-mural",
		hardSignals: {
			systemHash: "sys",
			modelKey: "anthropic/claude-sonnet-4",
			cacheExpired: false,
			lastResponseTime: 0,
		},
		...overrides,
	};
}

function replaceCurrentManifest(db: ReturnType<typeof createTestDb>): string {
	const image = Buffer.from("current pi mural", "utf8");
	db.prepare(
		`INSERT OR REPLACE INTO mural_manifest
			(project_path, image, content_hash, rendered_at, memory_ids_json, width, height)
		 VALUES (?, ?, ?, ?, '[]', 1, 1)`,
	).run("git:pi-mural", image, "current-pi-manifest", Date.now());
	return image.toString("base64");
}

function findMuralImage(messages: unknown[]): {
	mimeType?: string;
	data?: string;
} | null {
	for (const raw of messages) {
		const message = raw as { role?: string; content?: unknown };
		if (message?.role !== "user" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (
				part &&
				typeof part === "object" &&
				(part as { type?: string }).type === "image"
			) {
				return part as { type?: string; mimeType?: string; data?: string };
			}
		}
	}
	return null;
}

describe("Pi m[0] mural image fold on the region lane (on-demand render → wire)", () => {
	function regionOf(
		db: ReturnType<typeof createTestDb>,
		sessionId = SESSION_ID,
	): string {
		return (
			getOrCreateSessionMeta(db, sessionId).cachedM0Bytes?.toString("utf8") ??
			""
		);
	}

	it("replays a pre-legend baseline unchanged until the next HARD fold", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const firstMessages = [userMessage("first")];
			injectM0M1Pi(
				baseState(),
				db,
				firstMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const beforeRegion = regionOf(db);
			expect(beforeRegion).not.toContain(MEMORY_MURAL_BLOCK);
			// Defer passes replay the persisted region byte-identically — no
			// legend grows, no image rides.
			const deferredMessages = [userMessage("defer")];
			const deferred = injectM0M1Pi(
				baseState(),
				db,
				deferredMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(deferred.m0Materialized).toBe(false);
			expect(regionOf(db)).toBe(beforeRegion);
			expect(findMuralImage(deferredMessages)).toBeNull();
			// The next HARD fold (system hash change) re-renders with the mural.
			injectM0M1Pi(
				baseState({
					mural: muralOption(),
					muralEnabled: true,
					hardSignals: { ...baseState().hardSignals!, systemHash: "next" },
				}),
				db,
				[userMessage("hard")] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(regionOf(db)).toContain(MEMORY_MURAL_BLOCK);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds the <memory-mural> block and Pi image part on HARD, replays byte-identical on defer", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const state = baseState({
				mural: muralOption(),
				muralEnabled: true,
			});

			const hardMessages = [userMessage("hello")];
			const first = injectM0M1Pi(
				state,
				db,
				hardMessages as never,
				undefined,
				undefined,
				{
					systemRegion: { enabled: true, reason: "" },
				},
			);
			expect(first.injected).toBe(true);
			expect(first.m0Materialized).toBe(true);
			expect(regionOf(db)).toContain(MEMORY_MURAL_BLOCK);
			// The image rides from the pass after the fold: the serve composes
			// the system prompt (region bytes) before the context pass folds,
			// so legend and image reach the wire TOGETHER on the next request
			// — never legend-without-image on the fold pass itself.

			// Simulate restart after another session advances the project
			// manifest. The defer must ride this session's persisted frozen
			// payload (the row is the image authority), not the manifest.
			replaceCurrentManifest(db);
			const deferMessages = [userMessage("again")];
			const second = injectM0M1Pi(
				baseState(),
				db,
				deferMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(second.m0Reason).toBeNull();
			expect(second.m0Materialized).toBe(false);
			expect(regionOf(db)).toContain("<memory-mural>");
			const deferImage = findMuralImage(deferMessages);
			expect(deferImage?.data).toBe(FAKE_MURAL_BASE64);
			expect(deferImage?.data).not.toBe(replaceCurrentManifest(db));

			const refreshedMessages = [userMessage("natural hard")];
			const refreshed = injectM0M1Pi(
				baseState({
					mural: muralOption(
						`data:image/png;base64,${replaceCurrentManifest(db)}`,
						"current-pi-manifest",
					),
					muralEnabled: true,
					hardSignals: {
						systemHash: "sys-next",
						modelKey: "anthropic/claude-sonnet-4",
						cacheExpired: false,
						lastResponseTime: 0,
					},
				}),
				db,
				refreshedMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(refreshed.m0Reason).toBe("system_hash");
			expect(refreshed.m0Materialized).toBe(true);
			// The refreshed image rides the pass AFTER the fold: the fold
			// pass's request still serves the pre-fold region + its image
			// (travel-together); the next pass reads the refreshed row.
			const refreshedNext = [userMessage("after refresh")];
			injectM0M1Pi(
				baseState({
					mural: muralOption(
						`data:image/png;base64,${replaceCurrentManifest(db)}`,
						"current-pi-manifest",
					),
					muralEnabled: true,
				}),
				db,
				refreshedNext as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(findMuralImage(refreshedNext)?.data).toBe(
				replaceCurrentManifest(db),
			);
			expect(regionOf(db)).toContain("<memory-mural>");
		} finally {
			closeQuietly(db);
		}
	});

	it("folds once when mural is disabled, removes the image, then defers byte-identically", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const enabledMessages = [userMessage("enabled")];
			injectM0M1Pi(
				baseState({
					muralEnabled: true,
					mural: muralOption(),
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				enabledMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(regionOf(db)).toContain(MEMORY_MURAL_BLOCK);

			const disabledMessages = [userMessage("disabled")];
			const disabled = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				disabledMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(disabled.m0Reason).toBe("render_config:mural(true→false)");
			expect(disabled.m0Materialized).toBe(true);
			// The disabled fold pass's request still serves the pre-fold
			// region (legend) + its image — travel-together. The region bytes
			// lost the legend in the fold; from the next pass nothing rides.
			expect(regionOf(db)).not.toContain("<memory-mural>");

			const deferMessages = [userMessage("defer")];
			const defer = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 8_000,
					historyBudgetTokens: 60_000,
				}),
				db,
				deferMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(defer.m0Materialized).toBe(false);
			expect(regionOf(db)).not.toContain("<memory-mural>");
			expect(findMuralImage(deferMessages)).toBeNull();
			expect(findMuralImage(disabledMessages)).not.toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("folds once when memory or history render budgets change", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_000,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("first")] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const changed = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_001,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("changed")] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(changed.m0Reason).toBe(
				"render_config:budget(m1000-h2000→m1001-h2000)",
			);
			expect(changed.m0Materialized).toBe(true);

			const unchanged = injectM0M1Pi(
				baseState({
					muralEnabled: false,
					injectionBudgetTokens: 1_001,
					historyBudgetTokens: 2_000,
				}),
				db,
				[userMessage("unchanged")] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(unchanged.m0Materialized).toBe(false);
		} finally {
			closeQuietly(db);
		}
	});

	it("rides the persisted sibling mural payload verbatim (no process-cache staleness)", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption(), muralEnabled: true }),
				db,
				[userMessage("hard")] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			// A sibling process persisted its own mural columns with the row.
			// The carriage is a pure function of the persisted columns: the
			// next pass rides them verbatim (the head-era process cache that
			// could go stale is deleted).
			const siblingDataUrl = "data:image/png;base64,cGktc2libGluZy1tdXJhbA==";
			db.prepare(
				`UPDATE session_meta
					SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ?
				  WHERE session_id = ?`,
			).run(siblingDataUrl, "pi-sibling-hash", SESSION_ID);

			const messages = [userMessage("soft")];
			injectM0M1Pi(baseState(), db, messages as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(findMuralImage(messages)?.data).toBe(
				siblingDataUrl.slice("data:image/png;base64,".length),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("a row without its image payload emits no image; the stored region keeps its frozen legend", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			injectM0M1Pi(
				baseState({ mural: muralOption(), muralEnabled: true }),
				db,
				[userMessage("hard")] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				`UPDATE session_meta
					SET cached_m0_mural_data_url = NULL, cached_m0_mural_hash = NULL
				  WHERE session_id = ?`,
			).run(SESSION_ID);

			// The stored region keeps its legend (bytes freeze between
			// rotations); the payload columns are the image authority. With
			// the mural columns NULLed, no image may ride.
			const messages = [userMessage("defer")];
			// Same state as the seed fold: the columns' nulling is the only
			// change. A mural-less state here would be a mural flip (its own
			// fold), which is the next test's scenario.
			injectM0M1Pi(
				baseState({ mural: muralOption(), muralEnabled: true }),
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(findMuralImage(messages)).toBeNull();
			expect(regionOf(db)).toContain("<memory-mural>");
		} finally {
			closeQuietly(db);
		}
	});

	it("omits the mural when the feature flag is off", () => {
		const db = createTestDb();
		try {
			getOrCreateSessionMeta(db, SESSION_ID);
			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(
				baseState({ muralEnabled: false }),
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(result.injected).toBe(true);
			expect(regionOf(db)).not.toContain("<memory-mural>");
			expect(findMuralImage(messages)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("stays image-less when the model has no vision metadata (fail closed)", async () => {
		const tempDir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-mural-novision-"),
		);
		const originalXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tempDir;
		clearModelsDevCache();
		const db = createTestDb();
		try {
			// Seed a non-vision model so the gate has metadata but vision=false.
			await refreshModelLimitsFromApi({
				config: {
					providers: async () => ({
						data: {
							providers: [
								{
									id: "anthropic",
									models: {
										"claude-sonnet-4": {
											limit: { context: 200_000, input: 200_000 },
										},
									},
								},
							],
						},
					}),
				},
			});
			getOrCreateSessionMeta(db, `${SESSION_ID}_novision`);
			const messages = [userMessage("hello")];
			injectM0M1Pi(
				baseState({
					sessionId: `${SESSION_ID}_novision`,
					muralEnabled: true,
					hardSignals: {
						systemHash: "sys",
						modelKey: "anthropic/claude-sonnet-4",
						cacheExpired: false,
						lastResponseTime: 0,
					},
				}),
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(regionOf(db, `${SESSION_ID}_novision`)).not.toContain(
				"<memory-mural>",
			);
			expect(findMuralImage(messages)).toBeNull();
		} finally {
			if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
			else process.env.XDG_DATA_HOME = originalXdgData;
			clearModelsDevCache();
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			closeQuietly(db);
		}
	});
});

describe("resolveMuralWire Pi provider-prefix translation", () => {
	let tempDir: string;
	let originalXdgData: string | undefined;

	beforeEach(() => {
		// Isolate the persisted models-dev cache so vision seeds never touch the
		// real ~/.local/share tree or leak across cases via cold-start reload.
		tempDir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-mural-models-"));
		originalXdgData = process.env.XDG_DATA_HOME;
		process.env.XDG_DATA_HOME = tempDir;
		clearModelsDevCache();
	});
	afterEach(() => {
		if (originalXdgData === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = originalXdgData;
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
		clearModelsDevCache();
	});

	it("accepts Pi-native openai-codex/… after translating to canonical openai/…", async () => {
		await refreshModelLimitsFromApi({
			config: {
				providers: async () => ({
					data: {
						providers: [
							{
								id: "openai",
								models: {
									"gpt-4o": {
										limit: { context: 128_000, input: 128_000 },
										// models-dev vision detection looks for modalities/input
										// containing "image" or a vision-ish name.
										modalities: { input: ["text", "image"] },
									},
								},
							},
						],
					},
				}),
			},
		});
		const db = createTestDb();
		try {
			// Empty cue pool → supportsVision true but no dataUrl. The important
			// assertion is that the Pi-native prefix is NOT rejected as unknown.
			const wire = resolveMuralWire(
				db,
				"git:pi-mural-prefix",
				"openai-codex/gpt-4o",
				true,
			);
			expect(wire.enabled).toBe(true);
			expect(wire.supportsVision).toBe(true);
		} finally {
			closeQuietly(db);
		}
	});

	it("fails closed when models.dev metadata is absent", () => {
		clearModelsDevCache();
		const db = createTestDb();
		try {
			const wire = resolveMuralWire(
				db,
				"git:pi-mural-prefix",
				"openai-codex/gpt-4o",
				true,
			);
			expect(wire.supportsVision).toBe(false);
			expect(wire.dataUrl).toBeUndefined();
		} finally {
			closeQuietly(db);
		}
	});
});

describe("Pi region lane: mural PNG carriage (Unit 7, plugin U1 ruling mirror)", () => {
	function findMuralImageMessage(
		messages: unknown[],
	): { mimeType?: string; data?: string } | null {
		for (const raw of messages) {
			const message = raw as { role?: string; content?: unknown };
			if (message?.role !== "user" || !Array.isArray(message.content)) continue;
			for (const part of message.content) {
				if (
					part &&
					typeof part === "object" &&
					(part as { type?: string }).type === "image"
				) {
					return part as { type?: string; mimeType?: string; data?: string };
				}
			}
		}
		return null;
	}

	function seedRegionWithLegend(
		db: ReturnType<typeof createTestDb>,
		state: PiM0M1State,
	): string {
		// A production fold with the mural enabled renders the legend into
		// the region bytes and persists the mural columns with the row.
		injectM0M1Pi(
			state,
			db,
			[userMessage("seed", 1)] as never,
			undefined,
			undefined,
			{
				systemRegion: { enabled: true, reason: "" },
			},
		);
		const region = getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes;
		expect(region?.toString("utf8")).toContain(MEMORY_MURAL_BLOCK);
		return region as unknown as string;
	}

	it("a legend-carrying region serves with the image part beside it (the stranding case)", () => {
		// RED witness (pre-carriage): the fold baked the legend into the
		// region while the image part had no carrier on the region lane —
		// the legend stranded on the wire. The carriage makes legend and
		// image travel together.
		const db = createTestDb();
		try {
			const state = baseState({ mural: muralOption(), muralEnabled: true });
			seedRegionWithLegend(db, state);
			const messages = [userMessage("next", 2)];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				undefined,
				undefined,
				{
					systemRegion: { enabled: true, reason: "" },
				},
			);
			const image = findMuralImageMessage(messages);
			expect(image).not.toBeNull();
			expect(image?.mimeType).toBe("image/png");
			expect(image?.data).toBe(FAKE_MURAL_BASE64);
			// The image is its own synthetic message beside the region: MC's
			// contribution to the leading synthetic count is exactly one.
			expect(result.syntheticLeadingCount).toBe(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("no image is emitted without a servable region (legend and image never strand apart)", () => {
		const db = createTestDb();
		try {
			const state = baseState();
			getOrCreateSessionMeta(db, state.sessionId);
			// Mural columns present, but no region row serves: the fold is
			// forced to lose contention (BEGIN IMMEDIATE blocked), so nothing
			// installs and nothing rides.
			db.prepare(
				"UPDATE session_meta SET cached_m0_mural_data_url = ?, cached_m0_mural_hash = ? WHERE session_id = ?",
			).run(FAKE_MURAL_DATA_URL, "mural-hash-1", state.sessionId);
			const messages = [userMessage("next", 2)];
			const exec = db.exec.bind(db);
			const blocker = spyOn(db, "exec").mockImplementation((sql) => {
				if (sql === "BEGIN IMMEDIATE")
					throw Object.assign(new Error("database is locked"), {
						code: "SQLITE_BUSY",
					});
				return exec(sql);
			});
			let result: ReturnType<typeof injectM0M1Pi>;
			try {
				result = injectM0M1Pi(
					state,
					db,
					messages as never,
					undefined,
					undefined,
					{
						systemRegion: { enabled: true, reason: "" },
					},
				);
			} finally {
				blocker.mockRestore();
			}
			expect(result.contentionExhausted).toBe(true);
			expect(findMuralImageMessage(messages)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("compaction-off rides the region carriage too (no carve-out)", () => {
		// Owner ruling, copied from the plugin's emit comment: "No
		// compaction-off carve-out: the legend ships inside the region bytes
		// for an off install too (owner ruling — compaction-off rides the
		// region), so the image must ride as well or the legend strands."
		const db = createTestDb();
		try {
			const state = baseState({
				compactionOff: true,
				mural: muralOption(),
				muralEnabled: true,
			});
			seedRegionWithLegend(db, state);
			const messages = [userMessage("next", 2)];
			injectM0M1Pi(state, db, messages as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(findMuralImageMessage(messages)).not.toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("gate flips: a mural-disabled fold or a missing data URL emits no image (#2780 rogue class)", () => {
		const db = createTestDb();
		try {
			// The fold encoded muralEnabled=false (identity) while a stale
			// data URL lingers on the row: the gate must refuse. A rogue gate
			// that only checks the data URL emits here and reddens.
			const state = baseState({ mural: muralOption(), muralEnabled: true });
			seedRegionWithLegend(db, state);
			const identity = encodeCachedM0UpgradeIdentity(
				"pi-m0m1-v2:ready",
				"c1",
				false,
				"",
				"m1",
				null,
				"",
			);
			db.prepare(
				"UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(identity, state.sessionId);
			const disabled = [userMessage("next", 2)];
			injectM0M1Pi(state, db, disabled as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(findMuralImageMessage(disabled)).toBeNull();

			// No data URL: nothing rides even with the feature enabled.
			db.prepare(
				"UPDATE session_meta SET cached_m0_mural_data_url = NULL, cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(
				encodeCachedM0UpgradeIdentity(
					"pi-m0m1-v2:ready",
					"c1",
					true,
					"",
					"m1",
					null,
					"",
				),
				state.sessionId,
			);
			const noUrl = [userMessage("next", 3)];
			injectM0M1Pi(state, db, noUrl as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(findMuralImageMessage(noUrl)).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("no-import law: the Pi carriage is a codec copy, not an import (Task 5 pattern)", () => {
		// The Pi envelope is Pi's own; the plugin's region-render mint
		// (buildRegionMuralMessage) must not be imported into the Pi tree.
		const carriage = readFileSync(
			join(import.meta.dir, "inject-compartments-pi.ts"),
			"utf8",
		);
		expect(/\bbuildRegionMuralMessage\b/.test(carriage)).toBe(false);
		// Rogue control (#2780): the planted import reddens the same scan.
		const rogue = `${carriage}\nimport { buildRegionMuralMessage } from "@magic-context/core/hooks/magic-context/region-render";\n`;
		expect(/\bbuildRegionMuralMessage\b/.test(rogue)).toBe(true);
	});
});
