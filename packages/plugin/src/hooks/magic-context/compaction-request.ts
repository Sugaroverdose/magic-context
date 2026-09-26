import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { getSlot } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

/**
 * Recognises the request OpenCode 1 builds for its own native compaction
 * (`/compact`, or automatic compaction on overflow), so the hooks it runs through
 * are not mistaken for an ordinary turn of the session.
 *
 * OpenCode 1.18 `SessionCompaction.process` (packages/opencode/src/session/compaction.ts)
 * builds that request through this session's plugin hooks in a fixed order:
 *   1. `experimental.session.compacting` with `{ sessionID }` (compaction.ts:373-377);
 *   2. `experimental.chat.messages.transform` with an empty input on the history it
 *      will summarise (compaction.ts:378-379);
 *   3. the compaction agent's LLM call, whose request preparation runs
 *      `experimental.chat.system.transform` with `{ sessionID, model }` and the
 *      compaction agent's prompt (session/llm/request.ts:68-72), once per attempt.
 * Neither transform input names the agent, so the `compacting` hook is the only
 * signal that ties the next two hook calls to the compaction.
 *
 * An ordinary turn runs the messages transform before the system transform
 * (session/prompt.ts:1255 then the processor at :1272). So the first messages
 * transform after the compaction's own one belongs to a real turn and ends the
 * window; every system transform inside the window belongs to the compaction
 * request, including retries of its LLM call.
 */
interface CompactionRequestState {
    /** The compaction request's messages transform has not run yet. */
    messagesPending: boolean;
}

const MAX_TRACKED_SESSIONS = 1_000;
const compactionRequests = new BoundedSessionMap<CompactionRequestState>(MAX_TRACKED_SESSIONS);

/** Called from `experimental.session.compacting`: a compaction request is being built. */
export function markCompactionRequest(sessionId: string): void {
    compactionRequests.set(sessionId, { messagesPending: true });
}

/**
 * Called once per messages transform. Returns true when this transform is the
 * compaction request's own; a later messages transform is a real turn and closes
 * the window, so the system transform that follows it is treated normally.
 */
export function takeCompactionMessagesTransform(sessionId: string): boolean {
    const state = compactionRequests.get(sessionId);
    if (!state) return false;
    if (state.messagesPending) {
        state.messagesPending = false;
        return true;
    }
    compactionRequests.delete(sessionId);
    return false;
}

/** True while a system transform for this session belongs to a compaction request. */
export function isCompactionSystemRequest(sessionId: string): boolean {
    return compactionRequests.get(sessionId) !== undefined;
}

/**
 * Forget a deleted session. Nothing else closes the window early: a prompt the
 * user queues while the compaction runs can reach `chat.message` before a retry of
 * the compaction's LLM call, and that retry must still be recognised.
 */
export function clearCompactionRequest(sessionId: string): void {
    compactionRequests.delete(sessionId);
}

function messageIdOf(message: MessageLike): string | undefined {
    const id = (message.info as { id?: unknown } | undefined)?.id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * The messages to hand OpenCode's compaction agent, built without running the
 * transform: running it would persist m[0]/m[1], cache state, tags and drops
 * from a request that is not a turn of the session.
 *
 * The source is the session's last-known-good render (the array Magic Context
 * served on its last successful pass, up to that pass's last user message), so
 * the summary covers the same m[0]/m[1] history and the same rendered rows the
 * model last saw. It is narrowed to what OpenCode asked to summarise:
 *   - Magic Context's own rows (m[0], m[1] and other synthetic rows, whose ids
 *     were never host input) are kept;
 *   - a host row the render already covered is kept, in its rendered form, only
 *     if the compaction request still carries it;
 *   - host rows newer than that render (the reply to its last user message and
 *     anything after) are appended as OpenCode passed them.
 * A host row the render covered but left out (folded into history or dropped)
 * stays out.
 *
 * Returns null when there is no usable render, or when it shares no row with the
 * request; the caller then runs the ordinary transform.
 */
export function renderCompactionRequestFromLkg(
    sessionId: string,
    messages: readonly MessageLike[],
): MessageLike[] | null {
    const slot = getSlot(sessionId);
    if (!slot) return null;
    let rendered: MessageLike[];
    try {
        const parsed = JSON.parse(slot.jsonPrefix) as unknown;
        if (!Array.isArray(parsed)) return null;
        rendered = parsed as MessageLike[];
    } catch {
        return null;
    }
    const coveredIds = new Set(slot.inputIdSeq);
    const requestedIds = new Set<string>();
    for (const message of messages) {
        const id = messageIdOf(message);
        if (id) requestedIds.add(id);
    }
    let sharesRow = false;
    for (const id of requestedIds) {
        if (coveredIds.has(id)) {
            sharesRow = true;
            break;
        }
    }
    if (!sharesRow) return null;

    const result: MessageLike[] = [];
    for (const message of rendered) {
        const id = messageIdOf(message);
        if (id === undefined || !coveredIds.has(id) || requestedIds.has(id)) {
            result.push(message);
        }
    }
    for (const message of messages) {
        const id = messageIdOf(message);
        if (id === undefined || !coveredIds.has(id)) result.push(message);
    }
    return result;
}

export function resetCompactionRequestsForTest(): void {
    compactionRequests.clear();
}
