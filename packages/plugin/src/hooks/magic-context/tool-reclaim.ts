import {
    advanceToolReclaimWatermark,
    type ContextDatabase,
    getActiveTagsBySession,
    getMaxTagNumberBySession,
} from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import type { TagTarget } from "./tag-messages";

export function buildSyntheticToolReclaimOps(input: {
    db: ContextDatabase;
    sessionId: string;
    targets: Map<number, TagTarget>;
    watermark: number;
    pendingOps?: readonly PendingOp[];
}): PendingOp[] {
    const watermark = Math.max(0, input.watermark);
    if (watermark <= 0) return [];

    const realPendingTagIds = new Set((input.pendingOps ?? []).map((op) => op.tagId));
    const tags = getActiveTagsBySession(input.db, input.sessionId);
    const synthetic: PendingOp[] = [];

    for (const tag of tags) {
        if (tag.type !== "tool") continue;
        if (tag.status !== "active") continue;
        if (tag.tagNumber > watermark) continue;
        if (realPendingTagIds.has(tag.tagNumber)) continue;
        if (input.targets.get(tag.tagNumber)?.canDrop?.() !== true) continue;
        synthetic.push({
            id: 0,
            sessionId: input.sessionId,
            tagId: tag.tagNumber,
            operation: "drop",
            queuedAt: 0,
        });
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
