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
// Timestamp of last drain — used to detect if a TUI is actively polling.
// The TUI polls every 500ms; we consider it connected if it polled within
// the last 3 seconds (6× the poll interval, tolerates transient delays).
//
// PER-SESSION: a single server process can serve MANY sessions (e.g. a TUI on
// session A plus an OpenCode Desktop opened on session B for the same project,
// whose newer RPC server this TUI's port discovery then selects). The TUI
// poller drains with ITS active session id, so a session is "TUI-connected"
// only if a TUI recently drained FOR THAT session. A process-global timestamp
// would make session B's producers (`/ctx-status`, upgrade reminder) take the
// TUI-dialog path because session A's TUI is polling — queuing a B-scoped
// dialog action that A's poller correctly refuses to show, so B's notice is
// lost (it also suppressed B's non-TUI fallback). Tracking drains per session
// routes each producer to the right delivery path.
const lastDrainAtBySession = new Map<string, number>();
let lastDrainAtAny = 0;
const TUI_CONNECTED_WINDOW_MS = 3_000;

/** Push a notification for TUI to pick up via polling. */
export function pushNotification(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
): void {
    queue.push({ id: nextNotificationId++, type, payload, sessionId });
    // Cap queue size to prevent unbounded growth if a TUI is not draining.
    // Session-FAIR eviction: a naive `slice(-50)` drops the globally-oldest
    // items, so a noisy session could evict ANOTHER session's single unseen
    // notification. Instead, always retain each session's newest item, then
    // fill the rest of the budget with the newest overall — no session can
    // starve another's pending dialog out of the window.
    if (queue.length > 100) {
        const newestPerSession = new Map<string | undefined, number>();
        for (const n of queue) {
            const prev = newestPerSession.get(n.sessionId);
            if (prev === undefined || n.id > prev) {
                newestPerSession.set(n.sessionId, n.id);
            }
        }
        const mustKeep = new Set(newestPerSession.values());
        const byNewest = [...queue].sort((a, b) => b.id - a.id);
        const kept: RpcNotification[] = [];
        for (const n of byNewest) {
            if (kept.length < 50 || mustKeep.has(n.id)) kept.push(n);
        }
        queue = kept.sort((a, b) => a.id - b.id);
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
    const now = Date.now();
    lastDrainAtAny = now;
    if (sessionId !== undefined) lastDrainAtBySession.set(sessionId, now);
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
 *  Returns true only if a TUI has drained within the last 3 seconds.
 *
 *  Pass `sessionId` (preferred) to ask whether a TUI is polling FOR THAT
 *  SESSION — this is what producers (`/ctx-status`, `/ctx-recomp`, the upgrade
 *  reminder) must use to decide dialog-vs-message, so a TUI on a different
 *  session in the same process does not misroute their delivery. Omit it only
 *  for legacy/global callers that genuinely have no session context; they fall
 *  back to "any session recently drained" (the pre-per-session behavior). */
export function isTuiConnected(sessionId?: string): boolean {
    const now = Date.now();
    if (sessionId !== undefined) {
        const at = lastDrainAtBySession.get(sessionId) ?? 0;
        return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS;
    }
    return lastDrainAtAny > 0 && now - lastDrainAtAny < TUI_CONNECTED_WINDOW_MS;
}
