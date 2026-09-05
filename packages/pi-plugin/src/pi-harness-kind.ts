import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { piHarnessKindFromExecutable } from "@magic-context/core/shared/pi-executable";

export type PiHarnessKind = "pi" | "omp";
export type PiHarnessDetectionMethod =
	| "process-title"
	| "package-name"
	| "app-name"
	| "executable-name"
	| "default"
	| "test-override";

export interface PiHarnessDetection {
	kind: PiHarnessKind;
	via: PiHarnessDetectionMethod;
}

const OMP_UTILS_MODULE = "@oh-my-pi/pi-utils";
const OMP_HOST_PACKAGE = "@oh-my-pi/pi-coding-agent";
const PI_HOST_PACKAGES = new Set([
	"@earendil-works/pi-coding-agent",
	"@mariozechner/pi-coding-agent",
]);
const HARNESS_DETECTION_SLOT = Symbol.for("magic-context.pi.harness-detection");
const HARNESS_DETECTION_PROMISE_SLOT = Symbol.for(
	"magic-context.pi.harness-detection-promise",
);

type HarnessKindGlobal = typeof globalThis & {
	[HARNESS_DETECTION_SLOT]?: PiHarnessDetection;
	[HARNESS_DETECTION_PROMISE_SLOT]?: Promise<PiHarnessDetection>;
};

interface HostEntry {
	requestedPath: string;
	resolvedPath: string;
}

interface PackageJson {
	name?: unknown;
	exports?: unknown;
	main?: unknown;
	module?: unknown;
}

function hostEntries(): HostEntry[] {
	const entries: HostEntry[] = [];
	const seen = new Set<string>();
	for (const candidate of [process.argv[1], process.execPath]) {
		if (!candidate) continue;
		const requestedPath = resolve(candidate);
		let resolvedPath: string;
		try {
			resolvedPath = realpathSync(requestedPath);
		} catch {
			resolvedPath = requestedPath;
		}
		if (seen.has(resolvedPath)) continue;
		seen.add(resolvedPath);
		entries.push({ requestedPath, resolvedPath });
	}
	return entries;
}

function readPackageJson(path: string): PackageJson | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PackageJson;
	} catch {
		return undefined;
	}
}

function nearestPackageName(entryPath: string): string | undefined {
	let directory = dirname(entryPath);
	const root = parse(directory).root;
	while (true) {
		const packagePath = join(directory, "package.json");
		if (existsSync(packagePath)) {
			const name = readPackageJson(packagePath)?.name;
			return typeof name === "string" ? name : undefined;
		}
		if (directory === root) return undefined;
		directory = dirname(directory);
	}
}

function packageNameDetection(
	entries: readonly HostEntry[],
): PiHarnessDetection | undefined {
	for (const entry of entries) {
		const packageName = nearestPackageName(entry.resolvedPath);
		if (packageName === OMP_HOST_PACKAGE) {
			return { kind: "omp", via: "package-name" };
		}
		if (packageName !== undefined && PI_HOST_PACKAGES.has(packageName)) {
			return { kind: "pi", via: "package-name" };
		}
	}
	return undefined;
}

function dependencyPackageRoot(
	entryPath: string,
	moduleName: string,
): string | undefined {
	const moduleParts = moduleName.split("/");
	let directory = dirname(entryPath);
	const root = parse(directory).root;
	while (true) {
		const packageRoot = join(directory, "node_modules", ...moduleParts);
		if (existsSync(join(packageRoot, "package.json"))) return packageRoot;
		if (directory === root) return undefined;
		directory = dirname(directory);
	}
}

function importTarget(exportsValue: unknown): string | undefined {
	if (typeof exportsValue === "string") return exportsValue;
	if (!exportsValue || typeof exportsValue !== "object") return undefined;
	const conditions = exportsValue as Record<string, unknown>;
	if (typeof conditions.import === "string") return conditions.import;
	if (typeof conditions.default === "string") return conditions.default;
	return importTarget(conditions["."]);
}

