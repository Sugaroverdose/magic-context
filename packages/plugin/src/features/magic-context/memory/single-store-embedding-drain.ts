import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { embedUnembeddedMemoriesForProject } from "../project-embedding-registry";

/**
 * Embed the memories another writer put into `memories` without an embedding.
 *
 * Vectors are computed here in the host, by a provider, with a hash-guarded save — they
 * are not maintained by a database trigger the way the full-text index is. So a memory
 * row written by the Rust module arrives unembedded and nothing would ever ask for one:
 * the paths that normally trigger embedding all run on the host's own write.
 *
 * The module therefore records a per-project high-water mark on `memories.id` as it
 * writes, and this drain is what reads it. A mark rather than a per-row column is the
 * point: it leaves the `memories` table byte-identical between the two writers, so a row
 * cannot be told apart by who wrote it.
 *
 * Everything here is a no-op on a project the module has not written: the watermark table
 * is empty, so there is nothing to drain.
 */

interface WatermarkRow {
    project_path: string;
    written_memory_id: number;
    embedded_memory_id: number;
}

function isWatermarkRow(row: unknown): row is WatermarkRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.project_path === "string" &&
        typeof candidate.written_memory_id === "number" &&
        typeof candidate.embedded_memory_id === "number"
    );
}

/** Projects with memories written past what this host has embedded. */
export function getPendingEmbeddingWatermarks(db: Database): WatermarkRow[] {
    try {
        return db
            .prepare(
                `SELECT project_path, written_memory_id, embedded_memory_id
                   FROM memory_embedding_watermarks
                  WHERE written_memory_id > embedded_memory_id
                  ORDER BY project_path ASC`,
            )
            .all()
            .filter(isWatermarkRow);
    } catch (error) {
        // A database older than the migration that adds the table has no module writer
        // either, so "no such table" means "nothing to drain", not a failure.
        if (error instanceof Error && error.message.includes("no such table")) return [];
        throw error;
    }
}

/**
 * Embed everything above each project's embedded mark and advance that mark.
 *
 * Returns how many rows were embedded. The mark only advances as far as the batch
 * actually reached when the embedder ran short, so an interrupted drain resumes rather
 * than skipping the rows it did not get to.
 */
export async function drainSingleStoreEmbeddingWatermarks(db: Database): Promise<number> {
    const pending = getPendingEmbeddingWatermarks(db);
    if (pending.length === 0) return 0;

    let embedded = 0;
    for (const watermark of pending) {
        try {
            const count = await embedUnembeddedMemoriesForProject(db, watermark.project_path);
            embedded += count;
            if (count === 0) {
                // Nothing left unembedded below the written mark: either the rows were
                // already embedded, or embedding is disabled for this project. Advancing
                // in both cases is what stops this from re-scanning the same range on
                // every pass forever.
                advanceEmbeddedWatermark(db, watermark.project_path, watermark.written_memory_id);
                continue;
            }
            const stillPending = countUnembeddedBelow(db, watermark.project_path);
            if (stillPending === 0) {
                advanceEmbeddedWatermark(db, watermark.project_path, watermark.written_memory_id);
            }
        } catch (error) {
            log(
                `[magic-context] embedding drain for module-written memories in ${watermark.project_path} failed:`,
                error,
            );
        }
    }
    if (embedded > 0) {
        log(
            `[magic-context] embedded ${embedded} module-written ${embedded === 1 ? "memory" : "memories"}`,
        );
    }
    return embedded;
}

function countUnembeddedBelow(db: Database, projectPath: string): number {
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count FROM memories
              WHERE project_path = ?
                AND status IN ('active', 'permanent')
                AND NOT EXISTS (SELECT 1 FROM memory_embeddings WHERE memory_id = memories.id)`,
        )
        .get(projectPath) as { count?: number } | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

function advanceEmbeddedWatermark(db: Database, projectPath: string, upTo: number): void {
    db.prepare(
        `UPDATE memory_embedding_watermarks
            SET embedded_memory_id = MAX(embedded_memory_id, ?),
                updated_at = ?
          WHERE project_path = ?`,
    ).run(upTo, Date.now(), projectPath);
}
