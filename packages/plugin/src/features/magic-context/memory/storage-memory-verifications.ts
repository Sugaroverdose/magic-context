import type { Database } from "../../../shared/sqlite";

export const MEMORY_VERIFICATION_SENTINEL = "";

export interface MemoryVerificationState {
    /** Real repo-root-relative backing files. Excludes the no-file sentinel. */
    files: string[];
    /** True when a `""` no-file sentinel row exists for this memory. */
    hasSentinel: boolean;
    /** Max verified_at across all rows for the memory. */
    verifiedAt: number;
}

interface MemoryVerificationRow {
    memory_id: number;
    file_path: string;
    verified_at: number;
}

function placeholders(values: readonly unknown[]): string {
    return values.map(() => "?").join(", ");
}

function uniqueSortedFiles(files: readonly string[]): string[] {
    return Array.from(
        new Set(files.filter((file) => file !== MEMORY_VERIFICATION_SENTINEL)),
    ).sort();
}

/**
 * Replace one memory's side-table verification rows without touching `memories`.
 * Callers that update multiple memories should wrap their batch in one transaction.
 */
export function recordMemoryVerifications(
    db: Database,
    memoryId: number,
    normalizedFiles: readonly string[],
    now: number,
): number {
    const realFiles = uniqueSortedFiles(normalizedFiles);
    const filesToWrite = realFiles.length > 0 ? realFiles : [MEMORY_VERIFICATION_SENTINEL];
    db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
    const insert = db.prepare(
        "INSERT INTO memory_verifications (memory_id, file_path, verified_at) VALUES (?, ?, ?)",
    );
    for (const file of filesToWrite) {
        insert.run(memoryId, file, now);
    }
    return filesToWrite.length;
}

export function clearMemoryVerifications(db: Database, memoryId: number): void {
    db.prepare("DELETE FROM memory_verifications WHERE memory_id = ?").run(memoryId);
}

export function getMemoryVerifications(
    db: Database,
    memoryIds: readonly number[],
): Map<number, MemoryVerificationState> {
    const ids = Array.from(new Set(memoryIds.filter(Number.isInteger)));
    const result = new Map<number, MemoryVerificationState>();
    if (ids.length === 0) return result;

    const rows = db
        .prepare<unknown[], MemoryVerificationRow>(
            `SELECT memory_id, file_path, verified_at
               FROM memory_verifications
              WHERE memory_id IN (${placeholders(ids)})
              ORDER BY memory_id, file_path`,
        )
        .all(...ids);

    for (const row of rows) {
        const existing = result.get(row.memory_id) ?? {
            files: [],
            hasSentinel: false,
            verifiedAt: 0,
        };
        if (row.file_path === MEMORY_VERIFICATION_SENTINEL) {
            existing.hasSentinel = true;
        } else if (!existing.files.includes(row.file_path)) {
            existing.files.push(row.file_path);
        }
        existing.verifiedAt = Math.max(existing.verifiedAt, row.verified_at);
        result.set(row.memory_id, existing);
    }

    for (const state of result.values()) {
        state.files.sort();
    }
    return result;
}