function hostModuleImportUrl(entryPath: string): string | undefined {
	const packageRoot = dependencyPackageRoot(entryPath, OMP_UTILS_MODULE);
	if (!packageRoot) return undefined;
	const packageJson = readPackageJson(join(packageRoot, "package.json"));
	const target =
		importTarget(packageJson?.exports) ??
		(typeof packageJson?.module === "string"
			? packageJson.module
			: typeof packageJson?.main === "string"
				? packageJson.main
				: undefined);
	if (!target?.startsWith("./")) return undefined;
	return pathToFileURL(resolve(packageRoot, target)).href;
}

async function appNameDetection(
	entries: readonly HostEntry[],
): Promise<PiHarnessDetection | undefined> {
	for (const entry of entries) {
		const moduleUrl = hostModuleImportUrl(entry.resolvedPath);
		if (!moduleUrl) continue;
		try {
			const hostUtils = (await import(moduleUrl)) as { APP_NAME?: unknown };
			if (hostUtils.APP_NAME === "omp") {
				return { kind: "omp", via: "app-name" };
			}
		} catch {
			// Import failures are inconclusive; try the next host entry, then the executable fallback.
		}
	}
	return undefined;
}

function executableDetection(
	entries: readonly HostEntry[],
): PiHarnessDetection | undefined {
	for (const entry of entries) {
		const kind = piHarnessKindFromExecutable(entry.requestedPath);
		if (kind !== undefined) return { kind, via: "executable-name" };
	}
	return undefined;
}

async function detectPiHarnessKind(): Promise<PiHarnessDetection> {
	// OMP and Pi set process.title to APP_NAME before loading extensions.
	const processTitleKind = piHarnessKindFromExecutable(process.title);
	if (processTitleKind !== undefined) {
		return { kind: processTitleKind, via: "process-title" };
	}

	const entries = hostEntries();
	return (
		packageNameDetection(entries) ??
		(await appNameDetection(entries)) ??
		executableDetection(entries) ?? { kind: "pi", via: "default" }
	);
}

/** Resolve and memoize the Pi-compatible host together with diagnostic evidence. */
export async function resolvePiHarnessDetection(): Promise<PiHarnessDetection> {
	const processGlobal = globalThis as HarnessKindGlobal;
	if (processGlobal[HARNESS_DETECTION_SLOT] !== undefined) {
		return processGlobal[HARNESS_DETECTION_SLOT];
	}
	if (processGlobal[HARNESS_DETECTION_PROMISE_SLOT] === undefined) {
		processGlobal[HARNESS_DETECTION_PROMISE_SLOT] = detectPiHarnessKind();
	}
	const pending = processGlobal[HARNESS_DETECTION_PROMISE_SLOT];
	try {
		const detection = await pending;
		processGlobal[HARNESS_DETECTION_SLOT] = detection;
		return detection;
	} finally {
		if (processGlobal[HARNESS_DETECTION_PROMISE_SLOT] === pending) {
			delete processGlobal[HARNESS_DETECTION_PROMISE_SLOT];
		}
	}
}

/** Resolve synchronously for runtime callers; boot's full async result wins once memoized. */
export function resolvePiHarnessKind(): PiHarnessKind {
	const processGlobal = globalThis as HarnessKindGlobal;
	const memoized = processGlobal[HARNESS_DETECTION_SLOT];
	if (memoized !== undefined) return memoized.kind;

	const processTitleKind = piHarnessKindFromExecutable(process.title);
	const entries = hostEntries();
	const detection =
		(processTitleKind !== undefined
			? { kind: processTitleKind, via: "process-title" as const }
			: undefined) ??
		packageNameDetection(entries) ??
		executableDetection(entries);
	if (detection !== undefined) {
		processGlobal[HARNESS_DETECTION_SLOT] = detection;
		return detection.kind;
	}
	return "pi";
}

/** Test-only memo override. Passing undefined restores normal detection. */
export function __setPiHarnessKindForTesting(
	kind: PiHarnessKind | undefined,
): void {
	const processGlobal = globalThis as HarnessKindGlobal;
	delete processGlobal[HARNESS_DETECTION_PROMISE_SLOT];
	if (kind === undefined) delete processGlobal[HARNESS_DETECTION_SLOT];
	else {
		processGlobal[HARNESS_DETECTION_SLOT] = {
			kind,
			via: "test-override",
		};
	}
}
