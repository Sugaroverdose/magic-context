import path from "node:path";

import type { Database } from "../../../shared/sqlite";
import {
    getMemoriesByProject,
    getMemoryById,
    getMemoryVerifications,
    type Memory,
    readGitChangedFilesSince,
    readGitHead,
    resolveGitTopLevel,
    verificationFileExists,
} from "../memory";
import type { TaskScheduleStateRow } from "./storage-task-schedule";

// Verify task gate substrate (formerly maintain-memory); kept here to avoid a noisy mechanical rename.
const DEFAULT_BROAD_INTERVAL_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MaintainMemoryPromptMemory {
    id: number;
    category: string;
    content: string;
    mappedFiles: string[];
    verifiedAt: number | null;
    hasNoFileSentinel: boolean;
}

export interface MaintainMemoryGateResult {
    runStartedAt: number;
    startHead: string | null;
    mode: "non-git" | "full" | "broad" | "incremental";
    broadMode: boolean;
    inScope: MaintainMemoryPromptMemory[];
    inScopeIds: number[];
    skippedIds: number[];
    reason: string;
}

function toPromptMemory(
    memory: Memory,
    mappedFiles: string[],
    verifiedAt: number | null,
    hasNoFileSentinel: boolean,
): MaintainMemoryPromptMemory {
    return {
        id: memory.id,
        category: memory.category,
        content: memory.content,
        mappedFiles,
        verifiedAt,
        hasNoFileSentinel,
    };
}

function isBroadDue(
    state: TaskScheduleStateRow | null,
    now: number,
    broadIntervalDays: number | undefined,
): boolean {
    const intervalDays = Math.max(1, broadIntervalDays ?? DEFAULT_BROAD_INTERVAL_DAYS);
    return state?.lastBroadRunAt == null || now - state.lastBroadRunAt >= intervalDays * DAY_MS;
}

export async function partitionMaintainMemoryScope(args: {
    db: Database;
    projectIdentity: string;
    projectDirectory: string;
    scheduleState: TaskScheduleStateRow | null;
    broadIntervalDays?: number;
    now?: number;
}): Promise<MaintainMemoryGateResult> {
    const runStartedAt = args.now ?? Date.now();
    const activeMemories = getMemoriesByProject(args.db, args.projectIdentity);
    const verificationById = getMemoryVerifications(
        args.db,
        activeMemories.map((memory) => memory.id),
    );
    const startHead = await readGitHead(args.projectDirectory);
    const broadMode = isBroadDue(args.scheduleState, runStartedAt, args.broadIntervalDays);

    const allInScope = (mode: MaintainMemoryGateResult["mode"], reason: string) => ({
        runStartedAt,
        startHead,
        mode,
        broadMode: mode === "broad" || broadMode,
        inScope: activeMemories.map((memory) => {
            const verification = verificationById.get(memory.id);
            return toPromptMemory(
                memory,
                verification?.files ?? [],
                verification?.verifiedAt ?? null,
                verification?.hasSentinel ?? false,
            );
        }),
        inScopeIds: activeMemories.map((memory) => memory.id),
        skippedIds: [],
        reason,
    });

    if (!startHead) {
        return allInScope("non-git", "non-git project; full verification");
    }

    const storedWatermark = args.scheduleState?.lastCheckedCommit ?? null;
    if (!storedWatermark) {
        return allInScope(
            broadMode ? "broad" : "full",
            "no stored verify commit watermark; full verification",
        );
    }

    const changedFiles = await readGitChangedFilesSince(args.projectDirectory, storedWatermark);
    if (!changedFiles) {
        return allInScope(
            broadMode ? "broad" : "full",
            "stored verify commit watermark is unavailable; full verification",
        );
    }

    if (broadMode) {
        return allInScope("broad", "broad verify interval elapsed");
    }

    const gitRoot =
        (await resolveGitTopLevel(args.projectDirectory)) ?? path.resolve(args.projectDirectory);
    const inScope: MaintainMemoryPromptMemory[] = [];
    const skippedIds: number[] = [];
    for (const memory of activeMemories) {
        const verification = verificationById.get(memory.id);
        if (!verification) {
            inScope.push(toPromptMemory(memory, [], null, false));
            continue;
        }
        const mappedFiles = verification.files;
        if (mappedFiles.length === 0) {
            skippedIds.push(memory.id);
            continue;
        }
        const needsVerify = mappedFiles.some(
            (file) => changedFiles.has(file) || !verificationFileExists(gitRoot, file),
        );
        if (needsVerify) {
            inScope.push(
                toPromptMemory(
                    memory,
                    mappedFiles,
                    verification.verifiedAt,
                    verification.hasSentinel,
                ),
            );
        } else {
            skippedIds.push(memory.id);
        }
    }

    return {
        runStartedAt,
        startHead,
        mode: "incremental",
        broadMode: false,
        inScope,
        inScopeIds: inScope.map((memory) => memory.id),
        skippedIds,
        reason: `incremental verification against ${changedFiles.size} changed file(s)`,
    };
}

function memoryStillActive(memory: Memory | null): boolean {
    return (
        memory !== null &&
        (memory.status === "active" || memory.status === "permanent") &&
        memory.supersededByMemoryId === null
    );
}

export function checkMaintainMemoryCoverage(args: {
    db: Database;
    inScopeIds: readonly number[];
    runStartedAt: number;
}): { covered: boolean; uncoveredIds: number[] } {
    const ids = Array.from(new Set(args.inScopeIds.filter(Number.isInteger)));
    const verificationById = getMemoryVerifications(args.db, ids);
    const uncoveredIds: number[] = [];

    for (const id of ids) {
        const memory = getMemoryById(args.db, id);
        if (!memoryStillActive(memory)) continue;
        const verification = verificationById.get(id);
        if (verification && verification.verifiedAt >= args.runStartedAt) continue;
        uncoveredIds.push(id);
    }

    return { covered: uncoveredIds.length === 0, uncoveredIds };
}
