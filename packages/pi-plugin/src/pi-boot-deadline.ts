import { runBootPhaseWithDeadline } from "@magic-context/core/plugin/boot-deadline";

export interface PiFailClosedSurface<T> {
	adoptRecovered(value: T): Promise<boolean>;
}

export interface PiFailClosedRegistration<T, Reason> {
	reason: Reason;
	tryReopen: () => Promise<T | null>;
	onRecovered: (value: T) => Promise<void>;
}

export type PiRuntimeBootResult =
	| { status: "ready" }
	| { status: "unavailable" }
	| { status: "timed_out"; lateAdoption: Promise<boolean> };

/**
 * Bound Pi/OMP extension loading without abandoning a healthy storage open that
 * settles late. Re-probes share that original promise until it settles, so a
 * migration-lock delay cannot create a second concurrent open.
 */
export async function bootPiRuntimeWithDeadline<T, Reason>(args: {
	deadlineMs: number;
	openStorage: () => Promise<T | null>;
	startRuntime: (value: T) => Promise<void>;
	unavailableReason: () => Reason;
	deadlineReason: Reason;
	registerFailClosed: (
		registration: PiFailClosedRegistration<T, Reason>,
	) => PiFailClosedSurface<T>;
	report: (message: string) => void;
}): Promise<PiRuntimeBootResult> {
	let runtimeStarted = false;
	let runtimeStart: Promise<void> | null = null;
	const startRuntimeOnce = async (value: T): Promise<void> => {
		if (runtimeStarted) return;
		if (runtimeStart) return runtimeStart;
		runtimeStart = (async () => {
			await args.startRuntime(value);
			runtimeStarted = true;
		})();
		try {
			await runtimeStart;
		} finally {
			if (!runtimeStarted) runtimeStart = null;
		}
	};

	const phase = await runBootPhaseWithDeadline(
		"pi runtime",
		async () => {
			const value = await args.openStorage();
			if (value !== null) await startRuntimeOnce(value);
			return value;
		},
		args.deadlineMs,
		args.report,
	);
	if (phase.status === "completed") {
		if (phase.value === null) {
			args.registerFailClosed({
				reason: args.unavailableReason(),
				tryReopen: args.openStorage,
				onRecovered: startRuntimeOnce,
			});
			return { status: "unavailable" };
		}
		return { status: "ready" };
	}

	let pendingOpen: Promise<T | null> | null = phase.pending;
	const surface = args.registerFailClosed({
		reason: args.deadlineReason,
		tryReopen: () => pendingOpen ?? args.openStorage(),
		onRecovered: startRuntimeOnce,
	});
	const lateAdoption = phase.pending
		.then((value) => (value === null ? false : surface.adoptRecovered(value)))
		.catch(() => false)
		.finally(() => {
			pendingOpen = null;
		});
	return { status: "timed_out", lateAdoption };
}
