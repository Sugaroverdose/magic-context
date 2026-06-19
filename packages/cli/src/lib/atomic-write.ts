import { chmodSync, renameSync, statSync, writeFileSync } from "node:fs";

/**
 * Write a file atomically: temp sibling + rename. Preserves prior mode when the
 * target already exists so user chmod settings survive doctor/setup rewrites.
 */
export function writeFileAtomic(targetPath: string, data: string): void {
    const tmpPath = `${targetPath}.tmp`;
    writeFileSync(tmpPath, data, { encoding: "utf-8" });
    try {
        if (statSync(targetPath, { throwIfNoEntry: false })?.isFile()) {
            const mode = statSync(targetPath).mode & 0o777;
            chmodSync(tmpPath, mode);
        }
    } catch {
        // New file — default umask applies.
    }
    renameSync(tmpPath, targetPath);
}
