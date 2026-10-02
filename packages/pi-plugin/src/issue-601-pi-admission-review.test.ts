import { afterEach, describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { resetEmergencyRecoveryRegistryForTest } from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { resetLkgSlotsForTest } from "@magic-context/core/hooks/magic-context/lkg-slot";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	__test as contextHandlerInternals,
	registerPiContextHandler,
} from "./context-handler";
import { contextHost } from "./pi-context-host.test";
import { notePiLkgProviderUsage } from "./pi-lkg";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// Explicit transactions and autocommit writes share a 250 ms synchronous
// acquisition budget for the entire turn. Execution and scheduler time are not
// lock waiting; this fixture allows overhead but must finish before the writer.
// Pi's 5000 ms connection setting must be restored after every bounded attempt.
const PRODUCTION_PI_BUSY_TIMEOUT_MS = 5000;
const BACKGROUND_HOLD_MS = 3200;
const TURN_BUDGET_MS = 1500;

describe("Pi in-turn lock wait at the production busy timeout", () => {
	const tempDirs: string[] = [];
	const sessions = new Set<string>();

	afterEach(() => {
		for (const sessionId of sessions) clearContextHandlerSession(sessionId);
		sessions.clear();
		resetLkgSlotsForTest();
		resetEmergencyRecoveryRegistryForTest();
		for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
		tempDirs.length = 0;
	});

	for (const mode of [
		"complete",
		"measured usage",
		"steady-state measured usage",
		"different-model usage",
		"missing tools API",
		"throwing system API",
		"oversized tools",
	] as const) {
		it(`a production-timeout busy turn ${mode === "complete" ? "replays its last served prefix and new tail" : mode === "different-model usage" ? "ignores different-model usage and replays" : `refuses ${mode}`}`, async () => {
			const dir = createTestTempDirFromPath(
				join(tmpdir(), "pi-production-timeout-"),
			);
			tempDirs.push(dir);
			const path = join(dir, "context.db");
			const db = createTestDb(path);
			const sessionId = `pi-envelope-${mode}`;
			sessions.add(sessionId);
			const host = contextHost();
			const fake = createFakePi();
			Object.assign(fake.pi, host.api, { getAllTools: () => [] });
			const logs: string[] = [];
			const restoreLog =
				contextHandlerInternals.setLkgRecoveryLogObserverForTests((line) =>
					logs.push(line),
				);
			try {
				updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
				db.exec(`PRAGMA busy_timeout=${PRODUCTION_PI_BUSY_TIMEOUT_MS}`);
				registerPiContextHandler(fake.pi as never, { db });
				const handler = fake.handlers.get("context");
				const raw = [userMessage("last served prefix", 1)];
				const ctx = fakeContext(sessionId, dir, ["entry-1"], raw);
				Object.assign(ctx, {
					model: {
						provider: "openai-codex",
						id: "gpt-5.6-sol",
						contextWindow: 272000,
						maxTokens: 68000,
					},
					getSystemPrompt: () => "Complete current system prompt.",
				});
				const first = await host.emit(handler as never, raw, ctx);
				expect(host.controller.signal.aborted).toBe(false);
				await new Promise<void>((resolve) => setImmediate(resolve));
				if (mode === "steady-state measured usage") {
					const unchangedRaw = [userMessage("last served prefix", 1)];
					const unchangedCtx = fakeContext(
						sessionId,
						dir,
						["entry-1"],
						unchangedRaw,
					);
					Object.assign(unchangedCtx, {
						model: ctx.model,
						getSystemPrompt: ctx.getSystemPrompt,
					});
					expect(
						await host.emit(handler as never, unchangedRaw, unchangedCtx),
					).toEqual(first);
					await new Promise<void>((resolve) => setImmediate(resolve));
				}
				const secondRaw = [
					userMessage("last served prefix", 1),
					assistantMessage("new tail", 2),
				];
				if (
					mode === "measured usage" ||
					mode === "steady-state measured usage" ||
					mode === "different-model usage"
				) {
					Object.assign(secondRaw[1], {
						provider: "openai-codex",
						model:
							mode === "different-model usage"
								? "different-model"
								: "gpt-5.6-sol",
						timestamp: Date.now() + 1,
						stopReason: "stop",
						usage: {
							input: 300000,
							cacheRead: 0,
							cacheWrite: 0,
							output: 10,
							totalTokens: 300010,
						},
					});
					expect(
						notePiLkgProviderUsage(sessionId, "entry-1", secondRaw[1]),
					).toBe(mode !== "different-model usage");
				}
				const secondCtx = fakeContext(
					sessionId,
					dir,
					["entry-1", "entry-2"],
					secondRaw,
				);
				Object.assign(secondCtx.sessionManager, {
					getEntry: (id: string) =>
						id === "entry-2"
							? {
									id,
									parentId: "entry-1",
									type: "message",
									message: secondRaw[1],
								}
							: undefined,
				});
				Object.assign(secondCtx, {
					model: ctx.model,
					getSystemPrompt: ctx.getSystemPrompt,
				});
				if (mode === "missing tools API")
					Object.assign(fake.pi, { getAllTools: undefined });
				if (mode === "throwing system API")
					Object.assign(secondCtx, {
						getSystemPrompt: () => {
							throw new Error("unavailable system prompt");
						},
					});
				if (mode === "oversized tools")
					Object.assign(fake.pi, {
						getAllTools: () => [
							{
								name: "huge",
								description: "word ".repeat(220000),
								parameters: { type: "object", properties: {} },
							},
						],
					});
				const writer = spawn(
					process.execPath,
					[
						"-e",
						`import { Database } from 'bun:sqlite'; const db = new Database(${JSON.stringify(path)}); db.exec('BEGIN IMMEDIATE'); console.log('locked'); setTimeout(() => { db.exec('COMMIT'); db.close(); }, 1000);`,
					],
					{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
				);
				const exited = new Promise<void>((resolve, reject) => {
					writer.once("error", reject);
					writer.once("exit", (code) =>
						code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)),
					);
				});
				try {
					await new Promise<void>((resolve, reject) => {
						writer.stdout.once("data", () => resolve());
						writer.once("error", reject);
					});
					const started = performance.now();
					const served = await host.emit(
						handler as never,
						secondRaw,
						secondCtx,
					);
					const elapsedMs = performance.now() - started;
					if (process.env.MC_BACKGROUND_BENCHMARK === "1")
						console.info(
							JSON.stringify({
								scenario: mode,
								turnMs: elapsedMs,
								refused: host.controller.signal.aborted,
							}),
						);
					expect(elapsedMs).toBeLessThan(TURN_BUDGET_MS);
					if (mode === "complete" || mode === "different-model usage") {
						expect(logs.join("\n")).toContain("LKG replay served");
						expect(served).toEqual([...first, secondRaw[1]]);
						expect(host.controller.signal.aborted).toBe(false);
					} else host.assertRefused(served, secondRaw);
					if (
						mode === "measured usage" ||
						mode === "steady-state measured usage"
					)
						expect(logs.join("\n")).toContain(
							"lkg_fit_basis=provider_input measured_input=300000",
						);
					if (mode === "different-model usage")
						expect(logs.join("\n")).toContain("lkg_fit_basis=host_metadata");
					expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({
						timeout: PRODUCTION_PI_BUSY_TIMEOUT_MS,
					});
				} finally {
					await exited;
				}
			} finally {
				restoreLog();
				closeQuietly(db);
			}
		}, 30000);
	}

	it("does not block a first turn for the whole of a 3.2 s background writer hold", async () => {
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "pi-production-timeout-"),
		);
		tempDirs.push(dir);
		const path = join(dir, "context.db");
		const db = createTestDb(path);
		try {
			const sessionId = "pi-production-timeout";
			sessions.add(sessionId);
			updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
			db.exec(`PRAGMA busy_timeout=${PRODUCTION_PI_BUSY_TIMEOUT_MS}`);
			const host = contextHost();
			const fake = createFakePi();
			Object.assign(fake.pi, host.api);
			registerPiContextHandler(fake.pi as never, { db });
			const handler = fake.handlers.get("context");
			// The lock holder must be another process: this thread blocks inside
			// SQLite while it waits, so a timer here could never release it.
			const writer = spawn(
				process.execPath,
				[
					"-e",
					`import { Database } from 'bun:sqlite';
				const db = new Database(${JSON.stringify(path)});
				db.exec('BEGIN IMMEDIATE'); console.log('locked');
				setTimeout(() => { db.exec('COMMIT'); db.close(); }, ${BACKGROUND_HOLD_MS});`,
				],
				{ stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
			);
			const exited = new Promise<void>((resolve, reject) => {
				writer.once("error", reject);
				writer.once("exit", (code) =>
					code === 0 ? resolve() : reject(new Error(`writer exit ${code}`)),
				);
			});
			try {
				await new Promise<void>((resolve, reject) => {
					writer.stdout.once("data", () => resolve());
					writer.once("error", reject);
				});
				const raw = [userMessage("first turn", 1)];
				const ctx = fakeContext(sessionId, dir, ["entry-1"], raw);
				const startedAt = performance.now();
				const served = await host.emit(handler as never, raw, ctx);
				const elapsedMs = performance.now() - startedAt;
				if (process.env.MC_BACKGROUND_BENCHMARK === "1")
					console.info(
						JSON.stringify({
							scenario: "first-turn-3200ms-holder",
							turnMs: elapsedMs,
							refused: host.controller.signal.aborted,
						}),
					);
				expect(Math.round(elapsedMs)).toBeLessThan(TURN_BUDGET_MS);
				host.assertRefused(served, raw);
				expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({
					timeout: PRODUCTION_PI_BUSY_TIMEOUT_MS,
				});
			} finally {
				await exited;
			}
		} finally {
			closeQuietly(db);
		}
	}, 30000);
});
