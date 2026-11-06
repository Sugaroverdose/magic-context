import {
    AGE_RECLAIM_MIN_TOKENS,
    advanceToolReclaimWatermark,
    type ContextDatabase,
    getActiveToolTagsForAgeReclaim,
    getMaxTagNumberBySession,
} from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";

/** Points of headroom kept between the sweeper's stop line and the execute
 * band: the sweep stops once projected usage reaches threshold − 15pp, so a
 * session oscillates below the band instead of being emptied in one bite. */
export const AUTO_RECLAIM_STOP_HEADROOM_PP = 15;

export interface SweeperBudget {
    currentUsagePercentage: number;
    executeThresholdPercentage: number;
    usableContextTokens: number;
}

/** Token mass the sweeper must reclaim to bring usage down to the stop line;
 * zero or negative when usage already sits below it. */
export function sweeperNeededTokens(budget: SweeperBudget): number {
    const stopPercentage = Math.max(
        10,
        budget.executeThresholdPercentage - AUTO_RECLAIM_STOP_HEADROOM_PP,
    );
    return ((budget.currentUsagePercentage - stopPercentage) / 100) * budget.usableContextTokens;
}

export function buildSyntheticToolReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    watermark: number;
    pendingOps?: readonly PendingOp[];
    /** Stop-line budget (FPE carrier law): select oldest-first until the
     * projected usage reaches threshold − 15pp, then stop. Unknown-token tags
     * ride the sweep but count zero toward the budget. */
    budget?: SweeperBudget;
}): PendingOp[] {
    const watermark = Math.max(0, input.watermark);
    if (watermark <= 0) return [];

    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    // Storage-level candidate selection removes the newest ctx_reduce exemplars
    // before this lane applies its watermark and value-floor checks.
    const tags = getActiveToolTagsForAgeReclaim(input.db, input.sessionId);
    const newestTodowriteTag = tags.reduce<number | null>(
        (newest, tag) =>
            tag.toolName === "todowrite" && (newest === null || tag.tagNumber > newest)
                ? tag.tagNumber
                : newest,
        null,
    );
    const synthetic: PendingOp[] = [];
    const neededTokens = input.budget ? sweeperNeededTokens(input.budget) : Infinity;
    if (neededTokens <= 0) return synthetic;
    let selectedTokens = 0;

    for (const tag of tags) {
        if (tag.tagNumber > watermark) continue;
        if (tag.reclaimableTokens !== null && tag.reclaimableTokens < AGE_RECLAIM_MIN_TOKENS) {
            continue;
        }
        if (tag.tagNumber === newestTodowriteTag) continue;
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
        selectedTokens += tag.reclaimableTokens ?? 0;
        if (selectedTokens >= neededTokens) break;
    }

    return synthetic;
}

export function advanceToolReclaimWatermarkToCurrentMax(
    db: ContextDatabase,
    sessionId: string,
): number {
    const maxTagNumber = getMaxTagNumberBySession(db, sessionId);
    advanceToolReclaimWatermark(db, sessionId, maxTagNumber);
    return maxTagNumber;
}
