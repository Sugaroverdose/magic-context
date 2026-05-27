/**
 * Resolve a stable project identity from the working directory.
 *
 * Strategy:
 *   1. Git repo with commits → root commit hash (same across worktrees, clones, forks)
 *   2. Git repo with no commits → fallback to directory hash via resolveProjectIdentity()
 *   3. No git repo → fallback to directory hash via resolveProjectIdentity()
 *
 * The root commit hash is immutable and survives remote renames, host
 * migrations, and SSH/HTTPS URL changes. It is the same across all
 * worktrees and clones of the same repository.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";

// execFileSync is intentional here (audit #19): this runs once per unique directory per process
// lifetime and successful git identities are cached in identityCache. The ~10-50ms block on first
// call is acceptable vs threading async through all callers of resolveProjectIdentity.
const GIT_TIMEOUT_MS = 5_000;
const identityCache = new Map<string, string>();
const directoryFallbackCache = new Map<string, string>();

/**
 * Type-checked project identity failure classes (Finding #16).
 *
 * Caller policy:
 * - `not_git_repo` is deterministic: the directory is accessible but has no git root commit, so
 *   callers that preserve the production contract may fall back to `dir:<md5-12>`.
 * - `git_missing` and `git_timeout` are transient: callers should retry later or record to
 *   `v22_backfill_failures`.
 * - `permission_denied` and `unknown` are not safe to silently coerce during strict resolution:
 *   callers should record the failure for explicit recovery.
 */
export type ProjectIdentityErrorClass =
    | "not_git_repo"
    | "git_missing"
    | "git_timeout"
    | "permission_denied"
    | "unknown";

/**
 * Strict project identity resolution error with stable machine-readable classification.
 */
export class ProjectIdentityError extends Error {
    readonly errorClass: ProjectIdentityErrorClass;
    readonly rawDirectory: string;

    constructor(
        errorClass: ProjectIdentityErrorClass,
        rawDirectory: string,
        message: string,
        cause?: Error,
    ) {
        super(message);
        this.name = "ProjectIdentityError";
        this.errorClass = errorClass;
        this.rawDirectory = rawDirectory;
        if (cause) {
            this.cause = cause;
        }
    }
}

function asError(error: unknown): Error | undefined {
    return error instanceof Error ? error : undefined;
}

function getErrorCode(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("code" in error)) {
        return undefined;
    }
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
}

function getErrorSignal(error: unknown): string | undefined {
    if (error === null || typeof error !== "object" || !("signal" in error)) {
        return undefined;
    }
    const signal = (error as { signal?: unknown }).signal;
    return typeof signal === "string" ? signal : undefined;
}

function getErrorKilled(error: unknown): boolean {
    if (error === null || typeof error !== "object" || !("killed" in error)) {
        return false;
    }
    return (error as { killed?: unknown }).killed === true;
}

function getErrorStderr(error: unknown): string {
    if (error === null || typeof error !== "object" || !("stderr" in error)) {
        return "";
    }
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string") {
        return stderr;
    }
    if (Buffer.isBuffer(stderr)) {
        return stderr.toString("utf8");
    }
    return "";
}

function directoryFallback(directory: string): string {
    // Use a hash of the full canonical path to avoid collisions between
    // directories with the same basename (e.g. /tmp/api vs /work/api).
    // Switched from Bun.hash to MD5 prefix when the storage layer moved off
    // bun:sqlite — see commit d03e148. This is a one-time prefix change for
    // non-git project memories: existing `dir:<wyhash>` rows become orphaned
    // and any new memories use `dir:<md5-prefix>`. Most users are git-backed
    // (unaffected). Doctor can be extended to re-key if needed.
    const canonical = path.resolve(directory);
    const hash = createHash("md5").update(canonical, "utf8").digest("hex").slice(0, 12);
    return `dir:${hash}`;
}

function assertDirectoryUsable(canonicalDirectory: string, rawDirectory: string): void {
    try {
        const stat = statSync(canonicalDirectory);
        if (!stat.isDirectory()) {
            throw new ProjectIdentityError(
                "unknown",
                rawDirectory,
                `Project path is not a directory: ${canonicalDirectory}`,
            );
        }
    } catch (error) {
        if (error instanceof ProjectIdentityError) {
            throw error;
        }

        const code = getErrorCode(error);
        if (code === "EACCES" || code === "EPERM") {
            throw new ProjectIdentityError(
                "permission_denied",
                rawDirectory,
                `Permission denied while accessing project directory: ${canonicalDirectory}`,
                asError(error),
            );
        }

        throw new ProjectIdentityError(
            "unknown",
            rawDirectory,
            `Unable to access project directory: ${canonicalDirectory}`,
            asError(error),
        );
    }
}

function isGitTimeoutError(error: unknown): boolean {
    const code = getErrorCode(error);
    const signal = getErrorSignal(error);
    return (
        code === "ETIMEDOUT" ||
        signal === "SIGTERM" ||
        signal === "SIGKILL" ||
        getErrorKilled(error)
    );
}

