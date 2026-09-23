/**
 * Boot the real OpenCode 1.18.x host and the real OpenCode 2.0.5 host, in turn,
 * on ONE throwaway data root, with the Magic Context plugin loaded on both.
 *
 * This is the only place in the suite where both host generations write the same
 * OpenCode store. The 2.x host converts the 1.x `message`/`part` tables into its
 * own `session_message` projection on first open, which renumbers the message
 * list Magic Context saved its coordinates against. Reproducing that needs a
 * store a real 1.x host wrote, a real 2.x host to convert it, and a real 1.x host
 * to open it again on the way back.
 *
 * Isolation is the whole safety story here, because the 1.x binary this uses is
 * whatever `opencode` the operator has on PATH — the same binary their own
 * sessions run under. What makes that safe is the ROOT, not the binary: every
 * private directory, the OpenCode database filename and the Magic Context
 * storage directory are redirected into a throwaway tree under the temp
 * directory, the child environment is an allowlist rather than an inherited one,
 * and the child's open file descriptors are sampled and checked against the
 * operator's live store before and after the run.
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pinMockAgents } from "../mock-routing";
import type { MockProvider } from "../mock-provider/server";
import { waitForReady } from "../opencode-runner/spawn";
import { prepareContextDatabase } from "../prepare-context-db";
import { isolateStoreDirectories } from "./store-directories";
import { assertWriteFenceUnchanged, snapshotWriteFence } from "./write-fence";
import {
	assertIsolation,
	assertLiveUnchanged,
	assertOpenPaths,
	type OpenCode2Isolation,
	PLUGIN,
	ROOT_KEYS,
	snapshotLive,
} from "./spawn";

/** The 1.x host needs a separate config home because the host generations use different config shapes. */
const EXTRA_ROOT_KEYS = ["OPENCODE1_CONFIG_HOME"] as const;

/**
 * Both generations must name the SAME provider and model.
 *
 * The 2.x host resolves a converted session's model from the id the 1.x host
 * recorded on it; registering the mock under a 1.x-only name makes the first
 * prompt after the flip fail with `Model unavailable` before any Magic Context
 * hook runs. The id is the v2 runner's default, and the 1.x side overrides the
 * npm package explicitly, so on 1.x the mock still speaks the Anthropic Messages
 * API this suite's mock provider already serves.
 */
export const SHARED_MOCK_PROVIDER_ID = "openai";
export const SHARED_MOCK_MODEL_ID = "mock-model";

export interface ConversionFixture extends OpenCode2Isolation {
	/** Absolute path of the single OpenCode store both generations open. */
	openCodeDbPath: string;
	/** Absolute path of the single Magic Context store both generations open. */
	contextDbPath: string;
	/** Magic Context storage directory, passed explicitly to both hosts. */
	storageDir: string;
	/** Per-boot plugin log, so one boot's log lines can be counted without the others'. */
	logPath: (label: string) => string;
}

/**
 * One throwaway root holding every private directory both hosts will use.
 *
 * Laid out the way `isolation()` in the v2 runner lays out its own root, so the
 * result can be handed straight to `spawnOpencode2({ existingIsolation })` and
 * pass that runner's environment guard unchanged. The task-named base
 * (`$TMPDIR/magic-context/<label>/`) keeps every file this lane writes under one
 * prefix an operator can identify and delete.
 */
export function conversionFixture(label: string): ConversionFixture {
	const base = join(tmpdir(), "magic-context", label);
	mkdirSync(base, { recursive: true });
	const root = realpathSync(mkdtempSync(join(base, "root-")));
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		OPENCODE_DB: "opencode2.db",
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
	};
	for (const key of [...ROOT_KEYS, ...EXTRA_ROOT_KEYS]) {
		env[key] = join(root, key);
		mkdirSync(env[key]!);
	}
	const cwd = join(root, "work");
	mkdirSync(cwd);
	const storageDir = join(env.XDG_DATA_HOME!, "cortexkit", "magic-context");
	// Both hosts are told the storage directory explicitly. The XDG-derived path
	// already resolves here, so this only removes the chance that a host resolves
	// it some other way and reaches outside the throwaway root.
	env.MAGIC_CONTEXT_STORAGE_DIR = storageDir;
	env.MAGIC_CONTEXT_LOG_PATH = join(root, "magic-context-v2.log");
	return {
		root,
		env,
		cwd,
		openCodeDbPath: join(env.XDG_DATA_HOME!, "opencode", "opencode2.db"),
		contextDbPath: join(storageDir, "context.db"),
		storageDir,
		logPath: (label) => join(root, `magic-context-${label}.log`),
	};
}

