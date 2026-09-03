import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__test,
	capturePiServedArray,
	flushPiServedArrayLedger,
	getPiServedArrayBodyPath,
	getPiServedArrayLedgerPath,
	PI_SERVED_ARRAY_TAIL_MESSAGES,
} from "./served-array-ledger";

const temporaryDirectories: string[] = [];

afterEach(() => {
	__test.reset();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "pi-served-array-ledger-"));
	temporaryDirectories.push(directory);
	return directory;
}

function message(index: number): Record<string, unknown> {
	return {
		role: index % 2 === 0 ? "user" : "assistant",
		content: [{ type: "text", text: `message ${index}` }],
		timestamp: index,
	};
}

describe("Pi served-array digest ledger", () => {
	test("persists one full-array digest and exact first divergence per pass", () => {
		const storageDir = temporaryDirectory();
		const sessionId = "019-test-session";
		const firstMessages = [message(0), message(1), message(2)];
		const secondMessages = [
			message(0),
			{ ...message(1), timestamp: 99 },
			message(2),
		];

		const first = capturePiServedArray(sessionId, firstMessages, {
			storageDir,
			now: new Date("2026-09-04T10:00:00.000Z"),
		});
		const second = capturePiServedArray(sessionId, secondMessages, {
			storageDir,
			now: new Date("2026-09-04T10:00:01.000Z"),
		});
		flushPiServedArrayLedger();

		expect(first?.sha256).toBe(
			createHash("sha256").update(JSON.stringify(firstMessages)).digest("hex"),
		);
		expect(first?.first_divergence_message_index).toBeNull();
		expect(second?.previous_sha256).toBe(first?.sha256);
		expect(second?.first_divergence_message_index).toBe(1);
		expect(second?.block_vectors).toHaveLength(3);
		expect(second?.block_vectors[1]).toStartWith("assistant:text(");

		const rows = readFileSync(
			getPiServedArrayLedgerPath(sessionId, storageDir),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(rows).toEqual([first, second]);
		expect(() =>
			readFileSync(getPiServedArrayBodyPath(sessionId, storageDir), "utf8"),
		).toThrow();
	});

	test("limits block vectors to the newest 40 messages", () => {
		const messages = Array.from(
			{ length: PI_SERVED_ARRAY_TAIL_MESSAGES + 5 },
			(_, index) => message(index),
		);
		const record = capturePiServedArray("tail-limit", messages, {
			storageDir: temporaryDirectory(),
		});

		expect(record?.block_vector_start).toBe(5);
		expect(record?.block_vectors).toHaveLength(PI_SERVED_ARRAY_TAIL_MESSAGES);
		expect(record?.block_vectors[0]).toStartWith("assistant:text(");
	});

	test("writes exact served bodies only when explicitly enabled", () => {
		const storageDir = temporaryDirectory();
		const sessionId = "body-opt-in";
		const messages = [message(0), message(1)];

		const record = capturePiServedArray(sessionId, messages, {
			storageDir,
			fullBodyCapture: true,
		});
		flushPiServedArrayLedger();

		const body = JSON.parse(
			readFileSync(
				getPiServedArrayBodyPath(sessionId, storageDir),
				"utf8",
			).trim(),
		);
		expect(body.sha256).toBe(record?.sha256);
		expect(body.messages).toEqual(messages);
	});

	test("contains unserializable input instead of affecting the provider pass", () => {
		const circular: Record<string, unknown> = { role: "user" };
		circular.content = circular;

		expect(
			capturePiServedArray("circular", [circular], {
				storageDir: temporaryDirectory(),
			}),
		).toBeUndefined();
		expect(__test.getDiagnostics().swallowedWriteCount).toBe(1);
	});
});
