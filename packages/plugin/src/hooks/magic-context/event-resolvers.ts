import { getModelsDevContextLimit } from "../../shared/models-dev-cache";

const DEFAULT_CONTEXT_LIMIT = 128_000;

type CacheTtlConfig = string | Record<string, string>;

export function resolveContextLimit(
    providerID: string | undefined,
    modelID: string | undefined,
): number {
    if (!providerID) {
        return DEFAULT_CONTEXT_LIMIT;
    }

    // Read from OpenCode's models.dev cache file at ~/.cache/opencode/models.json.
    // `getModelsDevContextLimit` also overlays custom `provider.*.models.*.limit.context`
    // entries from the user's opencode.json(c), so explicit user overrides are honored.
    if (modelID) {
        const modelsDevLimit = getModelsDevContextLimit(providerID, modelID);
        if (modelsDevLimit !== undefined) {
            return modelsDevLimit;
        }
    }

    // Conservative default for models not in models.dev and not configured.
    return DEFAULT_CONTEXT_LIMIT;
}

export function resolveCacheTtl(cacheTtl: CacheTtlConfig, modelKey: string | undefined): string {
    if (typeof cacheTtl === "string") {
        return cacheTtl;
    }

    if (modelKey && typeof cacheTtl[modelKey] === "string") {
        return cacheTtl[modelKey];
    }

    if (modelKey) {
        const bareModelId = modelKey.split("/").slice(1).join("/");
        if (bareModelId && typeof cacheTtl[bareModelId] === "string") {
            return cacheTtl[bareModelId];
        }
    }

    return cacheTtl.default ?? "5m";
}

type ExecuteThresholdConfig = number | { default: number; [modelKey: string]: number };

/**
 * Yield progressively-less-specific lookup keys for a given `provider/model`.
 *
 * OpenCode's `experimental.modes` feature derives model IDs like
 * `gpt-5.4-fast` from a base model `gpt-5.4`. Users may put EITHER the
 * derived key OR the base key in their per-model config. This generator
 * returns keys in specificity order so we pick the most specific match
 * the user actually wrote:
 *
 *   "openai/gpt-5.4-fast"  (exact)
 *   "gpt-5.4-fast"         (bare, derived)
 *   "openai/gpt-5.4"       (base, with provider)
 *   "gpt-5.4"              (base, bare)
 *   ...etc. stripping one "-segment" at a time
 */
function* modelKeyLookupOrder(modelKey: string): Generator<string> {
    const slash = modelKey.indexOf("/");
    const provider = slash >= 0 ? modelKey.slice(0, slash) : "";
    let modelId = slash >= 0 ? modelKey.slice(slash + 1) : modelKey;

    while (modelId.length > 0) {
        if (provider) yield `${provider}/${modelId}`;
        yield modelId;
        const lastDash = modelId.lastIndexOf("-");
        if (lastDash <= 0) break;
        modelId = modelId.slice(0, lastDash);
    }
}

export function resolveExecuteThreshold(
    config: ExecuteThresholdConfig,
    modelKey: string | undefined,
    fallback: number,
): number {
    const MAX_EXECUTE_THRESHOLD = 80;
    let resolved: number;

    if (typeof config === "number") {
        resolved = config;
    } else if (modelKey) {
        let matched: number | undefined;
        for (const candidate of modelKeyLookupOrder(modelKey)) {
            if (typeof config[candidate] === "number") {
                matched = config[candidate];
                break;
            }
        }
        resolved = matched ?? config.default ?? fallback;
    } else {
        resolved = config.default ?? fallback;
    }

    // Cap at 80% — higher values create a gap between execute_threshold and
    // forceMaterialization (85%) where shouldRunHeuristics fires on defer
    // passes without isCacheBustingPass, causing unguarded cache busts.
    return Math.min(resolved, MAX_EXECUTE_THRESHOLD);
}

export function resolveModelKey(
    providerID: string | undefined,
    modelID: string | undefined,
): string | undefined {
    if (!providerID || !modelID) {
        return undefined;
    }

    return `${providerID}/${modelID}`;
}

export function resolveSessionId(
    properties: { info?: unknown; sessionID?: string } | undefined,
): string | undefined {
    if (typeof properties?.sessionID === "string") {
        return properties.sessionID;
    }

    const info = properties?.info;
    if (info === null || typeof info !== "object") {
        return undefined;
    }

    const record = info as Record<string, unknown>;
    if (typeof record.sessionID === "string") {
        return record.sessionID;
    }
    if (typeof record.id === "string") {
        return record.id;
    }

    return undefined;
}
