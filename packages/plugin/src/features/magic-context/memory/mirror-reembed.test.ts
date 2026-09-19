import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMirrorPage, type ChangefeedPage, ensureContextStoreUuid } from "../context-authority";
import {
    _resetProjectEmbeddingRegistryForTests,
    _setTestProviderFactoryForProject,
    embedUnembeddedMemoriesForProject,
    registerProjectEmbedding,
} from "../project-embedding-registry";
import { closeDatabase, openDatabase } from "../storage";
import type { EmbeddingProvider, EmbeddingPurpose } from "./embedding-provider";
import { reembedMirrorInvalidatedMemories } from "./mirror-reembed";
import { insertMemory } from "./storage-memory";

type OpenDb = NonNullable<ReturnType<typeof openDatabase>>;

const PROJECT = "git:mirror-reembed";

/** Records every text it is asked to embed, so a test can prove WHICH content was embedded. */
function installRecordingProvider(embedded: string[]): void {
    _setTestProviderFactoryForProject(
        () =>
            ({
                modelId: "mirror-reembed-model",
                initialize: async () => true,
                embed: async (text: string, _signal?: AbortSignal, _purpose?: EmbeddingPurpose) => {
                    embedded.push(text);
                    return new Float32Array([text.length, 1]);
                },
                embedBatch: async (
                    texts: string[],
                    _signal?: AbortSignal,
                    _purpose?: EmbeddingPurpose,
                ) => {
                    for (const text of texts) embedded.push(text);
                    return texts.map((text) => new Float32Array([text.length, 1]));
                },
                dispose: async () => {},
                isLoaded: () => true,
            }) satisfies EmbeddingProvider,
    );
}

function embeddingCount(db: OpenDb, memoryId: number): number {
    return (
        db
            .prepare("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?")
            .get(memoryId) as { count: number }
    ).count;
}

