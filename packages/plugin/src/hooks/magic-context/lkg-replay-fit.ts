import type { ContextDatabase } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { resolveTrustedContextLimit } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import type { MessageLike } from "./transform-operations";

export type LkgReplayFit =
    | { fits: true }
    /** `detail` is the log line explaining the decline, when there is one to log. */
    | { fits: false; detail: string | null };

/**
 * Whether a last-known-good replay of `messages` may be sent: it needs a known,
 * positive context limit (the trusted limit for the model, else the
 * provider-detected one) and a trusted, finite, positive token estimate at or
 * under that limit. Every way of not knowing declines, because a replay that
 * overflows turns a recoverable failure into a provider rejection.
 *
 * The Rust adapter and the outer messages-transform wrapper both call this, so a
 * replay the adapter would refuse is not served by the wrapper instead.
 */
export function lkgReplayFits(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    model: { providerID: string; modelID: string } | null | undefined;
    modelKey: string | null | undefined;
    systemPromptTokens: number;
    agentName?: string;
}): LkgReplayFit {
    const { db, sessionId, model } = args;
    const trustedLimit = model
        ? resolveTrustedContextLimit(model.providerID, model.modelID, {
              db,
              sessionID: sessionId,
          })
        : undefined;
    let detectedLimit = 0;
    try {
        detectedLimit = getOverflowState(db, sessionId, args.modelKey).detectedContextLimit;
    } catch {
        // A limit read failure cannot admit cached bytes whose size is now unknown.
        return { fits: false, detail: null };
    }
    const limit = trustedLimit ?? (detectedLimit > 0 ? detectedLimit : undefined);
    if (limit === undefined || limit <= 0) return { fits: false, detail: null };
    try {
        const estimate = estimateFinalWireInputTokens({
            messages: args.messages,
            systemPromptTokens: args.systemPromptTokens,
            providerID: model?.providerID,
            modelID: model?.modelID,
            agentName: args.agentName,
        });
        if (
            !estimate.trusted ||
            !Number.isFinite(estimate.tokens) ||
            estimate.tokens <= 0 ||
            estimate.tokens > limit
        ) {
            return {
                fits: false,
                detail: `${!estimate.trusted ? "lkg_fit_untrusted" : "lkg_over_context_limit"} estimated=${estimate.tokens} limit=${limit}`,
            };
        }
    } catch {
        return { fits: false, detail: null };
    }
    return { fits: true };
}
