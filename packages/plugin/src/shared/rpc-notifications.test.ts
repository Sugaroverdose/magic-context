import { describe, expect, test } from "bun:test";
import { drainNotifications, pushNotification } from "./rpc-notifications";

describe("rpc notifications", () => {
    test("keeps messages queued until the client acks their id", () => {
        const initial = drainNotifications(Number.MAX_SAFE_INTEGER);
        expect(initial).toEqual([]);

        pushNotification("one", { ok: true }, "ses_1");
        const firstPoll = drainNotifications();
        expect(firstPoll).toHaveLength(1);
        expect(firstPoll[0].type).toBe("one");

        const retryPoll = drainNotifications();
        expect(retryPoll.map((m) => m.id)).toEqual(firstPoll.map((m) => m.id));

        const lastReceivedId = Math.max(...firstPoll.map((m) => m.id));
        expect(drainNotifications(lastReceivedId)).toEqual([]);
    });
});
