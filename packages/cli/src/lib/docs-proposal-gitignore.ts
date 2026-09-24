import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Keep per-project proposal state out of version control without changing unrelated ignore rules. */
export function ensureDocsProposalGitignore(projectDir: string): void {
    const path = join(projectDir, ".gitignore");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    const covered = text.split(/\r?\n/).some((line) => {
        const rule = line.trim().replace(/^\//, "");
        return (
            !rule.startsWith("#") &&
            [
                ".cortexkit/",
                ".cortexkit/*",
                ".cortexkit/magic-context/",
                ".cortexkit/magic-context/*",
            ].includes(rule)
        );
    });
    if (!covered)
        appendFileSync(
            path,
            `${text && !text.endsWith("\n") ? "\n" : ""}.cortexkit/magic-context/\n`,
        );
}
