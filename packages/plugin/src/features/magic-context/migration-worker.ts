/**
 * Worker-thread entry that applies pending schema migrations to context.db.
 *
 * A migration can rewrite hundreds of megabytes inside one SQLite transaction,
 * which takes seconds to tens of seconds on a large store. SQLite calls are
 * synchronous, so on the host's main thread that time froze the host: OpenCode
 * stopped answering `/health` and a supervisor could kill it. Here the work runs
 * on its own thread with its own connection, with exactly the code the main
 * thread used to run (`initializeDatabase` then `runMigrationsWithRetry`), so the
 * write lock, BEGIN IMMEDIATE, sibling-conflict handling and fail-closed errors
 * are unchanged. The caller (migration-worker-client.ts) checks the guards before
 * starting this worker and the schema fence after it finishes.
 */
import { parentPort, workerData } from "node:worker_threads";
import { setLogLineForwarder } from "../../shared/logger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import type { MigrationWorkerData, MigrationWorkerMessage } from "./migration-worker-protocol";
import { runMigrationsWithRetry } from "./migrations";
import { initializeDatabase, setSqlitePragmaConfig } from "./storage-db";

function post(message: MigrationWorkerMessage): void {
    parentPort?.postMessage(message);
}

async function main(): Promise<void> {
    const data = workerData as MigrationWorkerData;
    setLogLineForwarder((line) => post({ type: "log", line }));
    setSqlitePragmaConfig(data.sqlitePragmaConfig);
    post({ type: "ready" });
    let db: Database | undefined;
    try {
        db = new Database(data.dbPath);
        initializeDatabase(db, data.busyTimeoutMs);
        await runMigrationsWithRetry(db, {
            // Waiting for another process's write lock is idle time for the boot
            // deadline, as it was when this ran on the main thread.
            sleep: async (delayMs) => {
                post({ type: "lock-wait", waiting: true });
                await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
                post({ type: "lock-wait", waiting: false });
            },
        });
        post({ type: "done" });
    } catch (error) {
        post({
            type: "failed",
            message: error instanceof Error ? error.message : String(error),
        });
    } finally {
        if (db) closeQuietly(db);
        setLogLineForwarder(null);
    }
}

void main();
