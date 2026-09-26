import { BoundedSessionMap } from "../../shared/bounded-session-map";
import type { MessageLike } from "./transform-operations";

/**
 * Recognises the request OpenCode 1 builds for its own native compaction
 * (`/compact`, or automatic compaction on overflow), so the hooks it runs through
 * are not mistaken for an ordinary turn of the session.
 *
 * OpenCode 1.18 runs `experimental.session.compacting` with `{ sessionID }` and
 * then builds the compaction request through this session's system and messages
 * transforms. The order of those two differs between builds:
 *   - the shipped 1.18.30 binary (`SessionCompaction.process` in its bundle) runs
 *     compacting, then `experimental.chat.system.transform` once with the
 *     compaction agent's prompt, then `experimental.chat.messages.transform`
 *     on the history it will summarise. An ordinary turn likewise runs the
 *     system transform, then the messages transform;
 *   - the v1.18.30 source tag (packages/opencode/src/session/compaction.ts:373-379)
 *     runs compacting, then the messages transform, then the system transform
 *     inside each attempt of the compaction agent's LLM call
 *     (session/llm/request.ts:68-72). An ordinary turn runs the messages transform
 *     (session/prompt.ts:1255) before its LLM call's system transform.
 * The system transform's input never names the agent, so the `compacting` hook is
 * the only signal that ties the following transforms to the compaction.
 *
 * The window opened by `compacting` therefore holds the compaction request's one
 * messages transform and every system transform that belongs to it. It closes at
 * the first hook call that can only be a real turn:
 *   - a second messages transform (either order);
 *   - a system transform after the compaction's messages transform, when the
 *     compaction's own system transform already ran before it (shipped order).
 *     In the source-tag order a system transform after the messages transform is
 *     the compaction's LLM call, including its retries, and stays in the window.
 */
interface CompactionRequestState {
    systemSeen: boolean;
    messagesSeen: boolean;
    /** The compaction's system transform ran before its messages transform. */
    systemBeforeMessages: boolean;
}

const MAX_TRACKED_SESSIONS = 1_000;
const compactionRequests = new BoundedSessionMap<CompactionRequestState>(MAX_TRACKED_SESSIONS);

/** Called from `experimental.session.compacting`: a compaction request is being built. */
export function markCompactionRequest(sessionId: string): void {
    compactionRequests.set(sessionId, {
        systemSeen: false,
        messagesSeen: false,
        systemBeforeMessages: false,
    });
}

/**
 * Called once per messages transform. Returns true when this transform is the
 * compaction request's own; a later one is a real turn and closes the window.
 */
export function takeCompactionMessagesTransform(sessionId: string): boolean {
    const state = compactionRequests.get(sessionId);
    if (!state) return false;
    if (!state.messagesSeen) {
        state.messagesSeen = true;
        state.systemBeforeMessages = state.systemSeen;
        return true;
    }
    compactionRequests.delete(sessionId);
    return false;
}

/**
 * Called once per system transform. Returns true when this transform belongs to
 * the compaction request; a real turn's closes the window.
 */
export function takeCompactionSystemTransform(sessionId: string): boolean {
    const state = compactionRequests.get(sessionId);
    if (!state) return false;
    if (state.messagesSeen && state.systemBeforeMessages) {
        compactionRequests.delete(sessionId);
        return false;
    }
    state.systemSeen = true;
    return true;
}

/**
 * Forget a deleted session. Nothing else closes the window early: a prompt the
 * user queues while the compaction runs can reach `chat.message` before a retry of
 * the compaction's LLM call, and that retry must still be recognised.
 */
export function clearCompactionRequest(sessionId: string): void {
    compactionRequests.delete(sessionId);
    lastServedRenders.delete(sessionId);
}

/**
 * The array Magic Context served on a session's last successful pass, and the
 * ids of the host rows that pass was given. Kept by reference: OpenCode builds
 * fresh message objects for every request, so nothing rewrites these after the
 * pass returns, and holding them costs no copy on the hot path. The last-known-
 * good replay snapshot is not a substitute: it declines to capture once Magic
 * Context's own compaction marker rows are on the wire, which is exactly when a
 * session has history worth summarising.
 */
interface ServedRender {
    inputIds: ReadonlySet<string>;
    messages: readonly MessageLike[];
}

const MAX_REMEMBERED_RENDERS = 64;
const lastServedRenders = new BoundedSessionMap<ServedRender>(MAX_REMEMBERED_RENDERS);

function messageIdOf(message: MessageLike): string | undefined {
    const id = (message.info as { id?: unknown } | undefined)?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** Called after a successful real pass with the host row ids it was given and what it served. */
export function rememberServedRender(
    sessionId: string,
    inputIds: ReadonlySet<string>,
    served: readonly MessageLike[],
): void {
    lastServedRenders.set(sessionId, { inputIds, messages: [...served] });
}

export function messageIdsOf(messages: readonly MessageLike[]): Set<string> {
    const ids = new Set<string>();
    for (const message of messages) {
        const id = messageIdOf(message);
        if (id) ids.add(id);
    }
    return ids;
}

/**
 * The messages to hand OpenCode's compaction agent, built without running the
 * transform: running it would persist m[0]/m[1], cache state, tags and drops
 * from a request that is not a turn of the session.
 *
 * The source is the array served on the session's last real pass, so the summary
 * covers the same m[0]/m[1] history and the same rendered rows the model last
 * saw. It is narrowed to what OpenCode asked to summarise:
 *   - rows Magic Context added itself (m[0], m[1], its compaction marker and
 *     other injected rows, none of which were host input to that pass) are kept;
 *   - a host row that pass was given is kept, in its rendered form, only if the
 *     compaction request still carries it;
 *   - host rows newer than that pass are appended as OpenCode passed them.
 * A host row that pass was given but left out (folded into history or dropped)
 * stays out.
 *
 * Returns null when no pass has been served in this process, or when the last
 * one shares no row with the request; the caller then runs the ordinary
 * transform.
 */
export function renderCompactionRequest(
    sessionId: string,
    messages: readonly MessageLike[],
): MessageLike[] | null {
    const render = lastServedRenders.get(sessionId);
    if (!render) return null;
    const coveredIds = render.inputIds;
    const requestedIds = messageIdsOf(messages);
    let sharesRow = false;
    for (const id of requestedIds) {
        if (coveredIds.has(id)) {
            sharesRow = true;
            break;
        }
    }
    if (!sharesRow) return null;

    const result: MessageLike[] = [];
    const servedIds = new Set<string>();
    for (const message of render.messages) {
        const id = messageIdOf(message);
        if (id === undefined || !coveredIds.has(id) || requestedIds.has(id)) {
            result.push(message);
            if (id) servedIds.add(id);
        }
    }
    for (const message of messages) {
        const id = messageIdOf(message);
        if (id === undefined || (!coveredIds.has(id) && !servedIds.has(id))) {
            result.push(message);
        }
    }
    // A copy, so nothing OpenCode does with the compaction request can reach the
    // remembered render.
    return structuredClone(result);
}

export function resetCompactionRequestsForTest(): void {
    compactionRequests.clear();
    lastServedRenders.clear();
}
