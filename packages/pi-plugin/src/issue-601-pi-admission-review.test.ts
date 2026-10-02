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
	registerPiContextHandler,
} from "./context-handler";
import { contextHost } from "./pi-context-host.test";
import {
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

// Pi opens context.db through openDatabaseAsync() with the default boot busy
// timeout (BOOT_SQLITE_BUSY_TIMEOUT_MS = 5000 in storage-db.ts), not 0.
//
// pi-context-refusal.ts runs the turn handler inside withSqliteTransformPass,
// which is described as giving each in-turn write lock acquisition a 250 ms
// wait. That scope only reaches explicit BEGIN IMMEDIATE/EXCLUSIVE statements
// (installTransactionRouting in shared/sqlite.ts). An autocommit write inside
// the turn, such as the session_meta INSERT OR IGNORE in ensureSessionMetaRow
// reached from commitPiCompactionModeRecord, still waits on the connection's
// 5000 ms busy timeout and blocks the host's event loop for as long as another
// process holds the writer. This test encodes the 250 ms bound: with a
// 3.2 second background hold, the turn must finish (served, replayed or
// refused) well before the hold ends.
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
				await host.emit(handler as never, raw, ctx);
				expect(Math.round(performance.now() - startedAt)).toBeLessThan(
					TURN_BUDGET_MS,
				);
			} finally {
				await exited;
			}
		} finally {
			closeQuietly(db);
		}
	}, 30000);
});
