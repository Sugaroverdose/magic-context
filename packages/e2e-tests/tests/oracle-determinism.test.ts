/**
 * Unit 1 of the differential rendering oracle
 * (docs/superpowers/plans/2026-11-06-differential-oracle.md): the determinism
 * self-test. One OC1 leg boots twice against the SAME seeded fixture store,
 * restored byte-identically between runs (store-reset contract, plan round-2
 * condition 1), and the captured mock-provider request bodies must be
 * byte-identical modulo the committed whitelist.
 *
 * The determinism wrapper (the idle-ttl-restart.test.ts:876 plugin-wrapper
 * pattern) freezes the host-process clock deterministically (monotonic,
 * +CLOCK_STEP_MS per call — a frozen clock with terminating deadline loops),
 * seeds Math.random, pins TZ through the child env, and pins the served
 * "Today's date" line. The host binary is pinned by a committed expected hash
 * before any spawn (sha256-pins.json precedent from the OC2 lane).
 *
 * Both arms are honesty evidence, not just assertions:
 * - the pass arm compares VERBATIM raw bytes first (N1), then canonicalized
 *   bytes; it refuses zero compared requests and requires the pinned date line
 *   inside the compared corpus (R2);
 * - the instrument-control arm plants a mutation in the second leg's second
 *   turn and requires the diff to involve that request (R3), so ambient
 *   nondeterminism can never green the control.
 */
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { IsolatedEnv } from "../src/opencode-runner/spawn";
import { cleanupE2ETempDir } from "../src/temp-dir";
import { prepareContextDatabase } from "../src/prepare-context-db";
import { restoreStore, snapshotStore } from "../src/oracle/determinism/store-reset";
import { resolvePinnedOpenCode1Host } from "../src/oracle/determinism/host-pin";
import {
	ORACLE_MUTATION_MARKER,
	assertMutationSpecificDiff,
	assertNonVacuousComparedCorpus,
	rawBodyOf,
} from "../src/oracle/determinism/guards";
import {
	byteContext,
	canonicalizeProviderBody,
	committedWhitelistNames,
	firstDiffByte,
} from "../src/oracle/determinism/normalization";
import { MockProvider, type CapturedRequest, type MockUsage } from "../src/mock-provider/server";
import {
	PLUGIN_ENTRY,
	createIsolatedEnv,
	spawnOpencode,
	type SpawnedOpencode,
} from "../src/opencode-runner/spawn";

