/// <reference types="bun-types" />

/**
 * Rust mode on a real OpenCode 2 host, over a 10,000-message session: fold, restart
 * the host, fold again.
 *
 * What it pins:
 *  - the module publishes a boundary before the restart, and after the restart the
 *    adapter still trims to the RECORDED boundary (the post-fold restore and
 *    `trimToRecordedBoundary` read it back from context.db, not from process memory);
 *  - a second, later boundary is published after the restart;
 *  - no pass reads the whole session from the host store: the v2 reader's debug
 *    counters never show a `history` read, no single operation decodes more than
 *    one 100-row page, and the decoded-row total per pass stays bounded while the
 *    session holds 10,000 rows;
 *  - with `single_store` off, the module never holds `context.db` open during the
 *    fold, and `session.status` reports mode "off" with no path.
 *
 * One hermetic daemon + module + GA host per file (see rust-mode-fold-cadence).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { Database } from "../../../plugin/src/shared/sqlite";
import {
	V2_STORE_READER_DEBUG_COUNTER_KEY,
	type V2StoreReaderDebugCounters,
} from "../../../plugin/src/v2/store-reader";
import { driveHistorian } from "../../src/opencode2-runner/conversion-lane";
import { isolation, spawnOpencode2 } from "../../src/opencode2-runner/spawn";
import {
	buildHermeticBinaries,
	detectRustModePrereqs,
	HermeticSubcStack,
} from "../../src/rust-runner/hermetic-subc";

const prereqs = detectRustModePrereqs();
const SEEDED_ROWS = Number(process.env.GATE_SEEDED_ROWS ?? 10_000);

function field(body: string, name: string): string {
	return new RegExp(`\\b${name}=([^\\s]+)`).exec(body)?.[1] ?? "";
}

function logLines(logPath: string, marker: string): string[] {
	if (!existsSync(logPath)) return [];
	return readFileSync(logPath, "utf8")
		.split("\n")
		.filter((line) => line.includes(marker))
		.map((line) => line.slice(line.indexOf(marker) + marker.length));
}

function readCoverage(
	logPath: string,
): Array<{ ocInput: number; markerAt: string }> {
	return logLines(logPath, "rust input coverage: ").map((body) => ({
		ocInput: Number(field(body, "oc_input") || "0"),
		markerAt: field(body, "marker_at"),
	}));
}

function readTrims(logPath: string): number[] {
	return logLines(logPath, "v2 boundary trim: dropped ").map((line) =>
		Number(line.split(" ")[0]),
	);
}

const BALLAST_WORDS = [
	"boundary",
	"historian",
	"compartment",
	"schedule",
	"pressure",
	"tokens",
	"window",
	"publish",
	"transform",
	"session",
	"marker",
	"budget",
	"eligible",
	"protected",
	"ordinal",
	"snapshot",
	"replay",
	"decision",
	"threshold",
];

function ballast(tokens: number): string {
	const parts: string[] = [];
	let length = 0;
	for (let index = 0; length < tokens * 4; index += 1) {
		const word = BALLAST_WORDS[index % BALLAST_WORDS.length]!;
		parts.push(index % 17 === 0 ? `${word}.` : word);
		length += word.length + 1;
	}
	return parts.join(" ");
}

function usageForBody(body: Record<string, unknown>): number {
	return Math.round(
		JSON.stringify(body.input ?? body.messages ?? []).length / 4,
	);
}

/** A probe plugin that writes the v2 reader's cumulative debug counters after each pass. */
function decodeCounterObserver(root: string) {
	const dir = join(root, "reader-observer");
	mkdirSync(dir, { recursive: true });
	const trace = join(dir, "decodes.jsonl");
	writeFileSync(trace, "");
	writeFileSync(
		join(dir, "server.js"),
		`import { appendFileSync } from "node:fs";
const key = Symbol.for(${JSON.stringify(V2_STORE_READER_DEBUG_COUNTER_KEY)});
export default { id: "boundary-gate-reader-observer", async setup(context) {
    globalThis[key] = { decodedRows: 0, operations: {}, openReaders: 0, maxOpenReaders: 0, readersOpened: 0, readersClosed: 0 };
    await context.session.hook("context", async draft => {
        await new Promise(resolve => setTimeout(resolve, 0));
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ sessionID: draft.sessionID, at: Date.now(), counters: globalThis[key] }) + "\\n");
    });
}};`,
	);
	return {
		dir,
		frames: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							sessionID: string;
							at: number;
							counters: V2StoreReaderDebugCounters;
						},
				),
	};
}

