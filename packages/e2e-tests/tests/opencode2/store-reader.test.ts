import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	sourceDatabaseFilename,
	V2StoreReader,
} from "../../../plugin/src/v2/store-reader";
import rows from "../../src/opencode2-runner/host-rows.json";
import { isolation } from "../../src/opencode2-runner/spawn";

// R16's owner ruling removes invalid characters; the audit's older source replaced them with '-'.
// OPENCODE_DB is source rule AND observed honoured by the GA CLI real-host placement test.
test("R16 source filename table covers every channel and override branch", () => {
	for (const channel of ["latest", "dev", "beta", "next", "prod"])
		expect(sourceDatabaseFilename(channel, {})).toBe("opencode.db");
	for (const value of ["1", "true"])
		expect(
			sourceDatabaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: value }),
		).toBe("opencode.db");
	for (const value of ["0", "false", "TRUE", "yes"])
		expect(
			sourceDatabaseFilename("local", { OPENCODE_DISABLE_CHANNEL_DB: value }),
		).toBe("opencode-local.db");
	expect(sourceDatabaseFilename("local", {})).toBe("opencode-local.db");
	expect(sourceDatabaseFilename("release", {})).toBe("opencode-release.db");
	expect(sourceDatabaseFilename("a/b c!._-", {})).toBe("opencode-abc._-.db");
	expect(
		sourceDatabaseFilename("latest", { OPENCODE_DB: "opencode2.db" }),
	).toBe("opencode2.db");
	expect(sourceDatabaseFilename("local", { OPENCODE_DB: ":memory:" })).toBe(
		":memory:",
	);
	expect(sourceDatabaseFilename("local", { OPENCODE_DB: "" })).toBe("");
});

test("session_message_reader seq pages idle boundaries and checkpoint window", () => {
	const { root } = isolation();
	const path = join(root, "fixture.db");
	const writer = new Database(path);
	writer.exec(
		"CREATE TABLE session_message(id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, data TEXT)",
	);
	const insert = writer.prepare(
		"INSERT INTO session_message VALUES (?, ?, ?, ?, ?)",
	);
	for (const row of [...rows].reverse())
		insert.run(
			row.id,
			row.session_id,
			row.type,
			row.seq,
			JSON.stringify(row.data),
		);
	const reader = new V2StoreReader(path);
	const id = rows[0]!.session_id;
	try {
		expect(JSON.stringify(reader.window(id))).toBe(JSON.stringify(rows));
		expect(() =>
			(reader as unknown as { db: Database }).db.exec(
				"DELETE FROM session_message",
			),
		).toThrow();
		expect(reader.page(id, { limit: 1 }).rows[0]?.seq).toBe(4);
		expect(reader.page(id, { limit: 1, after: 4 }).rows[0]?.seq).toBe(5);
		expect(
			reader.idleRows(id).map((row) => [row.seq, row.data.outcome]),
		).toEqual([[10, "succeeded"]]);
		expect(reader.latestCompaction(id)).toBeUndefined();
		// These additional rows exercise cut selection, not the provenance of the real-host fixture above.
		insert.run(
			"z-checkpoint",
			id,
			"compaction",
			12,
			JSON.stringify({ status: "completed", summary: "frozen", recent: "" }),
		);
		insert.run(
			"a-tail",
			id,
			"synthetic",
			13,
			JSON.stringify({ text: "after checkpoint" }),
		);
		insert.run(
			"a-failed",
			id,
			"compaction",
			14,
			JSON.stringify({ status: "failed" }),
		);
		expect(reader.latestCompaction(id)?.seq).toBe(12);
		expect(reader.window(id).map((row) => row.id)).toEqual([
			"z-checkpoint",
			"a-tail",
			"a-failed",
		]);
		expect(reader.window("other")).toEqual([]);
		expect(() => reader.page(id, { limit: 0 })).toThrow();
		const before = createHash("sha256")
			.update(readFileSync(path))
			.digest("hex");
		reader.window(id);
		expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(
			before,
		);
	} finally {
		reader.close();
		writer.close();
	}
	expect(() => new V2StoreReader(join(root, "missing.db"))).toThrow();
});
