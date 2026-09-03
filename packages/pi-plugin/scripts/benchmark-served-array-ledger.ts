#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__test,
	capturePiServedArray,
	flushPiServedArrayLedger,
} from "../src/served-array-ledger";

const MESSAGE_COUNT = 2_000;
const WARMUP_RUNS = 10;
const MEASURED_RUNS = 100;

function fixture(): Record<string, unknown>[] {
	return Array.from({ length: MESSAGE_COUNT }, (_, index) => ({
		role:
			index % 3 === 0 ? "user" : index % 3 === 1 ? "assistant" : "toolResult",
		content: [
			{
				type: "text",
				text: `fixture-${index}-${"x".repeat(160 + (index % 41))}`,
			},
		],
		timestamp: index,
	}));
}

function percentile(sorted: readonly number[], fraction: number): number {
	return sorted[
		Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
	];
}

const storageDir = mkdtempSync(join(tmpdir(), "pi-served-array-benchmark-"));
try {
	const messages = fixture();
	for (let index = 0; index < WARMUP_RUNS; index += 1) {
		capturePiServedArray("benchmark", messages, { storageDir });
	}
	const samples: number[] = [];
	for (let index = 0; index < MEASURED_RUNS; index += 1) {
		const start = performance.now();
		capturePiServedArray("benchmark", messages, { storageDir });
		samples.push(performance.now() - start);
	}
	samples.sort((left, right) => left - right);
	console.log(
		JSON.stringify({
			message_count: MESSAGE_COUNT,
			measured_runs: MEASURED_RUNS,
			p50_ms: Number(percentile(samples, 0.5).toFixed(3)),
			p95_ms: Number(percentile(samples, 0.95).toFixed(3)),
			max_ms: Number(samples.at(-1)?.toFixed(3)),
		}),
	);
} finally {
	flushPiServedArrayLedger();
	__test.reset();
	rmSync(storageDir, { recursive: true, force: true });
}
