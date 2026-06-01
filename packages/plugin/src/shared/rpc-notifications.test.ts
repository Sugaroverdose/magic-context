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

    test("scopes drain to the requesting session; other sessions' items survive", () => {
        // drain everything left from prior tests
        drainNotifications(Number.MAX_SAFE_INTEGER);

        pushNotification("for-a", { action: "show-upgrade-dialog" }, "ses_A");
        pushNotification("for-b", { action: "show-upgrade-dialog" }, "ses_B");
        pushNotification("global", { action: "show-status-dialog" });

        // Session A sees only its own item + the global one, never ses_B's.
        const aPoll = drainNotifications(0, "ses_A");
        expect(aPoll.map((m) => m.type).sort()).toEqual(["for-a", "global"]);

        // Acking session A must NOT prune session B's still-unseen notification.
        const ackId = Math.max(...aPoll.map((m) => m.id));
        drainNotifications(ackId, "ses_A");
        const bPoll = drainNotifications(0, "ses_B");
        expect(bPoll.map((m) => m.type)).toContain("for-b");
    });

    test("session-less drain (legacy client) still receives all items", () => {
        drainNotifications(Number.MAX_SAFE_INTEGER);
        pushNotification("x", { ok: true }, "ses_1");
        pushNotification("y", { ok: true }, "ses_2");
        const poll = drainNotifications(0);
        expect(poll.map((m) => m.type).sort()).toEqual(["x", "y"]);
    });
});
