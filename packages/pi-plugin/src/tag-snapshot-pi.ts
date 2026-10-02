import { getTagsBySession } from "@magic-context/core/features/magic-context/storage-tags";
import type { Database } from "@magic-context/core/shared/sqlite";

/** Connection-local tag revisions avoid invalidating snapshots for unrelated metadata writes. */
export function createPiTagSnapshotReader(db: Database) {
	db.exec(`
		CREATE TEMP TABLE IF NOT EXISTS pi_tag_revision (revision INTEGER NOT NULL);
		INSERT INTO pi_tag_revision SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM pi_tag_revision);
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_insert AFTER INSERT ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_update AFTER UPDATE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
		END;
		CREATE TEMP TRIGGER IF NOT EXISTS pi_tag_delete AFTER DELETE ON main.tags BEGIN
			UPDATE pi_tag_revision SET revision = revision + 1;
		END;
	`);
	const revision = db.prepare("SELECT revision FROM pi_tag_revision");
	const dataVersion = db.prepare("PRAGMA main.data_version");
	const cache = new Map<
		string,
		{
			revision: number;
			dataVersion: number;
			tags: ReturnType<typeof getTagsBySession>;
		}
	>();
	return (sessionId: string) => {
		const local = (revision.get() as { revision: number }).revision;
		// data_version observes other connections; the TEMP triggers observe this one,
		// including direct SQL and rolled-back transactions, without a durable schema change.
		const external = (dataVersion.get() as { data_version: number })
			.data_version;
		let snapshot = cache.get(sessionId);
		if (
			!snapshot ||
			snapshot.revision !== local ||
			snapshot.dataVersion !== external
		) {
			snapshot = {
				revision: local,
				dataVersion: external,
				tags: getTagsBySession(db, sessionId),
			};
			if (cache.size >= 100 && !cache.has(sessionId)) {
				const oldest = cache.keys().next().value;
				if (oldest !== undefined) cache.delete(oldest);
			}
			cache.set(sessionId, snapshot);
		}
		// Heuristics can edit their working entries; never expose the cached objects.
		return snapshot.tags.map((tag) => ({ ...tag }));
	};
}

const readers = new WeakMap<
	Database,
	ReturnType<typeof createPiTagSnapshotReader>
>();

export function getPiTagSnapshot(db: Database, sessionId: string) {
	let reader = readers.get(db);
	if (!reader) {
		reader = createPiTagSnapshotReader(db);
		readers.set(db, reader);
	}
	return reader(sessionId);
}
