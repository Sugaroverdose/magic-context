import { sessionLog } from "../../shared/logger";
import type { MessageLike } from "./transform-operations";

/**
 * What a Rust-mode adapter exposes to code outside it that can serve its
 * last-known-good (LKG) slot. The outer messages-transform wrapper replays the
 * slot when the adapter's pass throws; that replay is provider-visible, so the
 * adapter must enter its frozen representation exactly as if it had served the
 * replay itself, and the wrapper must admit the replay the way the adapter would.
 */
export interface RustLkgReplayParticipant {
    /** True when this adapter has run (and so owns state for) the session. */
    ownsSession(sessionId: string): boolean;
    /** Enter or keep the freeze after an LKG replay served outside the adapter. */
    enterFreezeFromExternalServe(sessionId: string, inputCount: number): void;
    /** The adapter's own context-fit admission for an LKG replay of `messages`. */
    replayFits(sessionId: string, messages: MessageLike[]): boolean;
    /**
     * Remove from a replayed array the thinking blocks this session has already
     * stopped sending (the ids saved in its binding-mismatch set), exactly as the
     * adapter's own replay does: same database, and the same provider (resolved
     * from the pass's input messages) deciding how a block is removed.
     */
    stripPersistedReasoning(
        sessionId: string,
        messages: MessageLike[],
        inputMessages: MessageLike[],
    ): void;
}

const participants = new Set<RustLkgReplayParticipant>();

/** Register an adapter. Returns the matching unregister function. */
export function registerRustLkgReplayParticipant(
    participant: RustLkgReplayParticipant,
): () => void {
    participants.add(participant);
    return () => {
        participants.delete(participant);
    };
}

/**
 * The adapter that serves this session in Rust mode, or undefined in TypeScript
 * mode. An adapter that already holds state for the session owns it. With no
 * owner, a single registered adapter is the only one that can run the session
 * (the wrapper may have refused before the adapter ever saw it in this process);
 * with several and no owner the session is not attributed.
 */
export function resolveRustLkgReplayParticipant(
    sessionId: string,
): RustLkgReplayParticipant | undefined {
    let only: RustLkgReplayParticipant | undefined;
    for (const participant of participants) {
        if (participant.ownsSession(sessionId)) return participant;
        only = participants.size === 1 ? participant : undefined;
    }
    return only;
}

/**
 * Record that the wrapper just served the LKG slot for this session. Synchronous,
 * so the adapter's next pass sees the freeze with no pending signal in between.
 * A no-op in TypeScript mode.
 */
export function noteExternalLkgReplay(sessionId: string, inputCount: number): void {
    const participant = resolveRustLkgReplayParticipant(sessionId);
    if (!participant) return;
    participant.enterFreezeFromExternalServe(sessionId, inputCount);
    sessionLog(sessionId, "lkg_external_replay_froze_rust_adapter");
}

export function resetRustLkgReplayParticipantsForTest(): void {
    participants.clear();
}
