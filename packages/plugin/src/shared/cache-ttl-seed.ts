import type { MagicContextConfig } from "../config/schema/magic-context";
import { getOrCreateSessionMeta, updateSessionMeta } from "../features/magic-context/storage-meta";
import { resolveModelConfigValue } from "./prompt-surface";
import type { Database } from "./sqlite";

/** Seed only before a completed assistant response has made the session row authoritative. */
export function seedSessionCacheTtlIfUnsynced(args: {
    db: Database;
    sessionId: string;
    configured: MagicContextConfig["cache_ttl"];
    modelKey: string;
}): boolean {
    const meta = getOrCreateSessionMeta(args.db, args.sessionId);
    if (meta.lastResponseTime !== 0 || meta.lastObservedModelKey !== null) return false;
    const cacheTtl =
        typeof args.configured === "string"
            ? args.configured
            : (resolveModelConfigValue(args.configured, args.modelKey)?.value ??
              args.configured.default ??
              "5m");
    updateSessionMeta(args.db, args.sessionId, { cacheTtl });
    return true;
}
