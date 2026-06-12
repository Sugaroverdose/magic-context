import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import {
    buildCanonicalChunkTextFromFts,
    canonicalizeInMemoryChunkTextForEmbedding,
    chunkCanonicalText,
    chunkEmbeddingWindowsAreCurrent,
    replaceCompartmentChunkEmbeddings,
    type SaveCompartmentChunkEmbeddingInput,
} from "./compartment-chunk-embedding";
import {
    embedBatchForProject,
    embedTextForProject,
    getProjectEmbeddingMaxInputTokens,
    getProjectEmbeddingSnapshot,
} from "./project-embedding-registry";

/**
 * Compartment P1 embedding (v2 / E2).
 *
 * The LOCKED substrate decision: `p1_embedding` is computed + stored on EVERY
 * compartment publish, even though the historian no longer uses embedding to
 * pick its own reference block (that switched to recency). The embedding exists
 * for two consumers:
 *   - ctx_search semantic retrieval over compartments (E2 consumption),
 *   - future dreamer cross-compartment linking (e.g. "key-files 2 months ago
 *     ↔ key-files now").
 *
 * Fire-and-forget + best-effort, mirroring memory promotion: a missing/slow
 * embedding provider must never block or fail a historian publish. Gated by the
 * same `memory.enabled` / `auto_promote` flags as memory promotion (no embedding
 * endpoint hits when memory is off).
 */

interface CompartmentToEmbed {
    id: number;
    /** P1 tier text (fullest) — the embedding source. */
    p1: string;
}

/**
 * Embed the P1 text of the given compartments and persist each vector into
 * `compartments.p1_embedding` (+ `p1_embedding_model_id`). Best-effort per row:
 * one failure logs and continues. Never throws.
 *
 * `embedTextForProject` resolves the project's configured provider/model, so the
 * stored `model_id` stays consistent with memory embeddings for the same project
 * (vector compatibility for cross-corpus search later).
 */
export async function embedAndStoreCompartments(
    db: Database,
    sessionId: string,
    projectPath: string,
    compartments: readonly CompartmentToEmbed[],
): Promise<void> {
    if (compartments.length === 0) return;
    const update = db.prepare(
        "UPDATE compartments SET p1_embedding = ?, p1_embedding_model_id = ? WHERE id = ?",
    );
    for (const c of compartments) {
        if (!c.p1 || c.p1.length === 0) continue;
        try {
            const result = await embedTextForProject(projectPath, c.p1);
            if (result) {
                const blob = Buffer.from(
                    result.vector.buffer,
                    result.vector.byteOffset,
                    result.vector.byteLength,
                );
                update.run(blob, result.modelId, c.id);
            }
        } catch (error) {
            sessionLog(sessionId, `compartment embedding failed for compartment ${c.id}:`, error);
        }
    }
}

export interface CompartmentChunkToEmbed {
    id: number;
    startMessage: number;
    endMessage: number;
    /** Optional publish-time chunk text. When present, TC: tool summaries are stripped. */
    sourceChunkText?: string;
}

export async function embedAndStoreCompartmentChunks(
    db: Database,
    sessionId: string,
    projectPath: string,
    compartments: readonly CompartmentChunkToEmbed[],
): Promise<void> {
    if (compartments.length === 0) return;
    const maxInputTokens = getProjectEmbeddingMaxInputTokens(projectPath);

    for (const compartment of compartments) {
        try {
            const fromMemory = compartment.sourceChunkText
                ? canonicalizeInMemoryChunkTextForEmbedding(
                      compartment.sourceChunkText,
                      compartment.startMessage,
                      compartment.endMessage,
                  )
                : "";
            const canonicalText =
                fromMemory ||
                buildCanonicalChunkTextFromFts(
                    db,
                    sessionId,
                    compartment.startMessage,
                    compartment.endMessage,
                );
            if (canonicalText.length === 0) continue;

            const windows = chunkCanonicalText(
                canonicalText,
                compartment.startMessage,
                compartment.endMessage,
                maxInputTokens,
            );
            if (windows.length === 0) continue;

            const currentModelId = getProjectEmbeddingSnapshot(projectPath)?.modelId;
            if (
                currentModelId &&
                currentModelId !== "off" &&
                chunkEmbeddingWindowsAreCurrent(db, compartment.id, currentModelId, windows)
            ) {
                continue;
            }

            const result = await embedBatchForProject(
                projectPath,
                windows.map((window) => window.text),
            );
            if (!result) continue;
            if (chunkEmbeddingWindowsAreCurrent(db, compartment.id, result.modelId, windows)) {
                continue;
            }

            const rows: SaveCompartmentChunkEmbeddingInput[] = [];
            for (const [index, window] of windows.entries()) {
                const vector = result.vectors[index];
                if (!vector) continue;
                rows.push({
                    compartmentId: compartment.id,
                    sessionId,
                    projectPath,
                    window,
                    modelId: result.modelId,
                    vector,
                });
            }
            if (rows.length === windows.length) {
                replaceCompartmentChunkEmbeddings(db, rows);
            }
        } catch (error) {
            sessionLog(
                sessionId,
                `compartment chunk embedding failed for compartment ${compartment.id}:`,
                error,
            );
        }
    }
}
