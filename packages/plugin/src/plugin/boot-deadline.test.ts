import { describe, expect, test } from "bun:test";
import { runBootPhaseWithDeadline } from "./boot-deadline";

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
