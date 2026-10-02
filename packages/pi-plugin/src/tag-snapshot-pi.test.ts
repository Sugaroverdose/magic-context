import { expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "@magic-context/core/features/magic-context/migrations";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { Database } from "@magic-context/core/shared/sqlite";
import { createPiTagSnapshotReader } from "./tag-snapshot-pi";

it("tag snapshots reuse unchanged rows and invalidate local, external and rollback changes", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tags-"));
	const db = new Database(join(root, "context.db"));
	initializeDatabase(db);
	runMigrations(db);
	const other = new Database(join(root, "context.db"));
	const insert = (connection: Database, id: string, number: number) =>
		connection
			.prepare(
				"INSERT INTO tags (message_id, type, status, session_id, tag_number, byte_size) VALUES (?, 'message', 'active', 'session', ?, 0)",
			)
			.run(id, number);
	try {
		insert(db, "one", 1);
		const read = createPiTagSnapshotReader(db);
		const first = read("session");
		const prepare = spyOn(db, "prepare");
		try {
			const firstTag = first[0];
			if (!firstTag) throw new Error("expected seeded tag");
			firstTag.status = "dropped";
			expect(read("session")[0]?.status).toBe("active");
			db.prepare("UPDATE session_meta SET last_context_percentage = 1").run();
			read("session");
			expect(
				prepare.mock.calls.filter(([sql]) =>
					sql.includes("FROM tags WHERE session_id"),
				),
			).toHaveLength(0);
		} finally {
			prepare.mockRestore();
		}
		db.prepare(
			"UPDATE tags SET status = 'dropped' WHERE message_id = 'one'",
		).run();
		expect(read("session")[0]?.status).toBe("dropped");
		insert(other, "two", 2);
		expect(read("session")).toHaveLength(2);
		db.exec("BEGIN");
		insert(db, "three", 3);
		expect(read("session")).toHaveLength(3);
		db.exec("ROLLBACK");
		expect(read("session")).toHaveLength(2);
		db.prepare("DELETE FROM tags WHERE message_id = 'two'").run();
		expect(read("session")).toHaveLength(1);
	} finally {
		other.close();
		db.close();
		rmSync(root, { recursive: true, force: true });
	}
});
