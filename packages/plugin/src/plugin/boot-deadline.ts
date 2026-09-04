export type BootPhaseResult<T> =
    | { status: "completed"; value: T; elapsedMs: number }
    | { status: "timed_out"; elapsedMs: number };

/**
 * Keep an awaited plugin boot phase from holding OpenCode's plugin loader forever.
 * The timed-out operation is observed to prevent a late rejection from becoming
 * unhandled, but startup proceeds immediately because JavaScript promises cannot
 * cancel arbitrary plugin work.
 */
export async function runBootPhaseWithDeadline<T>(
    phase: string,
    operation: () => Promise<T>,
    timeoutMs: number,
    report: (message: string) => void,
): Promise<BootPhaseResult<T>> {
    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const running = Promise.resolve().then(operation);
    const timeout = new Promise<BootPhaseResult<T>>((resolve) => {
        timer = setTimeout(() => {
            const elapsedMs = performance.now() - startedAt;
            report(
                `[magic-context] boot phase '${phase}' exceeded its ${timeoutMs}ms deadline; host startup will continue with Magic Context fail-closed`,
            );
            resolve({ status: "timed_out", elapsedMs });
        }, timeoutMs);
    });
    const completed = running.then<BootPhaseResult<T>>((value) => ({
        status: "completed",
        value,
        elapsedMs: performance.now() - startedAt,
    }));

    try {
        const result = await Promise.race([completed, timeout]);
        if (result.status === "timed_out") {
            void running.catch((error) => {
                report(
                    `[magic-context] boot phase '${phase}' rejected after its deadline: ${error instanceof Error ? error.message : String(error)}`,
                );
            });
        }
        return result;
    } finally {
        if (timer) clearTimeout(timer);
    }
}
