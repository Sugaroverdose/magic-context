/**
 * Shared oracle leg runner for the differential rendering oracle.
 *
 * Extracted from the merged unit-1b determinism self-test
 * (tests/oracle-determinism.test.ts at 9e11a42d5) without behavior change: the
 * same pinned host, the same determinism wrapper (clock freeze + seeded RNG +
 * pinned date line), the same store-reset contract (snapshot once, restore
 * byte-identically between legs), the same quiescence and session-processed
 * gates, and the same R2/R3 honesty guards — so unit 2's classified captures
 * are the same deterministic bytes the self-test certified. The only
 * generalizations: turn texts are a parameter, the R3 mutation is a turn-index
 * parameter, and the leg accepts boot-time mock scripting plus spawn tuning
 * (per-agent mock models) for the classified capture.
 *
 * Pure module: no console output; certification failures throw.
 */
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	PLUGIN_ENTRY,
	createIsolatedEnv,
	spawnOpencode,
	type IsolatedEnv,
	type SpawnOptions,
	type SpawnedOpencode,
} from "../../opencode-runner/spawn";
import { cleanupE2ETempDir } from "../../temp-dir";
import { prepareContextDatabase } from "../../prepare-context-db";
import { restoreStore, snapshotStore, type StoreSnapshot } from "../determinism/store-reset";
import { resolvePinnedOpenCode1Host } from "../determinism/host-pin";
import {
	ORACLE_MUTATION_MARKER,
	assertNonVacuousComparedCorpus,
	rawBodyOf,
} from "../determinism/guards";
import {
	byteContext,
	canonicalizeProviderBody,
	committedWhitelistNames,
	firstDiffByte,
} from "../determinism/normalization";
import { MockProvider, type CapturedRequest, type MockUsage } from "../../mock-provider/server";

export const LOW_USAGE: MockUsage = {
	input_tokens: 100,
	output_tokens: 10,
	cache_creation_input_tokens: 100,
	cache_read_input_tokens: 0,
};

/**
 * The clock base the wrapper freezes to: Mon, 01 Sep 2025 00:00:00 GMT. The base
 * deliberately differs from the wall date at this unit's authorship, so the
 * pinned "Today's date" line proves the wrapper's system hook fired rather than
 * echoing an already-identical value.
 */
export const CLOCK_BASE_MS = 1756684800000;
/**
 * Deterministic clock advance per Date.now() call: barely bigger than zero so
 * host deadline loops (`while (Date.now() < end)`) still terminate, and a leg's
 * internal elapsed measurements depend only on the call sequence — identical
 * call sequences replay identical elapsed values.
 */
export const CLOCK_STEP_MS = 7;
export const PINNED_DATE = "Mon Sep 01 2025";
export const PINNED_LINE = `Today's date: ${PINNED_DATE}`;

/**
 * The determinism wrapper runs in the host process and is the ONLY plugin in the
 * host list, so the MC entry is imported here (the idle-ttl wrapper pattern). Its
 * clock/random patches land at module top level, before that dynamic import.
 */
export function determinismPluginSource(mcEntry: string): string {
	const mcFileUrl = pathToFileURL(mcEntry).href;
	return `// Determinism wrapper for the oracle OC1 leg (idle-ttl-restart.test.ts:876 pattern).
const CLOCK_BASE_MS = ${CLOCK_BASE_MS};
const CLOCK_STEP_MS = ${CLOCK_STEP_MS};
const PINNED_DATE = ${JSON.stringify(PINNED_DATE)};
const MC_ENTRY = ${JSON.stringify(mcFileUrl)};
let clockTicks = 0;
let rngState = 0x9e3779b9;
const originalNow = Date.now;
try {
    Date.now = () => {
        clockTicks += 1;
        return CLOCK_BASE_MS + clockTicks * CLOCK_STEP_MS;
    };
    Math.random = () => {
        rngState = (rngState + 0x6d2b79f5) >>> 0;
        let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
} finally {
    if (Date.now === originalNow) throw new Error("determinism wrapper: clock patch did not apply");
}
export default async (ctx) => {
    const mod = await import(MC_ENTRY);
    const plugin = mod.default ?? mod;
    const hooks = await (typeof plugin === "function" ? plugin : plugin.server)(ctx);
    const system = hooks["experimental.chat.system.transform"];
    if (!system) return hooks;
    const wrapped = { ...hooks };
    wrapped["experimental.chat.system.transform"] = async (input, output) => {
        await system(input, output);
        // Declared normalization (acknowledged): the served "Today's date" line
        // is rewritten to the pinned base. R2's in-corpus assertion (the pinned
        // line must be present in the compared request bodies) is its guard.
        for (let i = 0; i < output.system.length; i++) {
            output.system[i] = output.system[i].replace(/Today's date: [^\\n]+/g, "Today's date: " + PINNED_DATE);
        }
    };
    return wrapped;
};
`;
}

