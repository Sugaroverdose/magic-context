import type { Scheduler } from "../../features/magic-context/scheduler";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { loadPersistedUsage, type PersistedUsageState } from "../../features/magic-context/storage";
import type { ContextUsage, SessionMeta } from "../../features/magic-context/types";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";

type ContextUsageCacheEntry = {
    usage: ContextUsage;
    updatedAt: number;
    lastResponseTime?: number;
    hasUsageTokens?: boolean;
};

function loadPersistedUsageWatermark(db: ContextDatabase, sessionId: string): number | null {
    const result = db
        .prepare("SELECT last_response_time FROM session_meta WHERE session_id = ?")
        .get(sessionId);

    if (result === null || typeof result !== "object") return null;
    const lastResponseTime = (result as { last_response_time?: unknown }).last_response_time;
    return typeof lastResponseTime === "number" ? lastResponseTime : null;
}

export interface ContextUsagePassSnapshot {
    lastResponseTime: number;
    persistedUsage: PersistedUsageState | null;
}

export function contextUsagePassSnapshot(sessionMeta: SessionMeta): ContextUsagePassSnapshot {
    const hasPersistedUsage =
        sessionMeta.lastContextPercentage !== 0 || sessionMeta.lastInputTokens !== 0;
    return {
        lastResponseTime: sessionMeta.lastResponseTime,
        persistedUsage: hasPersistedUsage
            ? {
                  usage: {
                      percentage: sessionMeta.lastContextPercentage,
                      inputTokens: sessionMeta.lastInputTokens,
                  },
                  updatedAt: sessionMeta.lastResponseTime || Date.now(),
                  lastObservedModelKey: sessionMeta.lastObservedModelKey,
                  lastUsageContextLimit: sessionMeta.lastUsageContextLimit,
              }
            : null,
    };
}

const canonicalizeModelKeyForUsageSeed = (key: string | null | undefined): string | null => {
    if (typeof key !== "string" || key.length === 0) return null;
    const canonical = piModelRefToCanonical(key);
    return canonical.length > 0 ? canonical : key;
};

/**
 * Boot seeding for the provider-reported context usage.
 *
 * The live usage map is in-memory and starts empty, so the first priced pass
 * of a restarted process would otherwise estimate usage against the usable-hard
 * geometry — a smaller denominator than the provider window the persisted
 * percentage is measured against. A healthy session's boot pass then lands
 * above the scheduler trigger and the emergency drain band by arithmetic
 * alone, and the pass drops calls the session never needed to drop. The
 * provider-reported usage persisted at the last response is the real number:
 * percentage against the provider window, input tokens from the served wire.
 *
 * Returns the persisted usage when it is usable for the outgoing model:
 * non-zero, fresh, model key matching (persisted keys are model-bound).
 * Returns null when the estimate path must run (first pass of a session,
 * model switch, absent record).
 */
export function seedPersistedUsageAtBoot(input: {
    persistedUsage: ContextUsagePassSnapshot["persistedUsage"];
    currentModelKey: string | undefined;
}): ContextUsage | null {
    const persisted = input.persistedUsage;
    if (!persisted || persisted.usage.inputTokens <= 0) return null;
    const persistedKey = canonicalizeModelKeyForUsageSeed(persisted.lastObservedModelKey);
    const currentKey = canonicalizeModelKeyForUsageSeed(input.currentModelKey);
    if (persistedKey && currentKey && persistedKey !== currentKey) return null;
    return persisted.usage;
}

