import { describe, expect, test } from "bun:test";
import {
    createBootBudget,
    emitBootEnteringBreadcrumb,
    formatBootPhaseDiagnostics,
    runBootPhaseWithDeadline,
    runBootPhaseWithinBudget,
} from "./boot-deadline";

describe("boot phase deadline", () => {
    test("plugin hook initialization resolves when the boot dependency never settles", async () => {
        const startedAt = performance.now();
        const messages: string[] = [];

        const result = await runBootPhaseWithDeadline(
            "hooks",
            () => new Promise<never>(() => {}),
            20,
            (message) => messages.push(message),
        );

        expect(result.status).toBe("timed_out");
        expect(performance.now() - startedAt).toBeLessThan(250);
        expect(messages).toEqual([
            "[magic-context] boot phase 'hooks' exceeded its 20ms deadline; host startup will continue with Magic Context fail-closed",
        ]);
    });

    test("a phase that merely runs long hands its late value to the caller", async () => {
        // The contended-migration-lock shape: the open outlives the deadline but
        // succeeds. The caller must be able to adopt that value, otherwise a slow
        // box turns into a process-lifetime fail-closed session.
        const result = await runBootPhaseWithDeadline(
            "hooks",
            () => new Promise<string>((resolve) => setTimeout(() => resolve("real hooks"), 40)),
            10,
            () => {},
        );

        expect(result.status).toBe("timed_out");
        if (result.status !== "timed_out") return;
        await expect(result.pending).resolves.toBe("real hooks");
    });

    test("one boot budget bounds consecutive phases by the original deadline", async () => {
        const startedAt = performance.now();
        const messages: string[] = [];
        const budget = createBootBudget(45);

        await new Promise((resolve) => setTimeout(resolve, 25));
        const result = await runBootPhaseWithinBudget(
            budget,
            "hooks",
            () => new Promise<never>(() => {}),
            (message) => messages.push(message),
        );

        expect(result.status).toBe("timed_out");
        expect(performance.now() - startedAt).toBeLessThan(60);
        expect(messages[0]).toContain("whole-server 45ms budget");
        expect(messages[0]).toContain("phase 'hooks'");
    });

    test("an exhausted whole-server budget returns before a synchronous late-recovery prefix", async () => {
        const budget = createBootBudget(0);
        let invoked = false;
        const result = await runBootPhaseWithinBudget(
            budget,
            "hooks",
            async () => {
                invoked = true;
                return "late hooks";
            },
            () => {},
        );

        expect(result.status).toBe("timed_out");
        expect(invoked).toBe(false);
        if (result.status === "timed_out") await expect(result.pending).resolves.toBe("late hooks");
    });

    test("returns a completed phase value and timing", async () => {
        const result = await runBootPhaseWithDeadline(
            "rpc",
            async () => 42,
            100,
            () => {},
        );

        expect(result.status).toBe("completed");
        if (result.status === "completed") expect(result.value).toBe(42);
        expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    });

    test("flushes the entering breadcrumb with the real process and directory values", () => {
        const events: string[] = [];

        emitBootEnteringBreadcrumb(
            4312,
            "/work/incident-checkout",
            (message) => events.push(`report:${message}`),
            () => events.push("flush"),
        );

        expect(events).toEqual([
            "report:[magic-context] boot: entering pid=4312 dir=/work/incident-checkout",
            "flush",
        ]);
    });

    test("phase diagnostics distinguish elapsed work and the exhausted phase", () => {
        const quiet = formatBootPhaseDiagnostics({
            configMs: 0,
            conflictMs: 0,
            guardMs: 0,
            openMs: 0,
            migrateMs: 0,
            hooksMs: 0,
            rpcMs: 0,
            postMs: 0,
            totalMs: 0,
            budgetMs: 15_000,
            deadlinePhase: null,
        });
        const exhausted = formatBootPhaseDiagnostics({
            configMs: 1.4,
            conflictMs: 2.5,
            guardMs: 3.6,
            openMs: 4.7,
            migrateMs: 5.8,
            hooksMs: 6.9,
            rpcMs: 7.1,
            postMs: 8.2,
            totalMs: 39.3,
            budgetMs: 15_000,
            deadlinePhase: "hooks",
        });

        expect(quiet).toBe(
            "[magic-context] boot phases: config=0ms conflict=0ms guard=0ms open=0ms migrate=0ms hooks=0ms rpc=0ms post=0ms total=0ms budget=15000ms deadline_phase=none",
        );
        expect(exhausted).toBe(
            "[magic-context] boot phases: config=1ms conflict=3ms guard=4ms open=5ms migrate=6ms hooks=7ms rpc=7ms post=8ms total=39ms budget=15000ms deadline_phase=hooks",
        );
        expect(exhausted).not.toBe(quiet);
    });
});