/** Every path a process holds open, from lsof's machine-readable output. */
function openPaths(pid: number): string[] {
	const out = Bun.spawnSync([
		"lsof",
		"-Fn",
		"-p",
		String(pid),
	]).stdout.toString();
	return out
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
}

describe.skipIf(!prereqs.ok)(
	`rust mode on OpenCode 2: boundary across a host restart on ${SEEDED_ROWS} rows${prereqs.ok ? "" : ` (skipped: ${prereqs.skipReason})`}`,
	() => {
		let host: Awaited<ReturnType<typeof spawnOpencode2>>;
		let subc: HermeticSubcStack;
		let fixture: ReturnType<typeof isolation>;
		let logPath: string;
		let observer: ReturnType<typeof decodeCounterObserver>;
		const modulePathsSeen = new Set<string>();
		let lsofTimer: ReturnType<typeof setInterval> | undefined;
		const spawnOptions = () => ({
			existingIsolation: fixture,
			modelContextLimit: 24_000,
			modelOutputLimit: 1_024,
			probePlugin: observer.dir,
			magicContextConfig: {
				transform_mode: (process.env.GATE_TRANSFORM_MODE ?? "rust") as
					| "rust"
					| "ts",
				subc: { connection_file: subc.connectionFile },
				memory: { enabled: false },
				dreamer: { disable: true },
				historian: { opencode: { model: "openai/mock-model" } },
				execute_threshold_percentage: 40,
				history_budget_percentage: 0.15,
			},
		});

		const modulePid = (): number | null => {
			const file = join(
				fixture.env.XDG_DATA_HOME!,
				"cortexkit",
				"rust-e2e-pids.json",
			);
			if (!existsSync(file)) return null;
			const record = JSON.parse(readFileSync(file, "utf8")) as {
				pids: Array<{ role: string; pid: number }>;
			};
			return record.pids.find((entry) => entry.role === "module")?.pid ?? null;
		};

		beforeAll(async () => {
			fixture = isolation();
			logPath = join(
				fixture.env.XDG_DATA_HOME!,
				"magic-context-boundary-gate.log",
			);
			fixture.env.MAGIC_CONTEXT_LOG_PATH = logPath;
			observer = decodeCounterObserver(fixture.root);
			const binaries = await buildHermeticBinaries(prereqs.subconsciousRoot!);
			subc = await HermeticSubcStack.start({
				dataDir: fixture.env.XDG_DATA_HOME!,
				ckMcBin: binaries.ckMcBin,
				ckSubcBin: binaries.ckSubcBin,
				startProducer: true,
			});
			host = await spawnOpencode2(spawnOptions());
			host.mock.addMatcher((body) => ({
				text: "ok",
				usage: { input_tokens: usageForBody(body), output_tokens: 20 },
			}));
			// Sample the module's open files for the whole run.
			lsofTimer = setInterval(() => {
				const pid = modulePid();
				if (!pid) return;
				for (const path of openPaths(pid))
					if (/\.db(-wal|-shm)?$/.test(path)) modulePathsSeen.add(path);
			}, 150);
		}, 900_000);

		afterAll(async () => {
			if (lsofTimer) clearInterval(lsofTimer);
			await host?.stop();
			await subc?.stop();
		});

		it("keeps the boundary and bounded reads across a restart, and single_store off never opens context.db", async () => {
			const clientFor = () =>
				OpenCode.make({
					baseUrl: host.url,
					headers: {
						authorization: `Basic ${btoa(`opencode:${host.password}`)}`,
					},
				});
			let client = clientFor();
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			const dbPath = join(
				fixture.env.XDG_DATA_HOME!,
				"opencode",
				"opencode2.db",
			);
			// Seed the long history into the host store while the host is down, so the
			// restarted host numbers its own next rows after it, exactly as it would for
			// a long session a user reopens.
			await host.stopHost();
			{
				const store = new Database(dbPath);
				store.exec("PRAGMA busy_timeout = 5000");
				const latest = store
					.prepare(
						"SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?",
					)
					.get(session.id) as { seq: number | null };
				const firstSeq = (latest.seq ?? -1) + 1;
				const insert = store.prepare(
					"INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', ?, ?, ?, ?)",
				);
				const now = Date.now() - SEEDED_ROWS * 1_000;
				store.transaction(() => {
					for (let index = 0; index < SEEDED_ROWS; index += 1) {
						insert.run(
							`msg_gate_seed_${String(index).padStart(5, "0")}`,
							session.id,
							firstSeq + index,
							now + index,
							now + index,
							JSON.stringify({
								text: `seed ${index}`,
								time: { created: now + index },
							}),
						);
					}
				})();
				// The host numbers new rows from its per-session event sequence, not
				// from MAX(seq); move it past the seeded rows.
				store
					.prepare(
						"UPDATE event_sequence SET seq = MAX(seq, ?) WHERE aggregate_id = ?",
					)
					.run(firstSeq + SEEDED_ROWS + 10, session.id);
				store.close();
			}
			host = await spawnOpencode2({
				...spawnOptions(),
				existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
				existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
			});
			client = clientFor();
			const prompt = async (text: string) => {
				await client.session.prompt({ sessionID: session.id, text });
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(180_000) },
				);
			};
			const pressure = {
				text: "pressure",
				usage: { input_tokens: 20_000, output_tokens: 20 },
			};
			const boundaries = () =>
				new Set(
					readCoverage(logPath)
						.map((entry) => entry.markerAt)
						.filter((marker) => marker !== "none"),
				);

			// ── 1. fold before the restart ───────────────────────────────────────
			await driveHistorian({
				prompt,
				mock: host.mock,
				pressure,
				quiet: pressure,
				label: "a module boundary before the restart",
				satisfied: () => boundaries().size >= 1,
				rounds: 24,
				settleMs: 6_000,
				text: (round) =>
					`turn ${round + 1}: durable signal ${round + 1}. ${ballast(3_000)}`,
			});
			// One more turn so the recorded boundary is read at the start of a pass.
			await prompt(`settle turn. ${ballast(500)}`);
			await Bun.sleep(2_000);
			const beforeBoundaries = boundaries();
			const beforeCoverage = readCoverage(logPath);
			const beforeTrims = readTrims(logPath);
			const beforeFrames = observer
				.frames()
				.filter((frame) => frame.sessionID === session.id);
			console.log(
				`before restart: boundaries=${[...beforeBoundaries].join(",")} passes=${beforeCoverage.length} trims=${beforeTrims.join(" ")}`,
			);
			console.log(
				`oc_input before restart: ${beforeCoverage.map((entry) => entry.ocInput).join(" ")}`,
			);

			// single_store off: the module reports "off" and holds no context.db.
			const status = await subc.moduleStatus(
				session.id,
				host.cwd,
				"session.status",
			);
			const singleStore = (status.single_store ??
				(status.result as Record<string, unknown> | undefined)?.single_store) as
				| Record<string, unknown>
				| undefined;
			console.log(`session.status single_store=${JSON.stringify(singleStore)}`);

			// ── 2. restart the host; the recorded boundary must survive it ─────────
			const restartedFrom = readCoverage(logPath).length;
			const trimsBeforeRestart = readTrims(logPath).length;
			await host.stopHost();
			host = await spawnOpencode2({
				...spawnOptions(),
				existingIsolation: { root: fixture.root, env: host.env, cwd: host.cwd },
				existingMock: { mock: host.mock, baseURL: host.mockBaseURL },
			});
			client = clientFor();
			await prompt(`first turn after the restart. ${ballast(500)}`);
			await Bun.sleep(2_000);
			const firstAfter = readCoverage(logPath).slice(restartedFrom);
			const conversationalRows = (() => {
				const store = new Database(dbPath, { readonly: true });
				try {
					return (
						store
							.prepare(
								"SELECT COUNT(*) AS n FROM session_message WHERE session_id = ? AND type IN ('user','assistant','synthetic')",
							)
							.get(session.id) as { n: number }
					).n;
				} finally {
					store.close();
				}
			})();
			const trimsAfterFirst = readTrims(logPath).slice(trimsBeforeRestart);
			console.log(
				`first pass after restart: coverage=${JSON.stringify(firstAfter)} trims=${trimsAfterFirst.join(" ")}`,
			);

			// ── 3. a second fold after the restart ───────────────────────────────
			await driveHistorian({
				prompt,
				mock: host.mock,
				pressure,
				quiet: pressure,
				label: "a new module boundary after the restart",
				satisfied: () =>
					[...boundaries()].some((marker) => !beforeBoundaries.has(marker)),
				rounds: 24,
				settleMs: 6_000,
				text: (round) =>
					`later turn ${round + 1}: durable signal ${round + 1}. ${ballast(3_000)}`,
			});
			await prompt(`final settle turn. ${ballast(500)}`);
			await Bun.sleep(2_000);
			const afterCoverage = readCoverage(logPath).slice(restartedFrom);
			const afterFrames = observer
				.frames()
				.filter((frame) => frame.sessionID === session.id);
			console.log(
				`oc_input after restart: ${afterCoverage.map((entry) => `${entry.ocInput}@${entry.markerAt.slice(-8)}`).join(" ")}`,
			);
			console.log(`boundaries overall: ${[...boundaries()].join(",")}`);
			const allFrames = [...beforeFrames, ...afterFrames];
			const perOperation: Record<string, number> = {};
			for (const frame of allFrames)
				for (const [name, op] of Object.entries(frame.counters.operations))
					perOperation[name] = Math.max(
						perOperation[name] ?? 0,
						op.maxDecodedRows,
					);
			console.log(
				`max decoded rows per operation: ${JSON.stringify(perOperation)}`,
			);
			// Cumulative counters reset when the host restarts, so per-pass cost is the
			// difference between consecutive frames within one process.
			const perPass = (frames: typeof allFrames) =>
				frames.map(
					(frame, index) =>
						frame.counters.decodedRows -
						(index === 0 ? 0 : frames[index - 1]!.counters.decodedRows),
				);
			const passCosts = [...perPass(beforeFrames), ...perPass(afterFrames)];
			console.log(`decoded rows per pass: ${passCosts.join(" ")}`);
			console.log(
				`module .db files seen by lsof: ${[...modulePathsSeen].join(" ")}`,
			);

			// ── assertions ───────────────────────────────────────────────────────
			expect(beforeBoundaries.size).toBeGreaterThanOrEqual(1);
			expect(singleStore?.mode).toBe("off");
			expect(singleStore?.path ?? null).toBeNull();
			expect(
				[...modulePathsSeen].filter(
					(path) => path.endsWith("context.db") || path.includes("context.db-"),
				),
			).toEqual([]);
			// The recorded boundary survives the restart: the first pass after it is
			// trimmed, not handed the whole 10,000-row history again.
			expect(trimsAfterFirst.length).toBeGreaterThan(0);
			console.log(
				`first pass after restart handed ${firstAfter[0]?.ocInput} of ${conversationalRows} conversational rows to the module`,
			);
			// ...and it is trimmed to the boundary recorded before the restart, not to
			// nothing and not to one the restarted process invented.
			expect(beforeBoundaries.has(firstAfter[0]?.markerAt ?? "none")).toBe(
				true,
			);
			expect(firstAfter[0]?.ocInput ?? Number.POSITIVE_INFINITY).toBeLessThan(
				conversationalRows,
			);
			expect(
				[...boundaries()].some((marker) => !beforeBoundaries.has(marker)),
			).toBe(true);
			for (const frame of allFrames)
				expect(frame.counters.operations.history).toBeUndefined();
			for (const max of Object.values(perOperation))
				expect(max).toBeLessThanOrEqual(100);
			// Skip each process's first pass: a cold seed of a new session is allowed to
			// walk its tail. Every later pass must stay within a handful of pages.
			const steady = [
				...perPass(beforeFrames).slice(1),
				...perPass(afterFrames).slice(1),
			];
			for (const cost of steady) expect(cost).toBeLessThanOrEqual(1_000);
		}, 2_400_000);
	},
);
