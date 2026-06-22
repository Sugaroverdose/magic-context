import type { PluginContext } from "../../../plugin/types";
import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import {
    buildPrimerClusters,
    clusterEligibleForPromotion,
    PRIMER_CLUSTER_THRESHOLD,
    PRIMER_MIN_SPAN_DAYS,
    PRIMER_PROMOTION_THRESHOLD,
    summarizePrimerCluster,
} from "../primer-clustering";
import { embedBatchForProject } from "../project-embedding-registry";
import {
    createPrimer,
    getActivePrimers,
    getPrimerCandidatesForPromotion,
    PRIMER_CANDIDATE_TTL_MS,
    pruneExpiredPrimerCandidates,
    updatePrimerCandidateEmbedding,
    updatePrimerSupport,
} from "../storage-primers";
import { peekLeaseHolderAndExpiry, renewLease } from "./lease";

export interface PromotePrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    promotionThreshold?: number;
    ensureProjectRegistered?: (directory: string, db: Database) => Promise<void> | void;
}

export interface PromotePrimersResult {
    promoted: number;
    updated: number;
    candidates: number;
    pruned: number;
}

function canonicalQuestionFromCluster(
    candidates: { question: string; sourceMessageTime: number; id: number }[],
): string {
    const sorted = candidates
        .slice()
        .sort((a, b) => a.sourceMessageTime - b.sourceMessageTime || a.id - b.id);
    const first = sorted[0]?.question.trim() ?? "";
    if (!first) return "How does this project subsystem work?";
    return first.endsWith("?") ? first : `${first}?`;
}

async function embedMissingCandidates(args: PromotePrimersArgs): Promise<void> {
    await args.ensureProjectRegistered?.(args.sessionDirectory, args.db);
    const candidates = getPrimerCandidatesForPromotion(args.db, args.projectIdentity).filter(
        (candidate) => !candidate.questionEmbedding || !candidate.questionEmbeddingModelId,
    );
    if (candidates.length === 0) return;
    const batch = await embedBatchForProject(
        args.projectIdentity,
        candidates.map((candidate) => candidate.question),
        undefined,
        "passage",
    );
    if (!batch) return;
    for (let i = 0; i < candidates.length; i += 1) {
        const vector = batch.vectors[i];
        if (!vector) continue;
        updatePrimerCandidateEmbedding(args.db, candidates[i].id, vector, batch.modelId);
    }
}

export async function promotePrimers(args: PromotePrimersArgs): Promise<PromotePrimersResult> {
    const result: PromotePrimersResult = { promoted: 0, updated: 0, candidates: 0, pruned: 0 };

    result.pruned = pruneExpiredPrimerCandidates(args.db, Date.now(), PRIMER_CANDIDATE_TTL_MS);
    if (result.pruned > 0) {
        log(`[dreamer] primers: decayed ${result.pruned} expired candidate(s)`);
    }

    await embedMissingCandidates(args).catch((error) => {
        log(
            `[dreamer] primers: embedding unavailable; falling back to normalized-text clusters: ${error}`,
        );
    });

    const candidates = getPrimerCandidatesForPromotion(args.db, args.projectIdentity);
    result.candidates = candidates.length;
    if (candidates.length === 0) return result;

    const primers = getActivePrimers(args.db, args.projectIdentity);
    const clusters = buildPrimerClusters({
        candidates,
        activePrimers: primers,
        threshold: PRIMER_CLUSTER_THRESHOLD,
    });

    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId, args.leaseKey)) {
                log("[dreamer] primers: lease renewal failed during promote-primers");
            }
        } catch {
            // The commit-time holder check below is authoritative.
        }
    }, 60_000);

    try {
        let leaseLost = false;
        args.db.transaction(() => {
            if (!peekLeaseHolderAndExpiry(args.db, args.holderId, args.leaseKey)) {
                leaseLost = true;
                return;
            }
            for (const cluster of clusters) {
                if (cluster.candidates.length === 0) continue;
                const summary = summarizePrimerCluster(cluster);
                if (cluster.primer) {
                    updatePrimerSupport(args.db, {
                        primerId: cluster.primer.id,
                        questionEmbedding: summary.centroid,
                        questionEmbeddingModelId: summary.modelId,
                        totalSupport: summary.support,
                        lastObservedAt: summary.lastObservedAt,
                        sourceCandidateIds: summary.sourceCandidateIds,
                    });
                    result.updated += 1;
                    continue;
                }
                if (
                    !clusterEligibleForPromotion(
                        summary,
                        args.promotionThreshold ?? PRIMER_PROMOTION_THRESHOLD,
                        PRIMER_MIN_SPAN_DAYS,
                    )
                ) {
                    continue;
                }
                createPrimer(args.db, {
                    projectPath: args.projectIdentity,
                    question: canonicalQuestionFromCluster(summary.candidates),
                    questionEmbedding: summary.centroid,
                    questionEmbeddingModelId: summary.modelId,
                    totalSupport: summary.support,
                    lastObservedAt: summary.lastObservedAt,
                    sourceCandidateIds: summary.sourceCandidateIds,
                });
                result.promoted += 1;
            }
        })();
        if (leaseLost) throw new Error("Dream lease lost during promote-primers commit");
        log(
            `[dreamer] primers: candidates=${result.candidates} promoted=${result.promoted} updated=${result.updated}`,
        );
        return result;
    } finally {
        clearInterval(leaseInterval);
    }
}