export function resolveUnknownUsageFromWireEstimate(input: {
    usage: ContextUsage;
    pricedPass: boolean;
    wireEstimateTokens: number | undefined;
    wireEstimateTrusted?: boolean;
    providerProvenInputTokens?: number;
    providerProvenLimitTokens?: number;
    usableHardLimit: number | undefined;
}): ContextUsage {
    if (input.usage.inputTokens > 0 || !input.pricedPass) return input.usage;
    const wireTokens = input.wireEstimateTokens;
    if (typeof wireTokens !== "number" || !Number.isFinite(wireTokens) || wireTokens <= 0) {
        return input.usage;
    }
    const providerTokens = input.providerProvenInputTokens;
    const providerLimit = input.providerProvenLimitTokens;
    const canUseProviderMass =
        input.wireEstimateTrusted === false &&
        typeof providerTokens === "number" &&
        Number.isFinite(providerTokens) &&
        providerTokens > 0 &&
        typeof providerLimit === "number" &&
        Number.isFinite(providerLimit) &&
        providerLimit > 0;
    const tokens = canUseProviderMass ? Math.max(wireTokens, providerTokens) : wireTokens;
    const limit = input.usableHardLimit;
    const estimatedPercentage =
        typeof limit === "number" && Number.isFinite(limit) && limit > 0
            ? (tokens / limit) * 100
            : input.usage.percentage;
    return {
        inputTokens: tokens,
        percentage: Math.max(input.usage.percentage, estimatedPercentage),
    };
}

export function loadContextUsage(
    contextUsageMap: Map<string, ContextUsageCacheEntry>,
    db: ContextDatabase,
    sessionId: string,
    passSnapshot?: ContextUsagePassSnapshot,
): ContextUsage {
    const contextUsageEntry = contextUsageMap.get(sessionId);
    // message.updated owns the live map entry and replaces it whenever provider
    // usage changes. That event is the cache's invalidation signal, so a live
    // token-bearing entry needs no validating SELECT on each transform pass.
    if (contextUsageEntry?.hasUsageTokens === true) return contextUsageEntry.usage;
    try {
        const persistedLastResponseTime =
            passSnapshot?.lastResponseTime ?? loadPersistedUsageWatermark(db, sessionId);
        const cachedLastResponseTime =
            contextUsageEntry?.lastResponseTime ?? contextUsageEntry?.updatedAt;
        if (
            contextUsageEntry &&
            contextUsageEntry.lastResponseTime === undefined &&
            (persistedLastResponseTime === null || persistedLastResponseTime === 0)
        ) {
            return contextUsageEntry.usage;
        }
        if (contextUsageEntry && cachedLastResponseTime === persistedLastResponseTime) {
            return contextUsageEntry.usage;
        }

        const persisted = passSnapshot
            ? passSnapshot.persistedUsage
            : loadPersistedUsage(db, sessionId);
        if (persisted) {
            contextUsageMap.set(sessionId, {
                ...persisted,
                lastResponseTime: persistedLastResponseTime ?? persisted.updatedAt,
                // last_response_time also advances on provider errors that carry no usage.
                // A persisted percentage therefore has no process-local freshness proof.
                hasUsageTokens: false,
            });
            return persisted.usage;
        }

        contextUsageMap.delete(sessionId);
    } catch (error) {
        sessionLog(sessionId, "transform failed loading persisted usage:", error);
        return contextUsageEntry?.usage ?? { percentage: 0, inputTokens: 0 };
    }
    return { percentage: 0, inputTokens: 0 };
}

export function resolveSchedulerDecision(
    scheduler: Scheduler,
    sessionMeta: SessionMeta,
    contextUsage: ContextUsage,
    sessionId: string,
    modelKey?: string,
    contextLimit?: number,
): "execute" | "defer" {
    try {
        const schedulerDecision = scheduler.shouldExecute(
            sessionMeta,
            contextUsage,
            undefined,
            sessionId,
            modelKey,
            contextLimit,
        );
        sessionLog(
            sessionId,
            `transform scheduler: percentage=${contextUsage.percentage.toFixed(1)}% inputTokens=${contextUsage.inputTokens} cacheTtl=${sessionMeta.cacheTtl} lastResponseTime=${sessionMeta.lastResponseTime} decision=${schedulerDecision}`,
        );
        return schedulerDecision;
    } catch (error) {
        sessionLog(sessionId, "transform scheduler failed; defaulting to defer:", error);
        return "defer";
    }
}
