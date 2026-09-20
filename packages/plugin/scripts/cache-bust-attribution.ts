export type CacheBustDivergenceClass =
    | "no_mc_pass_row"
    | "system_row_shift"
    | "accounted_hard_model_change"
    | "accounted_hard_system_hash"
    | "accounted_hard_epoch"
    | "accounted_hard_pressure_refold"
    | "accounted_hard_marker_drain"
    | "accounted_hard_fold"
    | "accounted_soft_m1_execute"
    | "accounted_ctx_reduce"
    | "accounted_ctx_flush"
    | "accounted_force_band"
    | "accounted_drop_applied"
    | "accounted_provider_system_prompt_change"
    | "usage_missing"
    | "provider_full_miss"
    | "unaccounted_defer_pass"
    | "unaccounted_double_bust"
    | "unaccounted_tail_rewrite"
    | "unaccounted_rewrite";

export interface AnalyzedCacheRequest {
    session: string;
    at: string;
    timestampMs: number;
    verdict: "BASE" | "BUST" | "STABLE" | "LATENCY" | "UNMETERED";
    rewrittenTokens?: number;
    divergenceClass?: CacheBustDivergenceClass;
    firstDivergence: string;
    analyzerCmd: string;
}

export interface CacheBustSessionAnalysis {
    requests: AnalyzedCacheRequest[];
    highWaterMarkMs: number | null;
    directory?: string;
}

export interface CacheBustDecisionAttribution {
    timestampMs: number;
    requestObservedAtMs?: number;
    messageId?: string;
    decision: string;
    canonicalDecision?: string;
    deferReason?: string | null;
    materialized: boolean;
    materializeReason: string | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    flush: boolean;
    source: string;
}

export interface CacheBustAttributionInput {
    divergenceIndex: number;
    previousMessageCount: number;
    previousBustDivergenceIndex?: number;
    previousProvider?: string;
    currentProvider?: string;
    firstDivergenceRole?: string;
    firstDivergenceSize?: number;
    rewrittenTokens?: number;
    cacheCreationTokens?: number;
    promptTokens?: number;
    contentEvidence?: string;
    compactionSeam?: boolean;
    inheritedFold?: boolean;
    /** Provider cache-read component, excluding Anthropic direct input tokens. */
    providerComparableRead?: number;
    /** Direct/uncached input component of the current request. */
    directInput?: number;
    /** Total provider meter on the preceding request. */
    previousTotal?: number;
    previousModel?: string;
    currentModel?: string;
    decision?: CacheBustDecisionAttribution;
}

export interface CacheBustRule {
    divergenceClass: CacheBustDivergenceClass;
    accounted: boolean;
    rule: string;
}

