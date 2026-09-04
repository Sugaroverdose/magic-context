import type { MagicContextConfig } from "../config/schema/magic-context";
import { resolveModelConfigValue } from "./prompt-surface";

export type CacheTtlDisplaySource = "config" | "session" | "default";

export interface CacheTtlDisplay {
    value: string;
    source: CacheTtlDisplaySource;
    modelKey: string | undefined;
}

export interface ResolveCacheTtlDisplayArgs {
    configured: MagicContextConfig["cache_ttl"];
    configuredExplicitly: boolean;
    modelKey: string | undefined;
    sessionValue: string;
    /** Model key persisted with the last completed assistant response. */
    sessionModelKey: string | null;
}

/**
 * Resolve status-only TTL text without changing the scheduler's persisted truth.
 * Use the session value only when its persisted model key matches the model being
 * displayed; otherwise use live config because the session value may be for another model.
 */
export function resolveCacheTtlDisplay(args: ResolveCacheTtlDisplayArgs): CacheTtlDisplay {
    if (
        (args.sessionModelKey && (!args.modelKey || args.sessionModelKey === args.modelKey)) ||
        (!args.modelKey && !args.sessionModelKey && args.sessionValue !== "5m")
    ) {
        return {
            value: args.sessionValue || "5m",
            source: "session",
            modelKey: args.modelKey ?? args.sessionModelKey ?? undefined,
        };
    }

    if (typeof args.configured === "string") {
        return {
            value: args.configured,
            source: args.configuredExplicitly ? "config" : "default",
            modelKey: args.modelKey,
        };
    }

    const matched = resolveModelConfigValue(args.configured, args.modelKey);
    if (matched) {
        return { value: matched.value, source: "config", modelKey: args.modelKey };
    }

    return {
        value: args.configured.default ?? "5m",
        source: "default",
        modelKey: args.modelKey,
    };
}

export function formatCacheTtlDisplay(display: CacheTtlDisplay): string {
    if (display.source === "session") return `Cache TTL: ${display.value} (session)`;
    if (display.source === "config") {
        return `Cache TTL: ${display.value} (config for ${display.modelKey ?? "current model"})`;
    }
    return `Cache TTL: ${display.value} (default — no cache_ttl for ${display.modelKey ?? "unknown model"})`;
}
