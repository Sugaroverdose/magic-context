import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Detects whether the local-embedding native runtime (`onnxruntime-node`) is
 * actually present and usable in an installed plugin tree.
 *
 * Why this check exists (issue #128): the plugin's `@huggingface/transformers`
 * Node entry does a STATIC `import "onnxruntime-node"`. When that package — or
 * its platform-specific native binary — failed to install (seen on Windows when
 * the binary download is interrupted), the import throws
 * `Cannot find package 'onnxruntime-node'` on EVERY embedding attempt, and the
 * runtime can only degrade. Doctor surfaces it ahead of time with an actionable
 * fix instead of leaving users to decode the cryptic resolver error.
 */

export type LocalEmbeddingRuntimeStatus =
    | { state: "ok"; binaryPath: string }
    | { state: "package-missing"; packageDir: string }
    | { state: "binary-missing"; packageDir: string; expectedBinary: string }
    | { state: "unknown"; reason: string };

/**
 * Maps `process.platform`/`process.arch` to onnxruntime-node's on-disk binary
 * layout: `bin/napi-v6/<platform>/<arch>/onnxruntime_binding.node`. The dir
 * names match Node's platform/arch tokens directly (linux/darwin/win32,
 * x64/arm64), so no translation is needed beyond filtering to what ships.
 */
function expectedBinaryRelPath(platform: NodeJS.Platform, arch: string): string | null {
    const supportedPlatform = platform === "linux" || platform === "darwin" || platform === "win32";
    const supportedArch = arch === "x64" || arch === "arm64";
    if (!supportedPlatform || !supportedArch) return null;
    return join("bin", "napi-v6", platform, arch, "onnxruntime_binding.node");
}

/**
 * Check a single install root (the directory that owns `node_modules`) for a
 * usable onnxruntime-node. `npm`/Bun hoist transitive deps, so the package lands
 * at `<installRoot>/node_modules/onnxruntime-node`.
 */
export function checkLocalEmbeddingRuntimeAt(
    installRoot: string,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): LocalEmbeddingRuntimeStatus {
    const packageDir = join(installRoot, "node_modules", "onnxruntime-node");
    if (!existsSync(join(packageDir, "package.json"))) {
        return { state: "package-missing", packageDir };
    }
    const rel = expectedBinaryRelPath(platform, arch);
    if (rel === null) {
        // Unknown platform/arch — the package is present; don't false-alarm on a
        // binary path we can't predict. transformers will surface a real error if
        // it genuinely can't load.
        return { state: "ok", binaryPath: packageDir };
    }
    const binaryPath = join(packageDir, rel);
    if (!existsSync(binaryPath)) {
        return { state: "binary-missing", packageDir, expectedBinary: binaryPath };
    }
    return { state: "ok", binaryPath };
}

/**
 * Check across candidate install roots (a plugin can be cached under
 * `@pkg@latest/...` or `@pkg/...`). Returns the first `ok`; otherwise the first
 * informative failure; `unknown` only when no candidate root even exists (we
 * can't introspect the install, so we stay silent rather than false-alarm).
 */
export function checkLocalEmbeddingRuntime(
    installRoots: string[],
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): LocalEmbeddingRuntimeStatus {
    const existing = installRoots.filter((root) => existsSync(root));
    if (existing.length === 0) {
        return {
            state: "unknown",
            reason: "no installed plugin tree found to inspect",
        };
    }
    let firstFailure: LocalEmbeddingRuntimeStatus | null = null;
    for (const root of existing) {
        const status = checkLocalEmbeddingRuntimeAt(root, platform, arch);
        if (status.state === "ok") return status;
        if (firstFailure === null) firstFailure = status;
    }
    return firstFailure ?? { state: "unknown", reason: "no candidate roots" };
}