export const CACHE_BUST_RULE_TABLE: readonly CacheBustRule[] = [
    {
        divergenceClass: "system_row_shift",
        accounted: true,
        rule: "message[0]/system divergence rewrites less than 5% of the prompt",
    },
    {
        divergenceClass: "no_mc_pass_row",
        accounted: false,
        rule: "no MC pass record in [request - 30 s, request + 5 s]",
    },
    {
        divergenceClass: "accounted_ctx_flush",
        accounted: true,
        rule: "matched pass records an explicit /ctx-flush",
    },
    {
        divergenceClass: "accounted_force_band",
        accounted: true,
        rule: "matched pass records a forced emergency drop batch",
    },
    {
        divergenceClass: "accounted_hard_marker_drain",
        accounted: true,
        rule: "matched HARD/m0 pass records marker_drain or a compaction-marker seam",
    },
    {
        divergenceClass: "accounted_hard_model_change",
        accounted: true,
        rule: "matched HARD/m0 pass records materialize_reason=model_change",
    },
    {
        divergenceClass: "accounted_hard_system_hash",
        accounted: true,
        rule: "matched HARD/m0 pass records system_hash, or a large system-prompt replacement",
    },
    {
        divergenceClass: "accounted_hard_epoch",
        accounted: true,
        rule: "matched HARD/m0 pass records a project, render, or session epoch change",
    },
    {
        divergenceClass: "accounted_hard_pressure_refold",
        accounted: true,
        rule: "matched HARD/m0 pass records materialize_reason=pressure_refold",
    },
    {
        divergenceClass: "accounted_hard_fold",
        accounted: true,
        rule: "matched pass records another materialized HARD/m0 fold; tiny mid-history defer/first_render seams are excluded",
    },
    {
        divergenceClass: "accounted_ctx_reduce",
        accounted: true,
        rule: "matched pass applies drops at an agent ctx_reduce landing",
    },
    {
        divergenceClass: "accounted_drop_applied",
        accounted: true,
        rule: "matched pass records applied drops",
    },
    {
        divergenceClass: "accounted_soft_m1_execute",
        accounted: true,
        rule: "matched canonical execute pass refreshes m1",
    },
    {
        divergenceClass: "usage_missing",
        accounted: true,
        rule: "provider cache read and direct input are both 0 or usage is absent; the pass is in flight/unmetered and never becomes a bust baseline",
    },
    {
        divergenceClass: "provider_full_miss",
        accounted: true,
        rule: "provider cache read is exactly 0 with prevTotal ≥ 10,000; ordinary short reads stay unaccounted; show wire model prev → cur when it changes",
    },
    {
        divergenceClass: "unaccounted_defer_pass",
        accounted: false,
        rule: "matched canonical defer pass, including a tiny mid-history first_render seam, diverges",
    },
    {
        divergenceClass: "accounted_provider_system_prompt_change",
        accounted: true,
        rule: "matched non-defer pass has a user-visible provider change",
    },
    {
        divergenceClass: "unaccounted_double_bust",
        accounted: false,
        rule: "matched otherwise-unattributed pass repeats the previous divergence offset",
    },
    {
        divergenceClass: "unaccounted_tail_rewrite",
        accounted: false,
        rule: "matched otherwise-unattributed pass rewrites the previous request tail",
    },
    {
        divergenceClass: "unaccounted_rewrite",
        accounted: false,
        rule: "matched pass has no accounted attribution",
    },
] as const;

const ACCOUNTED_CLASSES = new Set(
    CACHE_BUST_RULE_TABLE.filter((row) => row.accounted).map((row) => row.divergenceClass),
);
const EPOCH_REASONS = new Set(["project_memory_epoch", "epoch_change", "compartment_render_epoch"]);

export function isUnaccountedCacheBustClass(divergenceClass: string): boolean {
    return !ACCOUNTED_CLASSES.has(divergenceClass as CacheBustDivergenceClass);
}

export function nearestCacheBustDecision(
    decisions: readonly CacheBustDecisionAttribution[],
    requestTimestampMs: number,
    messageId?: string,
): CacheBustDecisionAttribution | undefined {
    const timeDelta = (decision: CacheBustDecisionAttribution): number =>
        (decision.requestObservedAtMs ?? decision.timestampMs) - requestTimestampMs;
    const withinJoinWindow = (decision: CacheBustDecisionAttribution): boolean => {
        const delta = timeDelta(decision);
        return delta >= -30_000 && delta <= 5_000;
    };
    const byDistance = (
        left: CacheBustDecisionAttribution,
        right: CacheBustDecisionAttribution,
    ): number => Math.abs(timeDelta(left)) - Math.abs(timeDelta(right));
    const exact = messageId
        ? decisions
              .filter((decision) => decision.messageId === messageId && withinJoinWindow(decision))
              .sort(byDistance)[0]
        : undefined;
    if (exact) return exact;
    return decisions.filter(withinJoinWindow).sort(byDistance)[0];
}

