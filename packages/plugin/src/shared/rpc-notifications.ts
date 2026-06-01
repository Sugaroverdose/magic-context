/**
 * In-memory notification queue for server→TUI push.
 * Replaces SQLite plugin_messages table.
 *
 * Also tracks whether a TUI client is actively connected (polling).
 * The server plugin cannot use `process.env.OPENCODE_CLIENT` to detect TUI
 * because the server runs in a separate process from the TUI client.
 */

export interface RpcNotification {
    id: number;
    type: string;
    payload: Record<string, unknown>;
    sessionId?: string;
}

let queue: RpcNotification[] = [];
let nextNotificationId = 1;
// Timestamp of last drain — used to detect if TUI is actively polling.
// The TUI polls every 500ms; we consider it connected if it polled within
// the last 3 seconds (6× the poll interval, tolerates transient delays).
let lastDrainAt = 0;
const TUI_CONNECTED_WINDOW_MS = 3_000;

/** Push a notification for TUI to pick up via polling. */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): void {
    queue.push({ id: nextNotificationId++, type, payload, sessionId });
    // Cap queue size to prevent unbounded growth if TUI is not polling
    if (queue.length > 100) {
        queue = queue.slice(-50);
    }
}

/** Return pending notifications after acking the client's last received id.
 *  Updates lastDrainAt so isTuiConnected() reflects recent activity.
 *
 *  Session scoping: when `sessionId` is provided, only notifications tagged for
 *  that session (or session-less/global ones) are returned and pruned — a
 *  notification tagged for a DIFFERENT session is never handed to this client
 *  and is never pruned by this client's ack. This matters because the in-memory
 *  queue is per-process but a TUI can end up draining a process that also serves
 *  OTHER sessions: e.g. opening OpenCode Desktop on the same project starts a
 *  newer RPC server that the TUI's port discovery (newest-pid-wins) then selects,
 *  so a Desktop-session upgrade-dialog action would otherwise surface in an
 *  unrelated TUI session. Each client also tracks its own `lastReceivedId`, so a
 *  global watermark prune would let session A's ack drop session B's still-unseen
 *  notification — scoping the prune to the acking session prevents that too.
 *
 *  Delivery is at-least-once (non-destructive return + prune-on-ack): a returned
 *  notification stays queued until a later call acks it via a higher
 *  `lastReceivedId`, so a lost poll response re-delivers on the next poll. */
export function drainNotifications(
    lastReceivedId = 0,
    sessionId?: string,
): RpcNotification[] {
    lastDrainAt = Date.now();
    const matchesClient = (notification: RpcNotification): boolean =>
        sessionId === undefined ||
        notification.sessionId === undefined ||
        notification.sessionId === sessionId;
    if (lastReceivedId > 0) {
        // Prune only notifications THIS client both owns (session-matched) and has
        // acked (id <= lastReceivedId). Other sessions' notifications survive.
        queue = queue.filter(
            (notification) =>
                !(notification.id <= lastReceivedId && matchesClient(notification)),
        );
    }
    return queue.filter(
        (notification) =>
            notification.id > lastReceivedId && matchesClient(notification),
    );
}

/** Whether a TUI client is actively polling for notifications.
 *  Returns true only if the TUI has drained within the last 3 seconds.
 *  This prevents stale-connected state after TUI closes or disconnects. */
export function isTuiConnected(): boolean {
    return lastDrainAt > 0 && Date.now() - lastDrainAt < TUI_CONNECTED_WINDOW_MS;
}
