import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
	gaDatabasePath,
	V2_STORE_READER_DEBUG_COUNTER_KEY,
	type V2StoreReaderDebugCounters,
} from "../../../plugin/src/v2/store-reader";
import {
	spawnOpencode2,
	waitForPluginActive,
} from "../../src/opencode2-runner/spawn";

function decodeCounterObserver() {
	const root = mkdtempSync(join(tmpdir(), "mc-v2-reader-counter-"));
	const trace = join(root, "decodes.jsonl");
	mkdirSync(root, { recursive: true });
	writeFileSync(trace, "");
	writeFileSync(
		join(root, "server.js"),
		`import { appendFileSync } from "node:fs";
const key = Symbol.for(${JSON.stringify(V2_STORE_READER_DEBUG_COUNTER_KEY)});
export default { id: "bounded-reader-observer", async setup(context) {
    globalThis[key] = { decodedRows: 0, operations: {} };
    await context.session.hook("context", async draft => {
        // The adapter schedules reconciliation with a zero-delay timer. Yielding to
        // the timer queue captures its first page before its setImmediate continuation.
        await new Promise(resolve => setTimeout(resolve, 0));
        appendFileSync(${JSON.stringify(trace)}, JSON.stringify({
            sessionID: draft.sessionID,
            counters: globalThis[key],
        }) + "\\n");
    });
}};`,
	);
	return {
		root,
		frames: () =>
			readFileSync(trace, "utf8")
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(
					(line) =>
						JSON.parse(line) as {
							sessionID: string;
							counters: V2StoreReaderDebugCounters;
						},
				),
	};
}

test("the first OpenCode 2 context pass decodes at most one raw-message page", async () => {
	const observer = decodeCounterObserver();
	const host = await spawnOpencode2({ probePlugin: observer.root });
	try {
		const client = OpenCode.make({
			baseUrl: host.url,
			headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
		});
		const session = await client.session.create({
			location: { directory: host.cwd },
			model: { providerID: "openai", id: "mock-model" },
		});
		await waitForPluginActive(client, host.cwd);

		const store = new Database(
			gaDatabasePath(host.env.XDG_DATA_HOME!, "latest", host.env),
		);
		try {
			store.exec("PRAGMA busy_timeout = 5000");
			const latest = store
				.prepare(
					"SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?",
				)
				.get(session.id) as { seq: number | null };
			// The running host owns its in-memory next-seq counter. Leave a large gap so
			// its prompt rows cannot collide with fixture rows inserted after startup.
			const firstSeq = (latest.seq ?? -1) + 1_000_000;
			const insert = store.prepare(
				"INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'user', ?, ?, ?, ?)",
			);
			store.transaction(() => {
				for (let index = 0; index < 5_000; index++) {
					insert.run(
						`msg_bounded_seed_${index}`,
						session.id,
						firstSeq + index,
						1_800_000_000_000 + index,
						1_800_000_000_000 + index,
						JSON.stringify({
							text: `seed ${index}`,
							time: { created: 1_800_000_000_000 + index },
						}),
					);
				}
			})();
		} finally {
			store.close();
		}

		host.mock.setDefault({
			text: "bounded read complete",
			usage: { input_tokens: 100, output_tokens: 10 },
		});
		await client.session.prompt({
			sessionID: session.id,
			text: "Read the bounded tail",
		});
		await client.session.wait(
			{ sessionID: session.id },
			{ signal: AbortSignal.timeout(30_000) },
		);

		const frame = observer.frames().find((candidate) => candidate.sessionID === session.id);
		expect(frame).toBeDefined();
		const counters = frame!.counters;
		expect(counters.operations.latestCompaction?.calls).toBeGreaterThanOrEqual(1);
		expect(counters.operations.history).toBeUndefined();
		for (const operation of Object.values(counters.operations)) {
			expect(operation.maxDecodedRows).toBeLessThanOrEqual(100);
		}
		expect(counters.operations.messageCount?.decodedRows ?? 0).toBe(0);
		expect(counters.decodedRows).toBeLessThanOrEqual(100);
	} catch (error) {
		console.error(host.stderr().slice(-8_000), JSON.stringify(observer.frames()));
		throw error;
	} finally {
		await host.stop();
		rmSync(observer.root, { recursive: true, force: true });
	}
}, 60_000);
