import { describe, expect, test } from "bun:test";
import {
    createBootBudget,
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
});
