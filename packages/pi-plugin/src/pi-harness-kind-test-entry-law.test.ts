/**
 * LAW: a test-runner-shaped argv[1] must not produce a host detection.
 *
 * Defect class (assembly-v2 lane pi-harness-entry-fix): under `bun test`,
 * argv[1] is the absolute path of the executing test file. hostEntries()
 * fed it to every argv-derived detection rung; the enclosing dev tree's
 * @oh-my-pi/pi-utils devDependency made appNameDetection return omp and
 * memoize kind=omp in the globalThis detection slot, so createTestDb's
 * setHarness("pi") died with "harness already locked to "omp"".
 *
 * These laws are the planted-rogue witnesses: removing (or loosening) the
 * TEST_RUNNER_ENTRY_PATTERN exclusion in pi-harness-kind.ts reddens them.
 * The real-host controls pin the boundary — the exclusion is by filename
 * shape, never by location, so detection through the very same dev tree
 * still works for non-test-shaped host entries.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PI_IMAGE_NAMES } from "@magic-context/core/shared/pi-executable";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";

import {
	__setPiHarnessKindForTesting,
	resolvePiHarnessDetection,
	resolvePiHarnessKind,
} from "./pi-harness-kind";

const HARNESS_DETECTION_SLOT = Symbol.for("magic-context.pi.harness-detection");

function detectionSlot(): { kind: string; via: string } | undefined {
	return (globalThis as Record<symbol, unknown>)[HARNESS_DETECTION_SLOT] as
		| { kind: string; via: string }
		| undefined;
}

const originalArgv1 = process.argv[1];
const originalProcessTitle = process.title;
const temporaryRoots: string[] = [];

function temporaryRoot(): string {
	const root = createTestTempDirFromPath(
		join(tmpdir(), "mc-pi-harness-entry-law-"),
	);
	temporaryRoots.push(root);
	return root;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value)}\n`);
}

function writeEsmOnlyOmpUtils(nodeModules: string): void {
	const moduleRoot = join(nodeModules, "@oh-my-pi", "pi-utils");
	mkdirSync(join(moduleRoot, "src"), { recursive: true });
	writeJson(join(moduleRoot, "package.json"), {
		name: "@oh-my-pi/pi-utils",
		type: "module",
		exports: {
			".": {
				types: "./src/index.ts",
				import: "./src/index.ts",
			},
		},
	});
	writeFileSync(
		join(moduleRoot, "src", "index.ts"),
		'export const APP_NAME = "omp";\n',
	);
}

/**
 * Tree shaped exactly like the defect: the entry file sits inside a package
 * whose enclosing node_modules carries @oh-my-pi/pi-utils with APP_NAME=omp.
 * With `hostPackageName` set, the enclosing package is a real OMP host
 * package name, arming the package-name rung as well as the app-name rung.
 */
function defectTree(entryFileName: string, hostPackageName?: string): string {
	const root = temporaryRoot();
	const install = join(root, "install");
	mkdirSync(install, { recursive: true });
	if (hostPackageName !== undefined) {
		writeJson(join(root, "package.json"), { name: hostPackageName });
	} else {
		writeJson(join(root, "package.json"), { name: "package-under-test" });
	}
	writeEsmOnlyOmpUtils(join(root, "node_modules"));
	const entry = join(install, entryFileName);
	mkdirSync(dirname(entry), { recursive: true });
	writeFileSync(entry, "// entry under detection\n");
	return entry;
}

beforeEach(() => {
	__setPiHarnessKindForTesting(undefined);
	process.title = "magic-context-test";
});

afterEach(() => {
	__setPiHarnessKindForTesting(undefined);
	process.title = originalProcessTitle;
	if (originalArgv1 === undefined) process.argv.splice(1, 1);
	else process.argv[1] = originalArgv1;
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

const TEST_FILE_SHAPES = [
	"probe.test.ts",
	"probe.test.tsx",
	"probe.test.js",
	"probe.test.jsx",
	"probe.test.mjs",
	"probe.test.cjs",
	"probe.spec.ts",
	"probe.spec.tsx",
	"probe.spec.js",
	"probe.spec.jsx",
	"probe.spec.mjs",
	"probe.spec.cjs",
] as const;

describe("LAW: test-runner-shaped argv[1] contributes no host entry", () => {
	it.each(TEST_FILE_SHAPES)(
		"app-name rung stays silent for %s even when the enclosing tree ships @oh-my-pi/pi-utils",
		async (fileName) => {
			process.argv[1] = defectTree(fileName);
			expect(await resolvePiHarnessDetection()).toEqual({
				kind: "pi",
				via: "default",
			});
		},
	);

	it.each(TEST_FILE_SHAPES)(
		"package-name rung stays silent for %s even inside a real host package",
		async (fileName) => {
			process.argv[1] = defectTree(fileName, "@oh-my-pi/pi-coding-agent");
			expect(await resolvePiHarnessDetection()).toEqual({
				kind: "pi",
				via: "default",
			});
		},
	);

	it("real-host control: the same tree detects omp via app-name for a non-test-shaped entry", async () => {
		process.argv[1] = defectTree("probe.js");
		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "omp",
			via: "app-name",
		});
	});

	it("real-host control: the same host package detects omp via package-name for a non-test-shaped entry", async () => {
		process.argv[1] = defectTree("probe.js", "@oh-my-pi/pi-coding-agent");
		expect(await resolvePiHarnessDetection()).toEqual({
			kind: "omp",
			via: "package-name",
		});
	});
});

describe("LAW: the detection slot cannot be populated from *.test.ts-shaped paths", () => {
	it("async detection with only a test-shaped argv[1] memoizes no rung-attributed detection", async () => {
		process.argv[1] = defectTree("host.test.ts", "@oh-my-pi/pi-coding-agent");
		await resolvePiHarnessDetection();
		expect(detectionSlot()).toEqual({ kind: "pi", via: "default" });
	});

	it("sync detection with only a test-shaped argv[1] never writes the slot", () => {
		process.argv[1] = defectTree("omp.test.ts", "@oh-my-pi/pi-coding-agent");
		expect(resolvePiHarnessKind()).toBe("pi");
		expect(detectionSlot()).toBeUndefined();
	});

	it("executable vocabulary and the test-artifact shape are disjoint (no argv[1] can be both)", () => {
		const testShape = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
		for (const imageName of PI_IMAGE_NAMES) {
			expect(testShape.test(imageName)).toBe(false);
		}
	});
});