export function classifyCacheBust(input: CacheBustAttributionInput): CacheBustDivergenceClass {
    const isSystemRow = input.divergenceIndex === 0 && input.firstDivergenceRole === "system";
    const rewrittenRatio =
        input.rewrittenTokens !== undefined && input.promptTokens && input.promptTokens > 0
            ? input.rewrittenTokens / input.promptTokens
            : Number.POSITIVE_INFINITY;
    const creationRatio =
        input.cacheCreationTokens !== undefined && input.promptTokens && input.promptTokens > 0
            ? input.cacheCreationTokens / input.promptTokens
            : 0;
    if (isSystemRow && rewrittenRatio < 0.05 && creationRatio < 0.05) return "system_row_shift";

    const decision = input.decision;
    if (!decision) return "no_mc_pass_row";

    const canonicalDecision = (decision.canonicalDecision ?? decision.decision).toLowerCase();
    const materializeReason = decision.materializeReason?.toLowerCase() ?? null;
    const isTinyFirstRenderDefer =
        materializeReason === "first_render" &&
        canonicalDecision === "defer" &&
        !input.inheritedFold &&
        input.firstDivergenceSize !== undefined &&
        input.firstDivergenceSize <= 256 &&
        input.divergenceIndex < Math.max(0, input.previousMessageCount - 2);
    const previousTotal = input.previousTotal ?? input.promptTokens;
    const usageMissing = input.providerComparableRead === 0 && input.directInput === 0;
    const providerFullMiss =
        input.providerComparableRead === 0 &&
        previousTotal !== undefined &&
        previousTotal >= 10_000;
    if (decision.flush || materializeReason === "explicit_flush") return "accounted_ctx_flush";
    if (decision.emergency && decision.droppedCount > 0) return "accounted_force_band";
    if (isTinyFirstRenderDefer && (usageMissing || providerFullMiss)) {
        return usageMissing ? "usage_missing" : "provider_full_miss";
    }
    if (isTinyFirstRenderDefer) return "unaccounted_defer_pass";
    // A scheduler-only defer does not show that a compaction actually ran. Nearby
    // old marker text or a changed billing header cannot prove that mutation.
    if (decision.source === "transform scheduler log" && canonicalDecision === "defer") {
        if (usageMissing) return "usage_missing";
        if (providerFullMiss) return "provider_full_miss";
        return "unaccounted_defer_pass";
    }
    if (
        materializeReason === "marker_drain" ||
        input.compactionSeam ||
        (input.contentEvidence ?? "").includes("[Compacted by magic-context")
    ) {
        return "accounted_hard_marker_drain";
    }
    if (usageMissing) return "usage_missing";
    if (decision.materialized) {
        if (materializeReason === "model_change") return "accounted_hard_model_change";
        if (materializeReason === "system_hash") return "accounted_hard_system_hash";
        if (materializeReason && EPOCH_REASONS.has(materializeReason)) {
            return "accounted_hard_epoch";
        }
        if (materializeReason === "pressure_refold") {
            return "accounted_hard_pressure_refold";
        }
        return "accounted_hard_fold";
    }

    if (decision.droppedCount > 0 || decision.droppedTokens > 0) {
        return /\bctx_reduce\b/.test(input.contentEvidence ?? "")
            ? "accounted_ctx_reduce"
            : "accounted_drop_applied";
    }
    if (canonicalDecision === "execute") return "accounted_soft_m1_execute";
    if (isSystemRow) return "accounted_hard_system_hash";
    if (usageMissing) return "usage_missing";
    if (providerFullMiss) return "provider_full_miss";
    if (canonicalDecision === "defer") return "unaccounted_defer_pass";
    if (
        input.previousProvider &&
        input.currentProvider &&
        input.previousProvider !== input.currentProvider
    ) {
        return "accounted_provider_system_prompt_change";
    }
    if (
        input.previousBustDivergenceIndex !== undefined &&
        input.previousBustDivergenceIndex === input.divergenceIndex
    ) {
        return "unaccounted_double_bust";
    }
    if (input.divergenceIndex >= Math.max(0, input.previousMessageCount - 2)) {
        return "unaccounted_tail_rewrite";
    }
    return "unaccounted_rewrite";
}