const LOW_USAGE: MockUsage = {
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
const CLOCK_BASE_MS = 1756684800000;
/**
 * Deterministic clock advance per Date.now() call: barely bigger than zero so
 * host deadline loops (`while (Date.now() < end)`) still terminate, and a leg's
 * internal elapsed measurements depend only on the call sequence — identical
 * call sequences replay identical elapsed values.
 */
const CLOCK_STEP_MS = 7;
const PINNED_DATE = "Mon Sep 01 2025";
const PINNED_LINE = `Today's date: ${PINNED_DATE}`;

/**
 * The determinism wrapper runs in the host process and is the ONLY plugin in the
 * host list, so the MC entry is imported here (the idle-ttl wrapper pattern). Its
 * clock/random patches land at module top level, before that dynamic import.
 */
function determinismPluginSource(mcEntry: string): string {
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
 * Internals off on the self-test leg (oc2-wire-dump.ts precedent): the historian,
 * memory and dreamer completions are not part of the compared artifact; absence
 * equality across legs still holds because every captured request is compared.
 */
const SELFTEST_MAGIC_CONTEXT_CONFIG = {
	memory: { enabled: false },
	historian: { disable: true },
	dreamer: { disable: true },
};

/** All matched provider requests (Anthropic Messages API for the OC1 leg). */
function requestsOf(requests: CapturedRequest[]): CapturedRequest[] {
	return requests.filter(
		(request) =>
			request.method === "POST" && (request.path === "/messages" || request.path === "/v1/messages"),
	);
}

interface RawDiff {
	requestIndex: number;
	firstDiff: number | null;
	contextWant: string;
	contextGot: string;
}

/**
 * Index-paired comparison of the wire. `identity` keeps the bytes verbatim;
 * the canonical path applies only the committed whitelist.
 */
function compareBodies(
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
function compareRawBodies(legOne: CapturedRequest[], legTwo: CapturedRequest[]): RawDiff[] {
	return compareBodies(legOne, legTwo, (raw) => raw);
}

/** Every surviving difference is a nondeterminism source the whitelist cannot explain. */
function compareCanonicalBodies(legOne: CapturedRequest[], legTwo: CapturedRequest[]): RawDiff[] {
	return compareBodies(legOne, legTwo, (raw) => canonicalizeProviderBody(raw, committedWhitelistNames()));
}

function formatDiffs(diffs: RawDiff[], heading: string): string {
	const sample = diffs
		.slice(0, 10)
		.map(
			(diff) =>
				`request#${diff.requestIndex} firstDiffByte=${diff.firstDiff}\n  want: ${JSON.stringify(diff.contextWant)}\n  got:  ${JSON.stringify(diff.contextGot)}`,
		)
		.join("\n");
	return `${heading}\n${sample}`;
}

async function waitForMockQuiescence(
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
async function assertSessionProcessed(dataDir: string, sessionId: string): Promise<void> {
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

/**
 * One OC1 boot over `env`: session + two scripted turns, capture every provider
 * request. The caller has already restored the seeded store bytes.
 */
async function runOracleLeg(options: {
	env: IsolatedEnv;
	mock: MockProvider;
	baseURL: string;
	mcEntry: string;
	determinismPluginPath: string;
	/** Instrument control: plant a mutation in this leg's second turn. */
	mutateSecondTurn?: boolean;
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
		await turn("first user turn");
		// The plugin processes the session during the first prompt
		// (getOrCreateSessionMeta runs inside the first transform pass).
		await assertSessionProcessed(options.env.dataDir, sessionId);
		await turn(options.mutateSecondTurn ? ORACLE_MUTATION_MARKER : "second user turn");
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

describe("oracle unit 1: determinism self-test (OC1 leg, same store twice)", () => {
	interface SelfTestResult {
		restore: Awaited<ReturnType<typeof restoreStore>>;
		snapshotSize: number;
		comparedRequestCount: number;
		legOneRaw: string[];
		legTwoRaw: string[];
		rawDifferences: RawDiff[];
		canonicalDifferences: RawDiff[];
	}

	/**
	 * Restore the seeded bytes between legs, boot twice, compare the captured
	 * request bodies verbatim and through the committed whitelist. `mutateSecondTurn`
	 * plants the instrument control — a deliberately different prompt in leg 2.
	 */
	async function runSelfTest(options: { mutateSecondTurn?: boolean } = {}): Promise<SelfTestResult> {
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
			const snapshot = snapshotStore(storeRoot);

			const leg = async (iteration: number): Promise<CapturedRequest[]> => {
				const mock = new MockProvider();
				const { baseURL } = await mock.start();
				mock.setDefault({ text: "reply body", usage: LOW_USAGE });
				try {
					return await runOracleLeg({
						env,
						mock,
						baseURL,
						mcEntry,
						determinismPluginPath,
						mutateSecondTurn: options.mutateSecondTurn === true && iteration === 2,
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
					`oracle determinism: request count differs between identical legs — ${first.length} vs ${second.length} (nondeterminism source: request-set shape)`,
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
				legOneRaw,
				legTwoRaw,
				rawDifferences: compareRawBodies(first, second),
				canonicalDifferences: compareCanonicalBodies(first, second),
			};
		} finally {
			if (storeRoot) cleanupE2ETempDir(storeRoot);
		}
	}

	it(
		"boots the OC1 leg twice over the restored seed and reproduces byte-identical provider request bodies",
		async () => {
			const result = await runSelfTest();
			expect(result.restore.restored).toBe(result.snapshotSize);
			if (result.comparedRequestCount === 0) {
				throw new Error(
					"oracle determinism: zero compared provider requests — an empty capture is not a passing determinism run",
				);
			}
			// N1: verbatim raw identity is a live assertion, not a discarded commit.
			if (result.rawDifferences.length > 0) {
				throw new Error(
					formatDiffs(
						result.rawDifferences,
						`oracle determinism RAW RED: ${result.rawDifferences.length} provider request bodies differ byte-for-byte between identical legs (before any whitelist)`,
					),
				);
			}
			if (result.canonicalDifferences.length > 0) {
				throw new Error(
					formatDiffs(
						result.canonicalDifferences,
						`oracle determinism CANONICAL RED: ${result.canonicalDifferences.length} provider request bodies differ after the committed whitelist`,
					),
				);
			}
			expect(result.rawDifferences).toEqual([]);
			expect(result.canonicalDifferences).toEqual([]);
		},
		420_000,
	);

	it(
		"instrument control: the mutation must produce a diff at or after the mutated request",
		async () => {
			const result = await runSelfTest({ mutateSecondTurn: true });
			// R3: keeps the dark-control throw, binds the diff to the mutated request,
			// and rejects ambient differences before it.
			const mutationIndex = assertMutationSpecificDiff({
				differences: result.canonicalDifferences,
				legOneRaw: result.legOneRaw,
				legTwoRaw: result.legTwoRaw,
				marker: ORACLE_MUTATION_MARKER,
			});
			// The live raw comparator must see the same mutation, not only the
			// canonical path (N1 sensitivity).
			const rawBound = result.rawDifferences.filter(
				(diff) => diff.requestIndex >= mutationIndex,
			);
			if (rawBound.length === 0) {
				throw new Error(
					`oracle determinism: the raw comparator saw no diff at or after the mutated request#${mutationIndex} — the control only moved canonicalized bytes`,
				);
			}
			expect(mutationIndex).toBeGreaterThanOrEqual(0);
		},
		420_000,
	);
});
