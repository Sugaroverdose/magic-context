import type { Database } from "../../shared/sqlite";

export type MemoryMutationType = "archive" | "delete" | "update" | "superseded";

const MEMORY_MUTATION_TYPES = new Set<string>(["archive", "delete", "update", "superseded"]);

export interface MemoryMutationLogRow {
    id: number;
    projectPath: string;
    mutationType: MemoryMutationType;
    targetMemoryId: number;
    supersededById: number | null;
    category: string | null;
    newContent: string | null;
    queuedAt: number;
}

interface MemoryMutationLogDbRow {
    id: number;
    project_path: string;
    mutation_type: MemoryMutationType;
    target_memory_id: number;
    superseded_by_id: number | null;
    category: string | null;
    new_content: string | null;
    queued_at: number;
}

function assertMemoryMutationType(
    mutationType: string,
): asserts mutationType is MemoryMutationType {
    if (!MEMORY_MUTATION_TYPES.has(mutationType)) {
        throw new Error(`Invalid memory mutation type: ${mutationType}`);
    }
}

function toMemoryMutation(row: MemoryMutationLogDbRow): MemoryMutationLogRow {
    return {
        id: row.id,
        projectPath: row.project_path,
        mutationType: row.mutation_type,
        targetMemoryId: row.target_memory_id,
        supersededById: row.superseded_by_id,
        category: row.category,
        newContent: row.new_content,
        queuedAt: row.queued_at,
    };
}

export function queueMemoryMutation(
    db: Database,
    input: {
        projectPath: string;
        mutationType: MemoryMutationType;
        targetMemoryId: number;
        supersededById?: number | null;
        category?: string | null;
        newContent?: string | null;
        queuedAt?: number;
    },
): MemoryMutationLogRow {
    assertMemoryMutationType(input.mutationType);
    const result = db
        .prepare(
            `INSERT INTO memory_mutation_log
                (project_path, mutation_type, target_memory_id, superseded_by_id, category, new_content, queued_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
            input.projectPath,
            input.mutationType,
            input.targetMemoryId,
            input.supersededById ?? null,
            input.category ?? null,
            input.newContent ?? null,
            input.queuedAt ?? Date.now(),
        ) as {
        lastInsertRowid?: number | bigint;
    };
    const row = getMemoryMutation(db, Number(result.lastInsertRowid));
    if (!row) {
        throw new Error("Failed to load queued memory mutation");
    }
    return row;
}

export function getMemoryMutation(db: Database, id: number): MemoryMutationLogRow | null {
    const row = db
        .prepare(
            `SELECT id, project_path, mutation_type, target_memory_id,
                    superseded_by_id, category, new_content, queued_at
               FROM memory_mutation_log
              WHERE id = ?`,
        )
        .get(id) as MemoryMutationLogDbRow | undefined;
    return row ? toMemoryMutation(row) : null;
}

export function getMemoryMutationsForRender(
    db: Database,
    projectPath: string,
    afterId: number | null | undefined,
    renderedMemoryIds: readonly number[],
): MemoryMutationLogRow[] {
    if (renderedMemoryIds.length === 0) return [];

    const uniqueIds = [...new Set(renderedMemoryIds)].sort((left, right) => left - right);
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = db
        .prepare(
            `SELECT id, project_path, mutation_type, target_memory_id,
                    superseded_by_id, category, new_content, queued_at
               FROM memory_mutation_log
              WHERE project_path = ?
                AND id > ?
                AND target_memory_id IN (${placeholders})
              ORDER BY id ASC`,
        )
        .all(projectPath, afterId ?? 0, ...uniqueIds) as MemoryMutationLogDbRow[];

    const newestByTarget = new Map<number, MemoryMutationLogRow>();
    for (const row of rows) {
        newestByTarget.set(row.target_memory_id, toMemoryMutation(row));
    }
    return [...newestByTarget.values()].sort((left, right) => left.id - right.id);
}

export function getMaxMemoryMutationId(db: Database, projectPath: string): number | null {
    const row = db
        .prepare("SELECT MAX(id) AS max_id FROM memory_mutation_log WHERE project_path = ?")
        .get(projectPath) as { max_id: number | null } | undefined;
    return row?.max_id ?? null;
}