function classifyGitError(error: unknown, rawDirectory: string): ProjectIdentityError {
    if (isGitTimeoutError(error)) {
        return new ProjectIdentityError(
            "git_timeout",
            rawDirectory,
            `git rev-list timed out after ${GIT_TIMEOUT_MS}ms`,
            asError(error),
        );
    }

    const code = getErrorCode(error);
    if (code === "ENOENT") {
        return new ProjectIdentityError(
            "git_missing",
            rawDirectory,
            "git binary is not available in PATH",
            asError(error),
        );
    }
    if (code === "EACCES" || code === "EPERM") {
        return new ProjectIdentityError(
            "permission_denied",
            rawDirectory,
            "Permission denied while spawning git",
            asError(error),
        );
    }

    const stderr = getErrorStderr(error).toLowerCase();
    if (
        stderr.includes("not a git repository") ||
        stderr.includes("does not have any commits yet") ||
        stderr.includes("ambiguous argument 'head'") ||
        stderr.includes("unknown revision or path")
    ) {
        return new ProjectIdentityError(
            "not_git_repo",
            rawDirectory,
            "Directory has no git root commit; caller may use directory fallback",
            asError(error),
        );
    }

    return new ProjectIdentityError(
        "unknown",
        rawDirectory,
        "git rev-list failed while resolving project identity",
        asError(error),
    );
}

/**
 * Strictly resolve the project identity for a filesystem directory.
 *
 * Returns only `git:<root-commit-sha>` and never silently falls back. Failures are thrown as
 * `ProjectIdentityError` with a stable `errorClass` so callers can distinguish deterministic
 * non-git directories from transient git/runtime failures.
 *
 * The cache is process-local, keyed by `path.resolve(directory)`, and stores only successful git
 * identities. Transient failures are never cached.
 */
export function resolveProjectIdentityStrict(directory: string): string {
    const canonical = path.resolve(directory);
    const cached = identityCache.get(canonical);
    if (cached !== undefined) {
        return cached;
    }

    assertDirectoryUsable(canonical, directory);

    let output: string;
    try {
        output = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], {
            cwd: canonical,
            encoding: "utf8",
            env: { ...process.env, LC_ALL: "C", LANG: "C" },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: GIT_TIMEOUT_MS,
        });
    } catch (error) {
        throw classifyGitError(error, directory);
    }

    const firstLine = output.split("\n")[0]?.trim() ?? "";
    const rootCommit = firstLine.slice(0, 64);
    if (rootCommit.length < 7) {
        throw new ProjectIdentityError(
            "unknown",
            directory,
            "git rev-list returned no valid root commit hash",
        );
    }

    const identity = `git:${rootCommit}`;
    identityCache.set(canonical, identity);
    return identity;
}

/**
 * Resolve the project identity for the given directory.
 *
 * Returns a stable string suitable for use as a database key:
 *   - `"git:<sha>"` for git repositories with at least one commit
 *   - `"dir:<md5-12>"` for accessible non-git directories or empty repos
 *
 * Missing/non-existent directories also keep the legacy deterministic `dir:<md5-12>` behavior;
 * transient git failures still propagate so callers can record or retry them instead of silently
 * writing a wrong project identity.
 */
function shouldUseDirectoryFallback(error: ProjectIdentityError): boolean {
    return (
        error.errorClass === "not_git_repo" ||
        (error.errorClass === "unknown" &&
            error.message.startsWith("Unable to access project directory:"))
    );
}

export function resolveProjectIdentity(directory: string): string {
    const canonical = path.resolve(directory);
    const cachedFallback = directoryFallbackCache.get(canonical);
    if (cachedFallback !== undefined) {
        return cachedFallback;
    }

    try {
        return resolveProjectIdentityStrict(directory);
    } catch (error) {
        if (error instanceof ProjectIdentityError && shouldUseDirectoryFallback(error)) {
            const fallback = directoryFallback(canonical);
            directoryFallbackCache.set(canonical, fallback);
            return fallback;
        }
        throw error;
    }
}

/**
 * Normalize a stored project path or legacy raw filesystem path.
 *
 * Already-resolved `git:` / `dir:` identities are returned byte-for-byte. Raw filesystem paths are
 * resolved through the production wrapper. This helper is intentionally best-effort for existing
 * stored data: if strict resolution cannot classify the path, it falls back to the deterministic
 * `dir:<md5-12>` identity instead of throwing.
 */
export function normalizeStoredProjectPath(rawOrStored: string): string {
    if (rawOrStored.startsWith("git:") || rawOrStored.startsWith("dir:")) {
        return rawOrStored;
    }

    try {
        return resolveProjectIdentity(rawOrStored);
    } catch {
        return directoryFallback(rawOrStored);
    }
}