/**
 * Resolve the 1.x binary the OpenCode 1 harness would spawn, and prove it really
 * is 1.x.
 *
 * The harness spawns bare `opencode` from PATH, so this lane does the same. A 2.x
 * binary there would silently turn the "old host" leg into a second new-host leg
 * and every conversion assertion below would pass for the wrong reason, so the
 * version is checked rather than assumed.
 */
export function resolveOpenCode1CLI(): string {
	const override = process.env.MC_E2E_OPENCODE1_CLI;
	const path = override ? resolve(override) : (Bun.which("opencode") ?? "");
	if (!path || !existsSync(path)) {
		throw new Error(
			"No OpenCode 1.x binary found: set MC_E2E_OPENCODE1_CLI or put `opencode` on PATH",
		);
	}
	const probe = spawnSync(path, ["--version"], { encoding: "utf8" });
	const version = (probe.stdout ?? "").trim().split("\n").pop()?.trim() ?? "";
	if (!/^1\.\d+\./.test(version)) {
		throw new Error(
			`Expected an OpenCode 1.x binary at ${path}, got version ${JSON.stringify(version)}`,
		);
	}
	return path;
}

/** Whether some other OpenCode host is already serving, which would make a live-store snapshot ambiguous. */
function foreignServeRunning(ownPid?: number): boolean {
	const result = spawnSync("pgrep", ["-alf", "opencode"], { encoding: "utf8" });
	if (result.error || (result.status !== 0 && result.status !== 1)) {
		throw new Error("Cannot determine whether a live OpenCode host owns the store");
	}
	if (result.status !== 0) return false;
	return result.stdout
		.split("\n")
		.filter((line) => /\bserve\b/.test(line))
		.some((line) => Number(line.trim().split(/\s+/)[0]) !== ownPid);
}

