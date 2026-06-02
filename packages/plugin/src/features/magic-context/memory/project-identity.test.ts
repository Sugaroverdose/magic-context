import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectIdentity } from "./project-identity";

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "mc-identity-"));
}

function git(dir: string, args: string[]): void {
    execFileSync("git", args, {
        cwd: dir,
        stdio: "ignore",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@t",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@t",
        },
    });
}

describe("resolveProjectIdentity directory fallback", () => {
    test("flips dir: fallback to git: once a repo gains its first commit (no stale cache)", () => {
        const dir = tempDir();
        try {
            // No .git yet → deterministic dir: fallback, cached.
            const first = resolveProjectIdentity(dir);
            expect(first).toMatch(/^dir:[0-9a-f]{12}$/);
            // Same answer while still non-git (served from cache).
            expect(resolveProjectIdentity(dir)).toBe(first);

            // Repo appears with a real commit.
            git(dir, ["init"]);
            writeFileSync(join(dir, "f.txt"), "x");
            git(dir, ["add", "."]);
            git(dir, ["commit", "-m", "init"]);

            // Regression: must re-resolve to the stable git:<root> identity, not
            // keep serving the cached dir: fallback for the process lifetime.
            const second = resolveProjectIdentity(dir);
            expect(second).toMatch(/^git:[0-9a-f]{7,}$/);
            expect(second).not.toBe(first);
            // Stable on subsequent calls.
            expect(resolveProjectIdentity(dir)).toBe(second);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
