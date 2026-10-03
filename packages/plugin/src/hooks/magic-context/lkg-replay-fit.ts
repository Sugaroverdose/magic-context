import type { ContextDatabase } from "../../features/magic-context/storage";
import { getOverflowState } from "../../features/magic-context/storage-meta-persisted";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import { estimateFinalWireInputTokens } from "./final-wire-token-estimate";
import type { MessageLike } from "./transform-operations";

/**
 * The local tokenizer is telemetry-grade and can materially undercount a new
 * provider tokenizer. Four serialized bytes per context token is an independent,
 * conservative risk budget for sending an array the transform did not just build.
 */
export const RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN = 4;

/**
 * Serialize the array message-by-message with a running byte sum, aborting as
 * soon as the sum proves the array is over the budget. A refusal then costs a
 * fraction of the full serialization and never runs the tokenizer; when the sum
 * stays under the budget the total matches a whole-array serialization up to
 * array punctuation.
 */
export function rawFallbackSerializedBytes(
    messages: readonly MessageLike[],
    abortAboveBytes: number,
): { bytes: number; aborted: boolean } | null {
    let bytes = 0;
    try {
        for (const message of messages) {
            const serialized = JSON.stringify(message);
            if (typeof serialized !== "string") return null;
            // +1 accounts for the separator between array entries.
            bytes += Buffer.byteLength(serialized) + 1;
            if (bytes > abortAboveBytes) return { bytes, aborted: true };
        }
    } catch {
        // Serialization is itself required before these messages can reach a provider.
        return null;
    }
    return { bytes: bytes + 1, aborted: false };
}

type ReplayModel = { providerID: string; modelID: string } | null | undefined;

/**
 * The context limit every last-known-good replay is admitted against: the
 * model's usable hard limit (its window minus the output reserve), else its
 * trusted context limit, else the limit the provider reported for this model.
 * Undefined when none is known. Throws when the stored limits cannot be read.
 */
export function lkgReplayLimit(args: {
    db: ContextDatabase;
    sessionId: string;
    model: ReplayModel;
    modelKey: string | null | undefined;
}): number | undefined {
    const { db, sessionId, model } = args;
    const usableHard = model
        ? resolveContextWindowGeometry(model.providerID, model.modelID, {
              db,
              sessionID: sessionId,
          })?.usableHard
        : undefined;
    if (usableHard !== undefined && usableHard > 0) return usableHard;
    const trusted = model
        ? resolveTrustedContextLimit(model.providerID, model.modelID, { db, sessionID: sessionId })
        : undefined;
    if (trusted !== undefined && trusted > 0) return trusted;
    const detected = getOverflowState(db, sessionId, args.modelKey).detectedContextLimit;
    return detected > 0 ? detected : undefined;
}

/** Where a replay candidate stands against a limit. */
export type LkgReplayMeasure =
    | { fit: "under"; tokens: number }
    | { fit: "over"; tokens: number | null; proxyTokens: number | null }
    | { fit: "unproven"; tokens: number | null };

/**
 * Measure `messages` against `limit`. Over when the four-bytes-per-token proxy or
 * a trusted token estimate exceeds the limit (the proxy runs first, so an array
 * the proxy already proves over is never tokenized); under only when the proxy is
 * under and a trusted, finite, positive estimate is at or under the limit;
 * unproven otherwise (the estimate is untrusted, unusable or failed).
 */
export function measureLkgReplay(args: {
    messages: readonly MessageLike[];
    limit: number;
    estimate: () => ReturnType<typeof estimateFinalWireInputTokens>;
}): LkgReplayMeasure {
    const proxy = rawFallbackSerializedBytes(
        args.messages,
        args.limit * RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN,
    );
    if (proxy === null) return { fit: "unproven", tokens: null };
    const proxyTokens = Math.ceil(proxy.bytes / RAW_FALLBACK_BYTES_PER_CONTEXT_TOKEN);
    if (proxy.aborted || proxyTokens > args.limit) {
        return { fit: "over", tokens: null, proxyTokens };
    }
    let estimate: ReturnType<typeof estimateFinalWireInputTokens>;
    try {
        estimate = args.estimate();
    } catch {
        return { fit: "unproven", tokens: null };
    }
    if (!estimate.trusted || !Number.isFinite(estimate.tokens) || estimate.tokens <= 0) {
        return {
            fit: "unproven",
            tokens: Number.isFinite(estimate.tokens) ? estimate.tokens : null,
        };
    }
    return estimate.tokens > args.limit
        ? { fit: "over", tokens: estimate.tokens, proxyTokens }
        : { fit: "under", tokens: estimate.tokens };
}

export type LkgReplayFit =
    | { fits: true }
    /** `detail` is the log line explaining the decline, when there is one to log. */
    | { fits: false; detail: string | null };

/**
 * Whether a last-known-good replay of `messages` may be sent in place of a failed
 * pass: it needs a known limit (`lkgReplayLimit`) and a measurement of "under"
 * (`measureLkgReplay`). Every way of not knowing declines, because a replay that
 * overflows turns a recoverable failure into a provider rejection.
 *
 * The Rust adapter's failure replay and the outer messages-transform wrapper's
 * replay both call this. A healthy frozen pass uses the same limit and
 * measurement; it differs only in serving an unproven measurement, because its
 * alternative is a cache bust rather than a refusal.
 */
export function lkgReplayFits(args: {
    db: ContextDatabase;
    sessionId: string;
    messages: MessageLike[];
    model: ReplayModel;
    modelKey: string | null | undefined;
    systemPromptTokens: number;
    agentName?: string;
    /** Token estimator; tests substitute it. */
    estimator?: typeof estimateFinalWireInputTokens;
}): LkgReplayFit {
    let limit: number | undefined;
    try {
        limit = lkgReplayLimit(args);
    } catch {
        // A limit read failure cannot admit cached bytes whose size is now unknown.
        return { fits: false, detail: null };
    }
    if (limit === undefined) return { fits: false, detail: null };
    const estimator = args.estimator ?? estimateFinalWireInputTokens;
    const measure = measureLkgReplay({
        messages: args.messages,
        limit,
        estimate: () =>
            estimator({
                messages: args.messages,
                systemPromptTokens: args.systemPromptTokens,
                providerID: args.model?.providerID,
                modelID: args.model?.modelID,
                agentName: args.agentName,
            }),
    });
    if (measure.fit === "under") return { fits: true };
    return {
        fits: false,
        detail:
            measure.fit === "over"
                ? `lkg_over_context_limit estimated=${measure.tokens ?? "skipped"} proxy_tokens=${measure.proxyTokens ?? "unavailable"} limit=${limit}`
                : `lkg_fit_untrusted estimated=${measure.tokens ?? "unavailable"} limit=${limit}`,
    };
}