/**
 * Internals off on the oracle legs (oc2-wire-dump.ts precedent): the historian,
 * memory and dreamer completions are not part of the compared artifact; absence
 * equality across legs still holds because every captured request is compared
 * (and unit 2 asserts per-class absence explicitly).
 */
export const SELFTEST_MAGIC_CONTEXT_CONFIG = {
	memory: { enabled: false },
	historian: { disable: true },
	dreamer: { disable: true },
};

/** All matched provider requests (Anthropic Messages API for the OC1 leg). */
export function requestsOf(requests: CapturedRequest[]): CapturedRequest[] {
	return requests.filter(
		(request) =>
			request.method === "POST" && (request.path === "/messages" || request.path === "/v1/messages"),
	);
}

export interface RawDiff {
	requestIndex: number;
	firstDiff: number | null;
	contextWant: string;
	contextGot: string;
}

/**
 * Index-paired comparison of the wire. `identity` keeps the bytes verbatim;
 * the canonical path applies only the committed whitelist.
 */
export function compareBodies(
	legOne: CapturedRequest[],
	legTwo: CapturedRequest[],
	normalize: (raw: string) => string,
): RawDiff[] {
	const count = Math.min(legOne.length, legTwo.length);
	const differences: RawDiff[] = [];
	for (let index = 0; index < count; index += 1) {
		const want = normalize(rawBodyOf(legOne[index]!));
		const got = normalize(rawBodyOf(legTwo[index]!));
		const firstDiff = firstDiffByte(want, got);
		if (firstDiff === null) continue;
		differences.push({
			requestIndex: index,
			firstDiff,
			contextWant: byteContext(want, firstDiff),
			contextGot: byteContext(got, firstDiff),
		});
	}
	return differences;
}

/** N1: verbatim-byte comparison, before any canonicalization. */
export function compareRawBodies(legOne: CapturedRequest[], legTwo: CapturedRequest[]): RawDiff[] {
	return compareBodies(legOne, legTwo, (raw) => raw);
}

/** Every surviving difference is a nondeterminism source the whitelist cannot explain. */
export function compareCanonicalBodies(
	legOne: CapturedRequest[],
	legTwo: CapturedRequest[],
): RawDiff[] {
	return compareBodies(legOne, legTwo, (raw) => canonicalizeProviderBody(raw, committedWhitelistNames()));
}

export function formatDiffs(diffs: RawDiff[], heading: string): string {
	const sample = diffs
		.slice(0, 10)
		.map(
			(diff) =>
				`request#${diff.requestIndex} firstDiffByte=${diff.firstDiff}\n  want: ${JSON.stringify(diff.contextWant)}\n  got:  ${JSON.stringify(diff.contextGot)}`,
		)
		.join("\n");
	return `${heading}\n${sample}`;
}

export async function waitForMockQuiescence(
	mock: MockProvider,
	options: { quietMs?: number; timeoutMs?: number } = {},
): Promise<void> {
	const quietMs = options.quietMs ?? 400;
	const timeoutMs = options.timeoutMs ?? 30_000;
	const deadline = Date.now() + timeoutMs;
	let stableCount: number | null = null;
	let quietSince = 0;
	while (Date.now() < deadline) {
		const requests = mock.requests();
		const allCompleted = requests.every((request) => request.responseCompletedAt !== undefined);
		if (!allCompleted) {
			stableCount = null;
			await Bun.sleep(50);
			continue;
		}
		if (stableCount !== requests.length) {
			stableCount = requests.length;
			quietSince = Date.now();
			await Bun.sleep(50);
			continue;
		}
		if (Date.now() - quietSince >= quietMs) return;
		await Bun.sleep(50);
	}
	throw new Error(`mock provider did not reach quiescence within ${timeoutMs}ms`);
}