describe("re-embedding after a module-side memory edit", () => {
    const tempDirs: string[] = [];
    const originalXdgDataHome = process.env.XDG_DATA_HOME;

    function useTempDb(): OpenDb {
        const dir = mkdtempSync(join(tmpdir(), "mirror-reembed-"));
        tempDirs.push(dir);
        process.env.XDG_DATA_HOME = dir;
        return openDatabase() as OpenDb;
    }

    afterEach(() => {
        _resetProjectEmbeddingRegistryForTests();
        closeDatabase();
        if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = originalXdgDataHome;
        for (const dir of tempDirs) {
            try {
                rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
            } catch {
                /* Ignore EBUSY on Windows */
            }
        }
        tempDirs.length = 0;
    });

    /**
     * Build one module-side memory snapshot. The mirror treats a changed
     * `normalized_hash` as changed content, which is what retires the embedding.
     */
    function snapshot(args: {
        storeUuid: string;
        moduleRowId: number;
        contextRowId: number;
        content: string;
        hash: string;
        status?: string;
        supersededBy?: number | null;
    }): Record<string, unknown> {
        // The mirror keeps host values when the host row is the newer one, so a
        // module edit has to carry a later `updated_at` to land at all.
        const editedAt = Date.now() + 60_000;
        return {
            id: args.moduleRowId,
            project_path: PROJECT,
            category: "CONSTRAINTS",
            content: args.content,
            normalized_hash: args.hash,
            importance: 50,
            scope: "project",
            shareable: 0,
            source_session_id: null,
            source_type: "agent",
            seen_count: 1,
            retrieval_count: 0,
            first_seen_at: 0,
            created_at: 0,
            updated_at: editedAt,
            last_seen_at: editedAt,
            last_retrieved_at: null,
            status: args.status ?? "active",
            expires_at: null,
            verification_status: "unverified",
            verified_at: null,
            classified_at: null,
            superseded_by_memory_id: args.supersededBy ?? null,
            merged_from: null,
            metadata_json: null,
            context_store_uuid: args.storeUuid,
            context_row_id: args.contextRowId,
        };
    }

    function page(
        cursor: number,
        nextCursor: number,
        rows: ChangefeedPage["rows"],
    ): ChangefeedPage {
        return { domain: "memories", cursor, next_cursor: nextCursor, has_more: false, rows };
    }

    async function seedEmbeddedMemory(
        db: OpenDb,
        content: string,
        embedded: string[],
    ): Promise<number> {
        const memory = insertMemory(db, {
            projectPath: PROJECT,
            category: "CONSTRAINTS",
            content,
        });
        registerProjectEmbedding(
            db,
            PROJECT,
            { provider: "local", model: "mirror-reembed" },
            { memoryEnabled: true, gitCommitEnabled: false },
            "/tmp/mirror-reembed",
        );
        // A freshly written memory starts out embedded; the edits below are what
        // put that embedding at risk.
        expect(await embedUnembeddedMemoriesForProject(db, PROJECT)).toBe(1);
        expect(embeddingCount(db, memory.id)).toBe(1);
        embedded.length = 0;
        return memory.id;
    }

    it("restores the embedding an update's mirror-back removed, using the new content", async () => {
        const db = useTempDb();
        const embedded: string[] = [];
        installRecordingProvider(embedded);
        const storeUuid = ensureContextStoreUuid(db);
        const memoryId = await seedEmbeddedMemory(db, "Original constraint text.", embedded);

        // update → the module publishes new content, the mirror retires the vector.
        applyMirrorPage({
            db,
            page: page(0, 1, [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "update",
                    module_row_id: 501,
                    full_row_snapshot: snapshot({
                        storeUuid,
                        moduleRowId: 501,
                        contextRowId: memoryId,
                        content: "Corrected constraint text.",
                        hash: "hash-corrected",
                    }),
                    content_hash: "hash-corrected",
                },
            ]),
        });
        expect(embeddingCount(db, memoryId)).toBe(0);

        expect(await reembedMirrorInvalidatedMemories(db)).toBe(1);

        expect(embeddingCount(db, memoryId)).toBe(1);
        expect(embedded).toEqual(["Corrected constraint text."]);
    });

    it("restores the embedding a merge's canonical row lost to its new content", async () => {
        const db = useTempDb();
        const embedded: string[] = [];
        installRecordingProvider(embedded);
        const storeUuid = ensureContextStoreUuid(db);
        const canonicalId = await seedEmbeddedMemory(db, "Duplicate one.", embedded);

        applyMirrorPage({
            db,
            page: page(0, 1, [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "update",
                    module_row_id: 601,
                    full_row_snapshot: snapshot({
                        storeUuid,
                        moduleRowId: 601,
                        contextRowId: canonicalId,
                        content: "Consolidated duplicate one and two.",
                        hash: "hash-merged",
                    }),
                    content_hash: "hash-merged",
                },
            ]),
        });
        expect(embeddingCount(db, canonicalId)).toBe(0);

        expect(await reembedMirrorInvalidatedMemories(db)).toBe(1);

        expect(embeddingCount(db, canonicalId)).toBe(1);
        expect(embedded).toEqual(["Consolidated duplicate one and two."]);
    });

    it("leaves an archived supersede alone: unchanged content keeps its vector", async () => {
        const db = useTempDb();
        const embedded: string[] = [];
        installRecordingProvider(embedded);
        const storeUuid = ensureContextStoreUuid(db);
        const memoryId = await seedEmbeddedMemory(db, "Superseded fact.", embedded);

        // archive + supersede rewrites status and the supersede pointer, not content.
        applyMirrorPage({
            db,
            page: page(0, 1, [
                {
                    feed_seq: 1,
                    domain: "memories",
                    op: "update",
                    module_row_id: 701,
                    full_row_snapshot: snapshot({
                        storeUuid,
                        moduleRowId: 701,
                        contextRowId: memoryId,
                        content: "Superseded fact.",
                        hash: (
                            db
                                .prepare(
                                    "SELECT normalized_hash AS hash FROM memories WHERE id = ?",
                                )
                                .get(memoryId) as { hash: string }
                        ).hash,
                        status: "archived",
                    }),
                    content_hash: "unchanged",
                },
            ]),
        });

        expect(embeddingCount(db, memoryId)).toBe(1);
        expect(await reembedMirrorInvalidatedMemories(db)).toBe(0);
        expect(embedded).toEqual([]);
    });
});
