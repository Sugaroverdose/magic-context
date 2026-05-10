import { getAgentFallbackModels } from "./model-requirements";

/**
 * Resolve the final fallback model list to attempt for an OpenCode subagent
 * call.
 *
 * Policy (decided 2026-05-10):
 *   - If user configured explicit `fallback_models` in their magic-context.jsonc
 *     for this agent: use ONLY those. Respects user intent, no surprise
 *     providers.
 *   - If user did NOT configure any: fall back to the plugin's builtin
 *     provider-agnostic chain (`AGENT_MODEL_REQUIREMENTS`).
 *
 * The returned list does NOT include the primary model — it's the ordered
 * list of *alternates* to try after the primary fails. Each entry is
 * "provider/modelID" form.
 *
 * Duplicates and empty strings are filtered. Entries that don't match the
 * "provider/modelID" shape (must contain a "/" with non-empty parts) are
 * also dropped — defensive guard against malformed user config.
 */
export function resolveFallbackChain(
    agentName: string,
    userFallbacks: readonly string[] | string | undefined,
): string[] {
    const userList = normalizeUserFallbacks(userFallbacks);

    if (userList.length > 0) {
        return dedupe(userList.filter(isValidModelSpec));
    }

    const builtin = getAgentFallbackModels(agentName);
    if (!builtin || builtin.length === 0) return [];
    return dedupe(builtin.filter(isValidModelSpec));
}

function normalizeUserFallbacks(userFallbacks: readonly string[] | string | undefined): string[] {
    if (!userFallbacks) return [];
    if (typeof userFallbacks === "string") {
        const trimmed = userFallbacks.trim();
        return trimmed ? [trimmed] : [];
    }
    return userFallbacks.map((s) => s.trim()).filter((s) => s.length > 0);
}

function isValidModelSpec(spec: string): boolean {
    const slash = spec.indexOf("/");
    return slash > 0 && slash < spec.length - 1;
}

function dedupe(list: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
        if (seen.has(item)) continue;
        seen.add(item);
        out.push(item);
    }
    return out;
}

/**
 * Parse a "provider/modelID" string into the OpenCode `model` object shape.
 * Returns null on invalid input.
 *
 * Note: only splits on the FIRST "/" — modelID can legitimately contain slashes
 * (e.g. `lemonade/GLM-4.7-Flash-GGUF/main`).
 */
export function parseProviderModel(spec: string): { providerID: string; modelID: string } | null {
    const slash = spec.indexOf("/");
    if (slash < 1 || slash >= spec.length - 1) return null;
    return {
        providerID: spec.slice(0, slash).trim(),
        modelID: spec.slice(slash + 1).trim(),
    };
}
