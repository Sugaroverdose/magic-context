import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../../shared/test-temp-dir";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { readGitCommitsResult } from "./git-log-reader";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("readGitCommitsResult against a real repository", () => {
    let db: Database;
    let dir: string;

    const git = (args: string[], dateMs?: number) => {
        const env = { ...process.env };
        if (dateMs !== undefined) {
            const stamp = `@${Math.floor(dateMs / 1000)} +0000`;
            env.GIT_AUTHOR_DATE = stamp;
            env.GIT_COMMITTER_DATE = stamp;
        }
        return execFileSync("git", args, { cwd: dir, env, encoding: "utf8", windowsHide: true });
    };
    const commit = (file: string, message: string, dateMs: number) => {
        writeFileSync(join(dir, file), `${message}\n`);
        git(["add", file]);
        git(["-c", "commit.gpgsign=false", "commit", "-qm", message], dateMs);
    };
    const indexedMessages = () =>
        (
            db
                .prepare("SELECT message FROM git_commits WHERE project_path = ? ORDER BY message")
                .all("git:repo") as { message: string }[]
        ).map((row) => row.message);
    const sweep = () =>
        indexCommitsForProject(db, "git:repo", dir, {
            sinceDays: 30,
            maxCommits: 100,
            skipEmbed: true,
        });

    beforeEach(() => {
        db = new Database(":memory:");
        initializeDatabase(db);
        runMigrations(db);
        dir = createTestTempDirFromPath(join(tmpdir(), "mc-git-indexer-test-"));
        git(["init", "-q", "-b", "main"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
    });

    afterEach(() => {
        closeQuietly(db);
        rmSync(dir, { recursive: true, force: true });
    });

    it("reads history when a worktree file is named HEAD", async () => {
        commit("HEAD", "commit adding a file named HEAD", Date.now() - DAY_MS);

        const read = await readGitCommitsResult(dir, {});

        expect(read.failure).toBeNull();
        expect(read.commits.map((entry) => entry.message)).toEqual([
            "commit adding a file named HEAD",
        ]);
    });

    it("reads a SHA-256 repository", async () => {
        rmSync(join(dir, ".git"), { recursive: true, force: true });
        git(["init", "-q", "--object-format=sha256", "-b", "main"]);
        git(["config", "user.email", "test@example.com"]);
        git(["config", "user.name", "Test"]);
        commit("a.txt", "sha256 commit", Date.now() - DAY_MS);

        const read = await readGitCommitsResult(dir, {});

        expect(read.commits.map((entry) => [entry.message, entry.sha.length])).toEqual([
            ["sha256 commit", 64],
        ]);
    });
});
