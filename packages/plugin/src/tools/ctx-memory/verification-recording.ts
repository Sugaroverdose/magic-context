import path from "node:path";

import { getTaskScheduleState } from "../../features/magic-context/dreamer/storage-task-schedule";
import {
    getMemoryVerifications,
    normalizeVerificationFiles,
    readGitChangedFilesSince,
    recordMemoryVerifications,
    verificationFileExists,
} from "../../features/magic-context/memory";
import type { Database } from "../../shared/sqlite";

export interface PlannedMemoryVerificationRecord {
    memoryId: number;
    /** Empty means write the no-file sentinel. */
    files: string[];
}

export interface PreparedMemoryVerificationRecording {
    records: PlannedMemoryVerificationRecord[];
    warnings: string[];
    /** True when caller supplied paths but none survived normalization/guard. */
    hasValidFilesOrSentinel: boolean;
}

async function readGuardChangedFiles(args: {
    db: Database;
    projectIdentity: string;
    cwd: string;
}): Promise<Set<string> | null> {
    const watermark = getTaskScheduleState(
        args.db,
        args.projectIdentity,
        "verify",
    )?.lastCheckedCommit;
    if (!watermark) return null;
    return readGitChangedFilesSince(args.cwd, watermark);
}

/**
 * Plan side-table-only verification writes for a complete backing-file set.
 * The live-file guard preserves existing unchanged mappings when an agent would
 * otherwise drop them from an incremental run.
 */
export async function prepareMemoryVerificationRecording(args: {
    db: Database;
    cwd: string;
    projectIdentity: string;
    memoryIds: readonly number[];
    rawFiles: readonly string[];
}): Promise<PreparedMemoryVerificationRecording> {
    const ids = Array.from(new Set(args.memoryIds.filter(Number.isInteger)));
    const normalized = await normalizeVerificationFiles({ cwd: args.cwd, files: args.rawFiles });
    const warnings = [...normalized.warnings];
    const allowSentinel = args.rawFiles.length === 0;
    const changedFiles = await readGuardChangedFiles(args);
    const existingById = getMemoryVerifications(args.db, ids);
    const baseRoot = normalized.gitRoot ?? path.resolve(args.cwd);
    const records: PlannedMemoryVerificationRecord[] = [];

    for (const memoryId of ids) {
        const nextFiles = new Set(normalized.files);
        const existing = existingById.get(memoryId);
        if (existing && changedFiles) {
            for (const file of existing.files) {
                if (nextFiles.has(file)) continue;
                if (!verificationFileExists(baseRoot, file)) continue;
                if (changedFiles.has(file)) continue;
                nextFiles.add(file);
                warnings.push(
                    `Kept existing verification mapping "${file}" for memory ${memoryId}; it still exists and was not changed in this run.`,
                );
            }
        }

        const files = Array.from(nextFiles).sort();
        if (files.length > 0) {
            records.push({ memoryId, files });
        } else if (allowSentinel) {
            records.push({ memoryId, files: [] });
        }
    }

    return {
        records,
        warnings,
        hasValidFilesOrSentinel: records.length > 0,
    };
}

export function writePlannedMemoryVerificationRecords(
    db: Database,
    records: readonly PlannedMemoryVerificationRecord[],
    now: number,
): number {
    let recorded = 0;
    for (const record of records) {
        recorded += recordMemoryVerifications(db, record.memoryId, record.files, now);
    }
    return recorded;
}

export function runImmediateTransaction<T>(db: Database, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = fn();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}
