import { createRequire } from "node:module";
import { resolve } from "node:path";

export type PiHarnessKind = "pi" | "omp";

const OMP_UTILS_MODULE = "@oh-my-pi/pi-utils";
const HARNESS_KIND_SLOT = Symbol.for("magic-context.pi.harness-kind");

type HarnessKindGlobal = typeof globalThis & {
	[HARNESS_KIND_SLOT]?: PiHarnessKind;
};

function hostModuleRequesters(): string[] {
	return [
		...new Set(
			[process.argv[1], process.execPath]
				.filter(Boolean)
				.map((path) => resolve(path)),
		),
	];
}

function detectPiHarnessKind(): PiHarnessKind {
	for (const requester of hostModuleRequesters()) {
		try {
			const requireFromHost = createRequire(requester);
			const modulePath = requireFromHost.resolve(OMP_UTILS_MODULE);
			const hostUtils = requireFromHost(modulePath) as { APP_NAME?: unknown };
			if (hostUtils.APP_NAME === "omp") return "omp";
		} catch {
			// Plain Pi does not install OMP utilities; keep trying host entry points.
		}
	}
	return "pi";
}

/** Resolve the Pi-compatible host without depending on OMP or executable layout. */
export function resolvePiHarnessKind(): PiHarnessKind {
	const processGlobal = globalThis as HarnessKindGlobal;
	if (processGlobal[HARNESS_KIND_SLOT] === undefined) {
		processGlobal[HARNESS_KIND_SLOT] = detectPiHarnessKind();
	}
	return processGlobal[HARNESS_KIND_SLOT];
}

/** Test-only memo override. Passing undefined restores normal detection. */
export function __setPiHarnessKindForTesting(
	kind: PiHarnessKind | undefined,
): void {
	const processGlobal = globalThis as HarnessKindGlobal;
	if (kind === undefined) delete processGlobal[HARNESS_KIND_SLOT];
	else processGlobal[HARNESS_KIND_SLOT] = kind;
}
