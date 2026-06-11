import { describe, expect, it, mock } from "bun:test";
import { sendIgnoredMessage } from "./send-session-notification";

const DEFAULT_TITLE = "New session - 2026-06-11T12:00:00.000Z";

describe("sendIgnoredMessage", () => {
    it("returns skipped and does not post when the session never gets a real title", async () => {
        const originalSetTimeout = globalThis.setTimeout;
        globalThis.setTimeout = ((
            handler: Parameters<typeof setTimeout>[0],
            _timeout?: number,
            ...args: unknown[]
        ) => {
            if (typeof handler === "function") handler(...args);
            return 0 as never;
        }) as typeof setTimeout;

        try {
            const prompt = mock(async () => ({}));
            const get = mock(async () => ({ title: DEFAULT_TITLE }));
            const result = await sendIgnoredMessage(
                { session: { get, prompt } },
                "ses-never-titled",
                "persistent notification",
                {},
            );

            expect(result).toBe("skipped");
            expect(get).toHaveBeenCalledTimes(4);
            expect(prompt).not.toHaveBeenCalled();
        } finally {
            globalThis.setTimeout = originalSetTimeout;
        }
    });
});
