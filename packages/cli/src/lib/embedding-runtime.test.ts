import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLocalEmbeddingRuntime, checkLocalEmbeddingRuntimeAt } from "./embedding-runtime";

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), "mc-embruntime-"));
}

function installPackage(root: string, withBinary: boolean): void {
    const pkgDir = join(root, "node_modules", "onnxruntime-node");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "onnxruntime-node" }));
    if (withBinary) {
        const binDir = join(pkgDir, "bin", "napi-v6", "win32", "x64");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "onnxruntime_binding.node"), "stub");
    }
}

describe("checkLocalEmbeddingRuntimeAt", () => {
    test("package + matching binary present → ok", () => {
        const root = makeRoot();
        try {
            installPackage(root, true);
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("ok");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("package missing entirely → package-missing (the #128 Windows case)", () => {
        const root = makeRoot();
        try {
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("package-missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("package present but platform binary missing → binary-missing", () => {
        const root = makeRoot();
        try {
            installPackage(root, false); // no .node binary
            const status = checkLocalEmbeddingRuntimeAt(root, "win32", "x64");
            expect(status.state).toBe("binary-missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    test("unknown platform/arch with package present → ok (don't false-alarm)", () => {
        const root = makeRoot();
        try {
            installPackage(root, false);
            const status = checkLocalEmbeddingRuntimeAt(
                root,
                "freebsd" as NodeJS.Platform,
                "ppc64",
            );
            expect(status.state).toBe("ok");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

describe("checkLocalEmbeddingRuntime (multi-root)", () => {
    test("no candidate root exists → unknown (stay silent)", () => {
        const status = checkLocalEmbeddingRuntime([
            join(tmpdir(), "does-not-exist-mc-1"),
            join(tmpdir(), "does-not-exist-mc-2"),
        ]);
        expect(status.state).toBe("unknown");
    });

    test("first root broken, second ok → returns ok", () => {
        const broken = makeRoot();
        const good = makeRoot();
        try {
            // broken: exists but no package
            installPackage(good, true);
            const status = checkLocalEmbeddingRuntime([broken, good], "win32", "x64");
            expect(status.state).toBe("ok");
        } finally {
            rmSync(broken, { recursive: true, force: true });
            rmSync(good, { recursive: true, force: true });
        }
    });

    test("existing root with missing package → package-missing", () => {
        const root = makeRoot();
        try {
            const status = checkLocalEmbeddingRuntime([root], "win32", "x64");
            expect(status.state).toBe("package-missing");
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