/** Durable evidence that the plugin processed this session (session_meta row). */
export async function assertSessionProcessed(dataDir: string, sessionId: string): Promise<void> {
	const pluginDbPath = join(dataDir, "cortexkit", "magic-context", "context.db");
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const db = new Database(pluginDbPath, { readonly: true });
		try {
			const row = db
				.query("SELECT COUNT(*) AS n FROM session_meta WHERE session_id = ?")
				.get(sessionId) as { n: number } | null;
			if ((row?.n ?? 0) === 1) return;
		} finally {
			db.close();
		}
		await Bun.sleep(100);
	}
	throw new Error(`oracle leg: plugin never processed session ${sessionId} (no session_meta row)`);
}

/** Spawn knobs the classified leg adds on top of the certified defaults. */
export type OracleSpawnTuning = Partial<
	Pick<SpawnOptions, "extraMockModels" | "smallModelID" | "mockAgentModels">
>;

/**
 * One OC1 boot over `env`: session + scripted turns, capture every provider
 * request. The caller has already restored the seeded store bytes.
 */
export async function runOracleLeg(options: {
	env: IsolatedEnv;
	mock: MockProvider;
	baseURL: string;
	mcEntry: string;
	determinismPluginPath: string;
	/** Prompt texts in order; the caller applies any instrument-control mutation. */
	turnTexts: readonly string[];
	spawnTuning?: OracleSpawnTuning;
}): Promise<CapturedRequest[]> {
	const spawned: SpawnedOpencode = await spawnOpencode({
		mockProviderURL: options.baseURL,
		existingEnv: options.env,
		prepareContextDatabase: false,
		magicContextConfig: SELFTEST_MAGIC_CONTEXT_CONFIG,
		// Wrapper-only list: the wrapper imports the MC entry itself, so the clock
		// patch lands before that import and the MC hooks are not registered twice.
		openCodeConfigExtra: {
			plugin: [pathToFileURL(options.determinismPluginPath).href],
		},
		extraEnv: { TZ: "UTC" },
		expectedMagicContextState: "enabled",
		...(options.spawnTuning ?? {}),
	});
	try {
		if (!existsSync(join(options.env.dataDir, "cortexkit", "magic-context", "context.db"))) {
			throw new Error("oracle leg: context.db missing before boot — seed first");
		}
		const sdk = await import("@opencode-ai/sdk");
		const client = sdk.createOpencodeClient({ baseUrl: spawned.url });
		const created = await client.session.create({
			query: { directory: options.env.workdir },
		});
		const sessionId = created.data?.id;
		if (!sessionId) throw new Error("oracle leg: session.create returned no id");

		const turn = async (text: string) => {
			await client.session.prompt({
				path: { id: sessionId },
				body: {
					model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
					parts: [{ type: "text", text }],
				},
			});
			await waitForMockQuiescence(options.mock);
		};
		for (const [index, text] of options.turnTexts.entries()) {
			await turn(text);
			if (index === 0) {
				// The plugin processes the session during the first prompt
				// (getOrCreateSessionMeta runs inside the first transform pass).
				await assertSessionProcessed(options.env.dataDir, sessionId);
			}
		}
		// Give background stragglers (title generation, sweeps) time to land
		// deterministically before the capture cutoff.
		await waitForMockQuiescence(options.mock, { quietMs: 1500 });
		const captured = options.mock.requests();
		// Affirmative wrapper evidence per leg (the pass arm additionally requires
		// the pinned line inside the compared corpus, R2).
		const wrapperFired = requestsOf(captured).some((request) =>
			rawBodyOf(request).includes(PINNED_LINE),
		);
		if (!wrapperFired) {
			throw new Error(
				`oracle leg: determinism wrapper produced no ${JSON.stringify(PINNED_LINE)} line on the wire — system hook did not fire (the clock freeze cannot be claimed as applied)`,
			);
		}
		return captured;
	} finally {
		await spawned.kill({ root: "keep" });
	}
}

