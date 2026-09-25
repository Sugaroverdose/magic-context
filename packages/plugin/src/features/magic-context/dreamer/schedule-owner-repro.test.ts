/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { type DreamTaskRuntimeConfig, planDueTasks } from "./task-scheduler";

function config(schedule: string): DreamTaskRuntimeConfig {
    return { task: "verify", schedule, timeoutMinutes: 20 };
}

test("conflicting worktree schedules cannot continually postpone a shared slot", () => {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);

    const projectIdentity = "git:shared-by-two-live-worktrees";
    const worktreeA = config("0 * * * *");
    const worktreeB = config("30 * * * *");
    const start = Date.UTC(2026, 0, 1, 0, 0, 0);
    const due: Array<{ minute: number; worktree: "A" | "B" }> = [];

    try {
        // Distinct project identities retain the existing single-owner behavior.
        expect(planDueTasks(db, "git:control-a", [worktreeA], start)).toHaveLength(0);
        expect(planDueTasks(db, "git:control-a", [worktreeA], start + 60 * 60_000)).toHaveLength(1);
        expect(planDueTasks(db, "git:control-b", [worktreeB], start)).toHaveLength(0);
        expect(planDueTasks(db, "git:control-b", [worktreeB], start + 30 * 60_000)).toHaveLength(1);

        // dream-timer reconciles every live worktree against this shared row.
        for (let minute = 0; minute <= 180; minute += 15) {
            const now = start + minute * 60_000;
            if (planDueTasks(db, projectIdentity, [worktreeA], now).length > 0) {
                due.push({ minute, worktree: "A" });
            }
            if (planDueTasks(db, projectIdentity, [worktreeB], now).length > 0) {
                due.push({ minute, worktree: "B" });
            }
        }

        expect(due.length).toBeGreaterThan(0);
    } finally {
        db.close();
    }
});