/** Every strict ancestor directory of `path`, from its parent up to the filesystem root. */
function ancestorDirectories(path: string): Set<string> {
	const ancestors = new Set<string>();
	let current = dirname(path);
	while (true) {
		ancestors.add(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	return ancestors;
}

/**
 * Sample the 1.x child's whole process group and refuse any descriptor outside
 * the throwaway root, then require that the store it opened is the throwaway one
 * by inode rather than by name.
 *
 * Mirrors the v2 runner's guard. It is written out again here instead of reused
 * because the allowed set differs in two ways.
 *
 * First, this child is the operator's own `opencode` binary and loads the plugin
 * bundle from the checkout, so both of those paths are expected.
 *
 * Second, OpenCode 1.18.x holds a read-only directory handle on every ancestor of
 * its working directory — observed here as descriptors walking from the
 * throwaway root up to `/`. Those exact directory paths are dropped before the
 * check, and only those: a handle on any FILE, or on any directory that is not
 * an ancestor of the throwaway root, is still refused, so a descriptor on the
 * operator's store or home still fails. The 2.x host does not do this, which is
 * why the shared v2 guard has no such allowance.
 */
export function inspectOpenCode1Files(
	pid: number,
	fixture: ConversionFixture,
	cliPath: string,
): string[] {
	const ps = spawnSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" });
	if (ps.status !== 0) throw new Error("Cannot inspect v1 process group");
	const pids = ps.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter(([, group]) => Number(group) === pid)
		.map(([id]) => id);
	if (!pids.length) throw new Error("v1 process group disappeared before fd inspection");
	const result = spawnSync("lsof", ["-p", pids.join(","), "-Fin"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Cannot inspect v1 open files: ${result.stderr}`);
	const paths = result.stdout
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
	const ancestors = ancestorDirectories(fixture.root);
	assertOpenPaths(
		paths.filter((path) => !ancestors.has(path)),
		fixture.root,
		[
			realpathSync(resolve(PLUGIN, "../../node_modules")),
			realpathSync(PLUGIN),
			realpathSync(cliPath),
		],
	);
	const expected = statSync(fixture.openCodeDbPath);
	let inode: number | undefined;
	const opened = result.stdout.split("\n").some((line) => {
		if (line.startsWith("i")) inode = Number(line.slice(1));
		return line === `n${fixture.openCodeDbPath}` && inode === expected.ino;
	});
	if (!opened) {
		throw new Error("v1 child did not open its throwaway XDG_DATA_HOME database");
	}
	return paths;
}

export interface SpawnOpenCode1Options {
	fixture: ConversionFixture;
	/** Already-running mock provider; the same instance serves both generations. */
	mock: MockProvider;
	mockBaseURL: string;
	magicContextConfig?: Record<string, unknown>;
	modelContextLimit?: number;
	modelOutputLimit?: number;
	/** Names this boot's plugin log file, so each boot's lines can be counted on their own. */
	logLabel?: string;
}

export interface SpawnedOpenCode1 {
	url: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	fixture: ConversionFixture;
	stdout: () => string;
	stderr: () => string;
	/** Stop the host and leave the mock provider running for the next generation. */
	stop: () => Promise<void>;
}

const liveGroups = new Set<number>();
function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}
process.once("exit", () => {
	for (const pid of liveGroups) killGroup(pid);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.once(signal, () => {
		for (const pid of liveGroups) killGroup(pid);
		process.exit(1);
	});
}

/**
 * Boot the real OpenCode 1.18.x host on the shared throwaway root with the plugin
 * loaded and the mock provider registered.
 *
 * The 1.x config lives in a config home of its own under the same root: the 2.x
 * host writes a config in a different shape (plural `plugins`/`providers`), and
 * neither host should be asked to parse the other's file. The project-level
 * config the 2.x runner writes into the shared working directory is switched off
 * for the same reason.
 */
export async function spawnOpencode1(
	options: SpawnOpenCode1Options,
): Promise<SpawnedOpenCode1> {
	const { fixture, mockBaseURL } = options;
	const cli = resolveOpenCode1CLI();
	const configHome = fixture.env.OPENCODE1_CONFIG_HOME!;
	const env: NodeJS.ProcessEnv = {
		PATH: process.env.PATH,
		HOME: fixture.env.HOME,
		XDG_CONFIG_HOME: configHome,
		XDG_DATA_HOME: fixture.env.XDG_DATA_HOME,
		XDG_STATE_HOME: fixture.env.XDG_STATE_HOME,
		XDG_CACHE_HOME: fixture.env.XDG_CACHE_HOME,
		XDG_RUNTIME_DIR: fixture.env.XDG_RUNTIME_DIR,
		CARGO_HOME: fixture.env.CARGO_HOME,
		RUSTUP_HOME: fixture.env.RUSTUP_HOME,
		OPENCODE_DB: "opencode2.db",
		OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
		OPENCODE_DISABLE_PROJECT_CONFIG: "true",
		OPENCODE_DISABLE_AUTOUPDATE: "true",
		MAGIC_CONTEXT_STORAGE_DIR: fixture.storageDir,
		MAGIC_CONTEXT_LOG_PATH: fixture.logPath(options.logLabel ?? "v1"),
		ANTHROPIC_API_KEY: "mock-key-not-real",
	};
	// Same environment guard the v2 runner applies, against the same root.
	assertIsolation(fixture.root, env);
	const references = isolateStoreDirectories(fixture.root, fixture.openCodeDbPath, fixture.contextDbPath);
	fixture.referencedDirectories = [...new Set([...(fixture.referencedDirectories ?? []), ...references])];

	const pluginEntry = join(PLUGIN, "dist/index.js");
	if (!existsSync(pluginEntry)) {
		throw new Error("Build the plugin before booting the 1.x host");
	}
	const openCodeConfigDir = join(configHome, "opencode");
	mkdirSync(openCodeConfigDir, { recursive: true });
	writeFileSync(
		join(openCodeConfigDir, "opencode.json"),
		JSON.stringify(
			{
				$schema: "https://opencode.ai/config.json",
				plugin: [`file://${pluginEntry}`],
				autoupdate: false,
				// Magic Context disables itself when the host also compacts.
				compaction: { auto: false, prune: false },
				enabled_providers: [SHARED_MOCK_PROVIDER_ID],
				model: `${SHARED_MOCK_PROVIDER_ID}/${SHARED_MOCK_MODEL_ID}`,
				small_model: `${SHARED_MOCK_PROVIDER_ID}/${SHARED_MOCK_MODEL_ID}`,
				provider: {
					[SHARED_MOCK_PROVIDER_ID]: {
						api: "@ai-sdk/anthropic",
						name: "Mock provider",
						npm: "@ai-sdk/anthropic",
						env: [],
						options: { apiKey: "mock-key-not-real", baseURL: mockBaseURL },
						models: {
							[SHARED_MOCK_MODEL_ID]: {
								id: SHARED_MOCK_MODEL_ID,
								name: `Mock ${SHARED_MOCK_MODEL_ID}`,
								cost: { input: 0, output: 0 },
								limit: {
									context: options.modelContextLimit ?? 200_000,
									output: options.modelOutputLimit ?? 8192,
								},
								modalities: { input: ["text"], output: ["text"] },
								options: {},
							},
						},
					},
				},
			},
			null,
			2,
		),
	);
	writeFileSync(
		join(openCodeConfigDir, "magic-context.jsonc"),
		JSON.stringify(
			{
				auto_update: false,
				embedding: { provider: "off" },
				...pinMockAgents(
					options.magicContextConfig,
					`${SHARED_MOCK_PROVIDER_ID}/${SHARED_MOCK_MODEL_ID}`,
				),
			},
			null,
			2,
		),
	);
	prepareContextDatabase(fixture.env.XDG_DATA_HOME!);

	const fence = snapshotWriteFence(fixture.referencedDirectories ?? []);
	const before = foreignServeRunning() ? undefined : snapshotLive();
	const child: ChildProcess = spawn(
		cli,
		["serve", "--port", "0", "--hostname", "127.0.0.1"],
		{ cwd: fixture.cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	if (child.pid) liveGroups.add(child.pid);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const exited = new Promise<void>((done) => child.once("close", () => done()));
	const stop = async () => {
		let safetyError: unknown;
		try {
			if (child.pid && child.exitCode === null && child.signalCode === null) {
				inspectOpenCode1Files(child.pid, fixture, cli);
			}
		} catch (error) {
			safetyError = error;
		}
		if (child.pid) killGroup(child.pid);
		await exited;
		if (child.pid) liveGroups.delete(child.pid);
		if (before) assertLiveUnchanged(before);
		assertWriteFenceUnchanged(fence);
		if (safetyError) throw safetyError;
	};

	try {
		const deadline = Date.now() + 60_000;
		let port = 0;
		while (Date.now() < deadline && port === 0) {
			const match = stdout.match(/listening on https?:\/\/[^:\s]+:(\d+)/);
			if (match) {
				port = Number(match[1]);
				break;
			}
			if (child.exitCode !== null || child.signalCode !== null) {
				throw new Error(`v1 exited before reporting its port\n${stdout}\n${stderr}`);
			}
			await Bun.sleep(25);
		}
		if (port === 0) throw new Error(`v1 did not report a port\n${stdout}\n${stderr}`);
		const url = `http://127.0.0.1:${port}`;
		await waitForReady(url, fixture.cwd, 120_000, {
			expectedMagicContextState: "enabled",
			mockProviderID: SHARED_MOCK_PROVIDER_ID,
			mockModelID: SHARED_MOCK_MODEL_ID,
		});
		if (child.pid) inspectOpenCode1Files(child.pid, fixture, cli);
		return {
			url,
			cwd: fixture.cwd,
			env,
			fixture,
			stdout: () => stdout,
			stderr: () => stderr,
			stop,
		};
	} catch (error) {
		await stop().catch(() => undefined);
		throw error;
	}
}

/** Fail a fixture build loudly rather than silently proving nothing about an unconverted store. */
export function assertUnder(path: string, root: string, label: string): void {
	const suffix = relative(realpathSync(root), path);
	if (!suffix || suffix.startsWith("..") || path === homedir()) {
		throw new Error(`${label} is not inside the throwaway root: ${path}`);
	}
}
