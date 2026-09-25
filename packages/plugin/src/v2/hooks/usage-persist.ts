import { type ContextDatabase, updateSessionMeta } from "../../features/magic-context/storage";
import type { TransformDeps } from "../../hooks/magic-context/transform";
import { sessionLog } from "../../shared/logger";
import { refusesBeforeProvider } from "./provider-admission";
import { type UsageReading, usageReadingMatchesDraft } from "./usage-reading";

export interface PersistV2UsageReadingArgs {
    db: ContextDatabase;
    sessionID: string;
    draftModel: { providerID: string; id: string };
    reading: UsageReading;
    /** Raw (unreserved) context window of the draft model, for provider admission. */
    rawContextLimit?: number;
    /** A host compaction landed after the reply that produced this reading. */
    hostCompactionReducedUsage: boolean;
    contextUsageMap: TransformDeps["contextUsageMap"];
}

/**
 * Record the usage OpenCode stored for the latest completed reply and decide
 * whether the next request must be refused before it reaches the provider.
 * Returns true when the request is unsafe to send.
 *
 * The reading is the prompt size of a request the provider accepted, so it is
 * real pressure at any size. It is never compared with the configured window:
 * that window can be smaller than what the model actually serves, and a reading
 * past it is real overflow of the user's limit for the scheduler to handle.
 */
export function persistV2UsageReading(args: PersistV2UsageReadingArgs): boolean {
    const { db, sessionID, draftModel, reading } = args;
    const draftModelKey = `${draftModel.providerID}/${draftModel.id}`;
    const readingMatchesDraft = usageReadingMatchesDraft(reading, draftModel);
    const unsafe = refusesBeforeProvider({
        inputTokens: reading.inputTokens,
        rawContextLimit: args.rawContextLimit,
        hostCompactionReducedUsage: args.hostCompactionReducedUsage,
    });
    if (reading.completed !== undefined)
        updateSessionMeta(db, sessionID, { lastResponseTime: reading.completed });
    const percentage = (reading.inputTokens / reading.limit) * 100;
    updateSessionMeta(db, sessionID, {
        lastContextPercentage: percentage,
        lastInputTokens: reading.inputTokens,
        lastUsageContextLimit: reading.limit,
        lastObservedModelKey: reading.modelKey ?? draftModelKey,
    });
    sessionLog(
        sessionID,
        `v2 usage: inputTokens=${reading.inputTokens} contextLimit=${reading.limit} percentage=${percentage} responseModel=${reading.modelKey ?? "legacy"} draftContextLimit=${reading.admissionLimit} pressure=${readingMatchesDraft ? "current" : "stale-model-ignored"}`,
    );
    if (readingMatchesDraft) {
        args.contextUsageMap.set(sessionID, {
            usage: { inputTokens: reading.inputTokens, percentage },
            hasUsageTokens: true,
            updatedAt: Date.now(),
        });
    } else {
        args.contextUsageMap.delete(sessionID);
    }
    return unsafe;
}
