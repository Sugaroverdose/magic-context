import { performance } from "node:perf_hooks";
import { runMigrations } from "../../plugin/src/features/magic-context/migrations";
import { initializeDatabase } from "../../plugin/src/features/magic-context/storage-db";
import { resetLkgSlotsForTest } from "../../plugin/src/hooks/magic-context/lkg-slot";
import { Database } from "../../plugin/src/shared/sqlite";
import { closeQuietly } from "../../plugin/src/shared/sqlite-helpers";
import { createPiLkgCoordinator } from "../src/pi-lkg";

type Sample = { role: "user"; content: string; timestamp: number };

function percentile(samples: readonly number[], value: number): number {
	const sorted = [...samples].sort((left, right) => left - right);
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)] ??
		0
	);
}

const messages: Sample[] = Array.from({ length: 2_000 }, (_, index) => ({
	role: "user",
	content: `message-${index}-${"x".repeat(256)}`,
	timestamp: index + 1,
}));
const entryIds = messages.map((_, index) => `entry-${index}`);
const db = new Database(":memory:");
initializeDatabase(db);
runMigrations(db);
let scheduledCapture: (() => void) | undefined;
const coordinator = createPiLkgCoordinator(db, (capture) => {
	scheduledCapture = capture;
});
const synchronousSamples: number[] = [];
const deferredSamples: number[] = [];

try {
	for (let iteration = 0; iteration < 110; iteration += 1) {
		const startedAt = performance.now();
		const snapshot = coordinator.beginPass({
			sessionId: "pi-lkg-benchmark",
			messages,
			entryIds,
			modelKey: "test/benchmark",
			providerKey: "test",
		});
		coordinator.captureAppliedPass({
			snapshot,
			outputMessages: messages,
			cacheBusting: false,
		});
		const synchronousElapsed = performance.now() - startedAt;
		const deferredStartedAt = performance.now();
		scheduledCapture?.();
		const deferredElapsed = performance.now() - deferredStartedAt;
		scheduledCapture = undefined;
		if (iteration >= 10) {
			synchronousSamples.push(synchronousElapsed);
			deferredSamples.push(deferredElapsed);
		}
	}
	console.log(
		JSON.stringify({
			benchmark: "pi_lkg_snapshot",
			messages: messages.length,
			serializedBytes: Buffer.byteLength(JSON.stringify(messages)),
			passes: synchronousSamples.length,
			synchronousP50Ms: Number(percentile(synchronousSamples, 0.5).toFixed(3)),
			synchronousP95Ms: Number(percentile(synchronousSamples, 0.95).toFixed(3)),
			synchronousMaxMs: Number(Math.max(...synchronousSamples).toFixed(3)),
			deferredDigestPersistP95Ms: Number(
				percentile(deferredSamples, 0.95).toFixed(3),
			),
		}),
	);
} finally {
	resetLkgSlotsForTest();
	closeQuietly(db);
}
