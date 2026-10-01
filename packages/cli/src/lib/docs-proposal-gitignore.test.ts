import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestTempDirFromPath } from "../../../plugin/src/shared/test-temp-dir";
import { ensureDocsProposalGitignore } from "./docs-proposal-gitignore";

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
test("adds the ignore rule once while retaining existing rules", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-ignore-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n");
    ensureDocsProposalGitignore(dir);
    ensureDocsProposalGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(
        "node_modules/\n.cortexkit/magic-context/\n",
    );
});
test("a broad .cortexkit ignore covers proposal state", () => {
    const dir = createTestTempDirFromPath(join(tmpdir(), "mc-ignore-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".gitignore"), ".cortexkit/*\n");
    ensureDocsProposalGitignore(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe(".cortexkit/*\n");
});