export interface OracleLegPairOptions {
	/** Used in every thrown certification failure to name the run. */
	readonly label: string;
	readonly turnTexts: readonly string[];
	/**
	 * Instrument control: replace this turn's text in leg 2 with
	 * ORACLE_MUTATION_MARKER. The marker constant is what the R3 binding
	 * (assertMutationSpecificDiff) searches for — it must stay the source of truth.
	 */
	readonly mutatedTurnIndex?: number;
	readonly script?: (mock: MockProvider) => void;
	readonly spawnTuning?: OracleSpawnTuning;
}

export interface OracleLegPairResult {
	readonly restore: { restored: number; removed: number };
	readonly snapshotSize: number;
	readonly comparedRequestCount: number;
	readonly legOne: CapturedRequest[];
	readonly legTwo: CapturedRequest[];
	readonly legOneRaw: string[];
	readonly legTwoRaw: string[];
	readonly rawDifferences: RawDiff[];
	readonly canonicalDifferences: RawDiff[];
}

/**
 * Restore the seeded bytes between legs, boot twice, compare the captured
 * request bodies verbatim and through the committed whitelist. The pair is
 * certified before any zero verdict is believed: R2 (non-vacuous corpus with
 * the pinned line) fires inside, and the count-shape check fires here.
 */
export async function runOracleLegPair(
	options: OracleLegPairOptions,
): Promise<OracleLegPairResult> {
	resolvePinnedOpenCode1Host();
	let storeRoot: string | undefined;
	try {
		const env = createIsolatedEnv();
		storeRoot = dirname(env.configDir);
		prepareContextDatabase(env.dataDir);
		const mcEntry = process.env.MC_E2E_PLUGIN_ENTRY ?? PLUGIN_ENTRY;
		if (!mcEntry) throw new Error("oracle leg: MC plugin entry unresolved");
		// The wrapper is written BEFORE the snapshot so both legs replay identical
		// wrapper bytes.
		const determinismPluginPath = join(storeRoot, "determinism-clock-plugin.js");
		writeFileSync(determinismPluginPath, determinismPluginSource(mcEntry));
		const snapshot: StoreSnapshot = snapshotStore(storeRoot);

		const leg = async (iteration: number): Promise<CapturedRequest[]> => {
			const mock = new MockProvider();
			const { baseURL } = await mock.start();
			mock.setDefault({ text: "reply body", usage: LOW_USAGE });
			options.script?.(mock);
			const turnTexts = [...options.turnTexts];
			if (
				iteration === 2 &&
				options.mutatedTurnIndex !== undefined &&
				turnTexts[options.mutatedTurnIndex] !== undefined
			) {
				turnTexts[options.mutatedTurnIndex] = ORACLE_MUTATION_MARKER;
			}
			try {
				return await runOracleLeg({
					env,
					mock,
					baseURL,
					mcEntry,
					determinismPluginPath,
					turnTexts,
					...(options.spawnTuning ? { spawnTuning: options.spawnTuning } : {}),
				});
			} finally {
				await mock.stop();
			}
		};

		const first = requestsOf(await leg(1));
		const restore = restoreStore(storeRoot, snapshot);
		const second = requestsOf(await leg(2));

		if (first.length !== second.length) {
			throw new Error(
				`oracle ${options.label}: request count differs between identical legs — ${first.length} vs ${second.length} (nondeterminism source: request-set shape)`,
			);
		}
		const legOneRaw = first.map((request) => rawBodyOf(request));
		const legTwoRaw = second.map((request) => rawBodyOf(request));
		// R2: refuse a vacuous comparison and prove the wrapper's pinned line is in
		// the corpus actually being compared.
		assertNonVacuousComparedCorpus({ legOneRaw, legTwoRaw, pinnedLine: PINNED_LINE });
		return {
			restore,
			snapshotSize: snapshot.size,
			comparedRequestCount: first.length,
			legOne: first,
			legTwo: second,
			legOneRaw,
			legTwoRaw,
			rawDifferences: compareRawBodies(first, second),
			canonicalDifferences: compareCanonicalBodies(first, second),
		};
	} finally {
		if (storeRoot) cleanupE2ETempDir(storeRoot);
	}
}
