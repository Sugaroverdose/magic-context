import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import type { GitCommit } from "./git-log-reader";
import { enforceProjectCap, getCommitCount, upsertCommits } from "./storage-git-commits";
import {
    acquireGitSweepLease,
    GIT_SWEEP_COOLDOWN_MS,
    getGitSweepCoordinatorState,
    markGitSweepSuccessAndRelease,
    releaseGitSweepLease,
} from "./sweep-coordinator";

function openTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

function makeCommit(shaSeed: string, committedAtMs: number): GitCommit {
    const sha = shaSeed.padEnd(40, shaSeed);
    return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `commit ${shaSeed}`,
        author: "dev@example.com",
        committedAtMs,
    };
}

describe("git sweep coordinator", () => {
    let db: Database;

    beforeEach(() => {
        db = openTestDb();
    });

    it("allows only one same-identity sweep to run and caps exactly once", () => {
        const projectPath = "git:root-commit";
        upsertCommits(db, projectPath, [
            makeCommit("a", 1000),
            makeCommit("b", 2000),
            makeCommit("c", 3000),
            makeCommit("d", 4000),
            makeCommit("e", 5000),
        ]);

        const firstLease = acquireGitSweepLease(db, projectPath, "holder-a");
        expect(firstLease.acquired).toBe(true);

        const secondLease = acquireGitSweepLease(db, projectPath, "holder-b");
        expect(secondLease).toEqual(
            expect.objectContaining({ acquired: false, reason: "lease_active" }),
        );

        let sweepsRun = 0;
        if (firstLease.acquired) {
            sweepsRun += 1;
            expect(enforceProjectCap(db, projectPath, 3)).toBe(2);
            expect(markGitSweepSuccessAndRelease(db, projectPath, firstLease.holderId)).toBe(true);
        }

        expect(sweepsRun).toBe(1);
        expect(getCommitCount(db, projectPath)).toBe(3);
    });

    it("skips acquisition inside the successful-sweep cooldown window", () => {
        const projectPath = "git:cooldown";
        const lease = acquireGitSweepLease(db, projectPath, "holder-a");
        expect(lease.acquired).toBe(true);
        if (!lease.acquired) throw new Error("expected first lease");
        expect(markGitSweepSuccessAndRelease(db, projectPath, lease.holderId)).toBe(true);

        const retry = acquireGitSweepLease(db, projectPath, "holder-b");
        expect(retry).toEqual(
            expect.objectContaining({ acquired: false, reason: "cooldown_active" }),
        );
    });

    it("allows acquisition after the successful-sweep cooldown window", () => {
        const projectPath = "git:cooldown-expired";
        const lease = acquireGitSweepLease(db, projectPath, "holder-a");
        expect(lease.acquired).toBe(true);
        if (!lease.acquired) throw new Error("expected first lease");
        expect(markGitSweepSuccessAndRelease(db, projectPath, lease.holderId)).toBe(true);

        db.prepare("UPDATE git_sweep_coordinator SET last_swept_at = ? WHERE project_path = ?").run(
            Date.now() - GIT_SWEEP_COOLDOWN_MS - 1,
            projectPath,
        );

        const retry = acquireGitSweepLease(db, projectPath, "holder-b");
        expect(retry.acquired).toBe(true);
    });

    it("does not advance last_swept_at when a sweep fails", () => {
        const projectPath = "git:failed-sweep";
        const lease = acquireGitSweepLease(db, projectPath, "holder-a");
        expect(lease.acquired).toBe(true);
        if (!lease.acquired) throw new Error("expected first lease");

        try {
            throw new Error("git log failed");
        } catch {
            releaseGitSweepLease(db, projectPath, lease.holderId);
        }

        expect(getGitSweepCoordinatorState(db, projectPath)?.lastSweptAt).toBeNull();
        const retry = acquireGitSweepLease(db, projectPath, "holder-b");
        expect(retry.acquired).toBe(true);
    });

    it("lets a new holder acquire after a crashed holder lease expires", () => {
        const projectPath = "git:crashed-holder";
        const lease = acquireGitSweepLease(db, projectPath, "holder-a");
        expect(lease.acquired).toBe(true);

        db.prepare(
            "UPDATE git_sweep_coordinator SET lease_expires_at = ? WHERE project_path = ?",
        ).run(Date.now() - 1, projectPath);

        const retry = acquireGitSweepLease(db, projectPath, "holder-b");
        expect(retry.acquired).toBe(true);
        expect(getGitSweepCoordinatorState(db, projectPath)?.leaseHolder).toBe("holder-b");
    });
});
