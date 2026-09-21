/**
 * Per-model tokenizer calibration ratios.
 *
 * ai-tokenizer's `claude` / `o200k_base` / `cl100k_base` / `p50k_base` encodings
 * approximate provider tokenizers but drift from the API's actual count by
 * model-specific amounts. Empirically measured ratios from
 * `scripts/calibrate-tokenizer/` (sweep against real production system prompt
 * + 39 MCP-style tools + minimal conversation, comparing local count vs each
 * provider's own usage.input_tokens).
 *
 * `system_ratio = api_tokens / local_raw_tokens` for plain-text system prompts
 * `tools_ratio  = api_tokens / local_raw_tokens` for the tools array
 *
 * Multiplying the local count by these ratios yields the API's count.
 *
 * Pattern matching: longest prefix wins. Unknown models fall back to 1.0 / 1.0
 * (no calibration). Re-run the harness when adding new models or after a
 * provider tokenizer change.
 */

export interface ModelCalibration {
    systemRatio: number;
    toolsRatio: number;
    /** Table prefix the ratios were inherited from when the model itself is unmeasured. */
    derivedFrom?: string;
    proseRatio: number;
}

interface CalibrationEntry extends Omit<ModelCalibration, "proseRatio"> {
    proseRatio?: number;
    /** Match against `${providerID}/${modelID}` (case-insensitive). Longest wins. */
    prefix: string;
}

/**
 * Empirically measured drift ratios. Order does not matter - longest prefix
 * is selected at lookup time. Verified models only; unknown models fall back
 * to 1.0/1.0 which is safer than guessing.
 */
const CALIBRATION_TABLE: CalibrationEntry[] = [
    // Measured on the public Gemini API. Antigravity OAuth model aliases are
    // excluded because their tokenization has not been measured.
    {
        prefix: "google/gemini-3.8-flash",
        systemRatio: 0.961167,
        toolsRatio: 0.967504,
        proseRatio: 1.006909,
    },
    {
        prefix: "google/gemini-3.7-flash",
        systemRatio: 0.961167,
        toolsRatio: 0.967504,
        proseRatio: 1.006909,
    },
    {
        prefix: "google/gemini-3.1-pro-preview",
        systemRatio: 0.961167,
        toolsRatio: 0.967504,
        proseRatio: 1.006909,
    },
    // Free count_tokens measurements, 2026-09-21; routed aliases mirror the same
    // upstream tokenizer, following the Opus 4.7/4.8 convention below. Fable 5.2
    // remains neutral because it has not been measured; only 5.1 snapshots match.
    {
        prefix: "anthropic/claude-fable-5-1",
        systemRatio: 1.511497,
        toolsRatio: 1.551639,
        proseRatio: 1.571778,
    },
    {
        prefix: "anthropic/claude-opus-5",
        systemRatio: 1.511497,
        toolsRatio: 1.551639,
        proseRatio: 1.571778,
    },
    {
        prefix: "openrouter/anthropic/claude-fable-5-1",
        systemRatio: 1.511497,
        toolsRatio: 1.551639,
        proseRatio: 1.571778,
    },
    {
        prefix: "openrouter/anthropic/claude-opus-5",
        systemRatio: 1.511497,
        toolsRatio: 1.551639,
        proseRatio: 1.571778,
    },
    {
        prefix: "github-copilot/claude-fable-5-1",
        systemRatio: 1.511497,
        toolsRatio: 1.551639,
        proseRatio: 1.571778,
    },
    {
        prefix: "github-copilot/claude-opus-5",
        systemRatio: 1.511497,
        toolsRatio: 1.551639,
        proseRatio: 1.571778,
    },
    // Anthropic Opus 4.8 — same new tokenizer family as 4.7 (not in ai-tokenizer's
    // claude encoding). Without these it falls to NEUTRAL (1.0/1.0) and the
    // sidebar undercounts System+ToolDefs by ~50%, starving the Conversation
    // bucket. Reuse 4.7's empirically-measured ratios until 4.8 is calibrated.
    { prefix: "anthropic/claude-opus-4-8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "anthropic/claude-opus-4.8", systemRatio: 1.51, toolsRatio: 1.57 },
    // Anthropic Opus 4.7 — new tokenizer not yet in ai-tokenizer's claude encoding.
    {
        prefix: "anthropic/claude-opus-4-7",
        systemRatio: 1.51,
        toolsRatio: 1.57,
        proseRatio: 1.571778,
    },
    { prefix: "anthropic/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    // Claude 4.5/4.6 family — ai-tokenizer's claude encoding matches well.
    { prefix: "anthropic/claude-opus-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4-6", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-opus-4.6", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-sonnet-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    {
        prefix: "anthropic/claude-sonnet-4-6",
        systemRatio: 1.02,
        toolsRatio: 1.14,
        proseRatio: 1.057976,
    },
    { prefix: "anthropic/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "anthropic/claude-haiku-4-5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "anthropic/claude-haiku-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    // Claude through OpenRouter / GitHub Copilot — same upstream tokenizer.
    // Opus 4.7 routed via OpenRouter / GitHub Copilot uses Anthropic's new
    // tokenizer too; without these entries the longest-prefix matcher falls
    // through to NEUTRAL (1.0/1.0) and the sidebar misattributes ~30K tokens
    // from System+ToolDefs into Conversation/ToolCalls. Sum-to-inputTokens is
    // still preserved (residuals absorb), but the per-bucket numbers drift.
    { prefix: "openrouter/anthropic/claude-opus-4-8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4.8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4-8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4.8", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4-7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "github-copilot/claude-opus-4.7", systemRatio: 1.51, toolsRatio: 1.57 },
    { prefix: "openrouter/anthropic/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "github-copilot/claude-sonnet-4.6", systemRatio: 1.02, toolsRatio: 1.14 },
    { prefix: "github-copilot/claude-sonnet-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "github-copilot/claude-opus-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    { prefix: "github-copilot/claude-haiku-4.5", systemRatio: 1.02, toolsRatio: 1.16 },
    // Measured via the API-key Responses counting endpoint, not ChatGPT OAuth.
    // Historical Codex completion-usage measurements remain in results.json.
    { prefix: "openai/gpt-5.5", systemRatio: 1.000278, toolsRatio: 0.850953, proseRatio: 1.000017 },
    {
        prefix: "openai/gpt-6-astra",
        systemRatio: 1.000278,
        toolsRatio: 0.850953,
        proseRatio: 1.000017,
    },
    // OpenAI gpt-5.x — ai-tokenizer's o200k_base matches exactly, tools overcounted ~16%.
    { prefix: "openai/gpt-5", systemRatio: 1.0, toolsRatio: 0.84 },
    // Raw text counts exclude the provider's hidden chat-message framing;
    // that framing remains an unmeasured source of error in residual buckets.
    {
        prefix: "xai/grok-4-latest",
        systemRatio: 0.817751,
        toolsRatio: 0.880494,
        proseRatio: 0.880137,
    },
    {
        prefix: "xai/grok-code-fast-1",
        systemRatio: 0.817751,
        toolsRatio: 0.880494,
        proseRatio: 0.880137,
    },
    // xAI Grok — ai-tokenizer overcounts (uses p50k_base which doesn't match Grok exactly).
    { prefix: "xai/grok-4", systemRatio: 0.82, toolsRatio: 0.88 },
    { prefix: "xai/grok-code-fast", systemRatio: 0.82, toolsRatio: 0.89 },
    // Cerebras — qwen tokenizer accurate, glm close, gpt-oss-120b overcounts heavily.
    { prefix: "cerebras/qwen-3-235b", systemRatio: 1.0, toolsRatio: 1.1 },
    { prefix: "cerebras/zai-glm-4.7", systemRatio: 1.0, toolsRatio: 1.09 },
    { prefix: "cerebras/gpt-oss-120b", systemRatio: 0.84, toolsRatio: 0.79 },
    // Fireworks — DeepSeek and GLM close, kimi diverges significantly.
    {
        prefix: "fireworks-ai/accounts/fireworks/models/glm-5p1",
        systemRatio: 1.0,
        toolsRatio: 1.06,
    },
    {
        prefix: "fireworks-ai/accounts/fireworks/models/deepseek-v3p2",
        systemRatio: 1.05,
        toolsRatio: 1.09,
    },
    // OpenCode-Go — same upstream open-weight providers.
    { prefix: "opencode-go/glm-5.1", systemRatio: 1.0, toolsRatio: 1.06 },
    { prefix: "opencode-go/glm-5", systemRatio: 1.0, toolsRatio: 1.06 },
    // Moonshot's free estimate endpoint (2026-09-21) reproduced the usage-derived
    // 0.87/0.86 within 0.5%, so the OpenCode-Go alias carries the measured prose
    // ratio for the same upstream model.
    { prefix: "opencode-go/kimi-k2.6", systemRatio: 0.87, toolsRatio: 0.86, proseRatio: 0.925501 },
    // Moonshot direct — tokenizers/estimate-token-count, 2026-09-21.
    {
        prefix: "moonshot/kimi-k2.6",
        systemRatio: 0.872126,
        toolsRatio: 0.863853,
        proseRatio: 0.925501,
    },
    {
        prefix: "moonshot/kimi-for-coding",
        systemRatio: 0.872126,
        toolsRatio: 0.863853,
        proseRatio: 0.925501,
    },
    // Z.ai direct — paas/v4/tokenizer, 2026-09-21. Only GLM 4.x is measurable:
    // the endpoint returns prompt_tokens=0 for every glm-5* id, so those stay
    // on their usage-derived rows above.
    { prefix: "zai/glm-4.7", systemRatio: 0.999721, toolsRatio: 1.056823, proseRatio: 1.000875 },
    // Meta Muse Spark — responses/input_tokens preflight, 2026-09-21. All five
    // Spark ids measured identically; the Zen-routed alias is the same model.
    {
        prefix: "meta/muse-spark",
        systemRatio: 0.865949,
        toolsRatio: 1.024605,
        proseRatio: 0.923366,
    },
    {
        prefix: "opencode/muse-spark",
        systemRatio: 0.865949,
        toolsRatio: 1.024605,
        proseRatio: 0.923366,
    },
];

const NEUTRAL: ModelCalibration = { systemRatio: 1.0, toolsRatio: 1.0, proseRatio: 1.0 };

/**
 * Look up calibration ratios for a given `providerID/modelID` key. Performs
 * longest-prefix match (case-insensitive). Returns neutral ratios (1.0/1.0)
 * for unknown models so the calibration is a no-op rather than incorrect.
 */
export function resolveModelCalibration(
    providerId: string | undefined,
    modelId: string | undefined,
): ModelCalibration {
    if (!providerId || !modelId) return NEUTRAL;
    const key = `${providerId}/${modelId}`.toLowerCase();
    let best: CalibrationEntry | null = null;
    for (const entry of CALIBRATION_TABLE) {
        const prefix = entry.prefix.toLowerCase();
        if (!key.startsWith(prefix)) continue;
        if (!best || prefix.length > best.prefix.length) {
            best = entry;
        }
    }
    if (best) return { ...best, proseRatio: best.proseRatio ?? 1.0 };
    return resolveFamilyFallback(providerId.toLowerCase(), modelId.toLowerCase()) ?? NEUTRAL;
}

/**
 * A model id split into the parts that decide tokenizer kinship: the family
 * name before the first numeric token, the numeric version, and the variant
 * words after it. `claude-fable-5-2` is family `claude-fable`, version [5, 2],
 * no variant; `gpt-6-astra` is family `gpt`, version [6], variant `astra`;
 * `gemini-3.8-flash` is family `gemini`, version [3, 8], variant `flash`.
 * Ids with no numeric token (`kimi-k2.6`) have no version and never fall back.
 */
interface ModelLineage {
    family: string;
    version: number[];
    variant: string;
}

function parseModelLineage(modelId: string): ModelLineage | null {
    const tokens = modelId.split("-");
    const versionAt = tokens.findIndex((token) => /^\d+(\.\d+)*$/.test(token));
    if (versionAt <= 0) return null;
    const version: number[] = [];
    let end = versionAt;
    while (end < tokens.length && /^\d+(\.\d+)*$/.test(tokens[end] ?? "")) {
        for (const part of (tokens[end] ?? "").split(".")) version.push(Number(part));
        end += 1;
    }
    return {
        family: tokens.slice(0, versionAt).join("-"),
        version,
        variant: tokens.slice(end).join("-"),
    };
}

function compareVersions(a: number[], b: number[]): number {
    const length = Math.max(a.length, b.length);
    for (let i = 0; i < length; i++) {
        const delta = (a[i] ?? 0) - (b[i] ?? 0);
        if (delta !== 0) return delta;
    }
    return 0;
}

/**
 * A model the table has never measured inherits the ratios of its nearest
 * measured relative: same provider, same family, same variant, preferring the
 * newest version below the requested one, else the oldest above it. A new
 * release (Fable 5.2 the week it ships) is far more likely to keep its
 * predecessor's tokenizer than to match NEUTRAL, which is not a tokenizer at
 * all but the absence of one; the learned session scalar corrects any drift
 * once it exists. The chosen source is reported in `derivedFrom` so logs can
 * tell a measurement from an inheritance.
 */
function resolveFamilyFallback(providerId: string, modelId: string): ModelCalibration | null {
    const wanted = parseModelLineage(modelId);
    if (!wanted) return null;
    let below: { entry: CalibrationEntry; version: number[] } | null = null;
    let above: { entry: CalibrationEntry; version: number[] } | null = null;
    for (const entry of CALIBRATION_TABLE) {
        const prefix = entry.prefix.toLowerCase();
        if (!prefix.startsWith(`${providerId}/`)) continue;
        const lineage = parseModelLineage(prefix.slice(providerId.length + 1));
        if (!lineage || lineage.family !== wanted.family || lineage.variant !== wanted.variant)
            continue;
        const order = compareVersions(lineage.version, wanted.version);
        if (order === 0) continue;
        if (order < 0) {
            if (!below || compareVersions(lineage.version, below.version) > 0) {
                below = { entry, version: lineage.version };
            }
        } else if (!above || compareVersions(lineage.version, above.version) < 0) {
            above = { entry, version: lineage.version };
        }
    }
    const source = below ?? above;
    if (!source) return null;
    return {
        systemRatio: source.entry.systemRatio,
        toolsRatio: source.entry.toolsRatio,
        proseRatio: source.entry.proseRatio ?? 1.0,
        derivedFrom: source.entry.prefix,
    };
}

/**
 * Apply calibration to local raw counts and absorb the residual into the
 * unknown-drift buckets so all categories sum to exactly inputTokens.
 *
 * Bucket policy by stability:
 *   1. **Calibrated** (System, Tool Defs) — local count × measured per-model
 *      ratio. We have empirically derived ratios from `scripts/calibrate-tokenizer/`,
 *      so these match the API to within ~5%.
 *   2. **Calibrated prose** (Compartments, Facts, Memories, Docs, Profile) —
 *      local count × measured prose ratio (1.0 when unmeasured). Display-only:
 *      transform budgets and served bytes continue to use raw local counts.
 *   3. **Residual absorbers** (Conversation, Tool Calls) — proportionally
 *      scaled to absorb whatever's left after (1) and (2). These have the
 *      most genuine drift (mixed user/assistant text + tool I/O) and the
 *      least fixed structure, so attributing the unknown remainder here is
 *      the most honest mapping.
 *
 * Behavior at the edges:
 *   - inputTokens === 0 → returns all zeros.
 *   - residual local sum === 0 (no conversation or tool calls yet) →
 *     conversation absorbs the full remainder so the bar still adds up.
 *   - non-residual buckets together exceed inputTokens (rare clamp case) →
 *     residuals = 0; calibrated system/tools + prose are scaled down proportionally so
 *     the sum never exceeds inputTokens.
 *   - rounding: residual ±1 token from rounding lands in the larger residual
 *     bucket so exact equality is preserved.
 */
export interface CalibratedBuckets {
    systemTokens: number;
    toolDefinitionTokens: number;
    compartmentTokens: number;
    factTokens: number;
    memoryTokens: number;
    docsTokens: number;
    profileTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
}

export interface CalibrationInput {
    inputTokens: number;
    /** Local raw count (ai-tokenizer) for the system prompt. */
    systemLocal: number;
    /** Local raw count (ai-tokenizer) for the tool definitions. */
    toolDefsLocal: number;
    /** Raw first-message (m0) prose counts, calibrated for display only; budgets remain local. */
    compartmentsLocal: number;
    factsLocal: number;
    memoriesLocal: number;
    /** Raw — <project-docs> block in the first message (stable scaffolding, own budget). */
    docsLocal: number;
    /** Raw — <user-profile> block in the first message (stable scaffolding, own budget). */
    profileLocal: number;
    /** Residual absorbers — proportionally scaled to absorb the remainder. */
    conversationLocal: number;
    toolCallsLocal: number;
    calibration: ModelCalibration;
}

export function calibrateBuckets(input: CalibrationInput): CalibratedBuckets {
    const empty: CalibratedBuckets = {
        systemTokens: 0,
        toolDefinitionTokens: 0,
        compartmentTokens: 0,
        factTokens: 0,
        memoryTokens: 0,
        docsTokens: 0,
        profileTokens: 0,
        conversationTokens: 0,
        toolCallTokens: 0,
    };
    if (input.inputTokens <= 0) return empty;

    // (1) Calibrated buckets: System + Tool Defs scaled by per-model ratios.
    let calibratedSystem = Math.round(input.systemLocal * input.calibration.systemRatio);
    let calibratedToolDefs = Math.round(input.toolDefsLocal * input.calibration.toolsRatio);

    // (2) First-message prose is calibrated for display, independently of budget accounting.
    const proseRatio = input.calibration.proseRatio;
    let compartments = Math.round(Math.max(0, input.compartmentsLocal) * proseRatio);
    let facts = Math.round(Math.max(0, input.factsLocal) * proseRatio);
    let memories = Math.round(Math.max(0, input.memoriesLocal) * proseRatio);
    let docs = Math.round(Math.max(0, input.docsLocal) * proseRatio);
    let profile = Math.round(Math.max(0, input.profileLocal) * proseRatio);

    // Edge case: calibrated system/tools + prose already exceed inputTokens. Clamp them
    // down proportionally so the residual buckets stay non-negative.
    const nonResidualTotal =
        calibratedSystem + calibratedToolDefs + compartments + facts + memories + docs + profile;
    if (nonResidualTotal > input.inputTokens) {
        const ratio = input.inputTokens / nonResidualTotal;
        calibratedSystem = Math.round(calibratedSystem * ratio);
        calibratedToolDefs = Math.round(calibratedToolDefs * ratio);
        compartments = Math.round(compartments * ratio);
        facts = Math.round(facts * ratio);
        memories = Math.round(memories * ratio);
        docs = Math.round(docs * ratio);
        profile = Math.round(profile * ratio);
    }

    // (3) Residual buckets: Conversation + Tool Calls absorb whatever's left.
    const residualTarget = Math.max(
        0,
        input.inputTokens -
            calibratedSystem -
            calibratedToolDefs -
            compartments -
            facts -
            memories -
            docs -
            profile,
    );
    const residualLocalSum = input.conversationLocal + input.toolCallsLocal;

    let conversation: number;
    let toolCalls: number;

    if (residualLocalSum <= 0) {
        // No conversation / tool-call content locally yet — park the full
        // residual in conversation so the bar still adds up cleanly.
        conversation = residualTarget;
        toolCalls = 0;
    } else {
        const scale = residualTarget / residualLocalSum;
        conversation = Math.round(input.conversationLocal * scale);
        toolCalls = Math.round(input.toolCallsLocal * scale);
    }

    // Rounding correction: residual ±1/±2 token from Math.round lands in the
    // larger residual bucket so the final sum equals inputTokens exactly.
    const provisionalSum =
        calibratedSystem +
        calibratedToolDefs +
        compartments +
        facts +
        memories +
        docs +
        profile +
        conversation +
        toolCalls;
    let delta = input.inputTokens - provisionalSum;
    if (delta !== 0) {
        if (conversation >= toolCalls) {
            const adjusted = Math.max(0, conversation + delta);
            delta -= adjusted - conversation;
            conversation = adjusted;
        } else {
            const adjusted = Math.max(0, toolCalls + delta);
            delta -= adjusted - toolCalls;
            toolCalls = adjusted;
        }
    }

    // Edge case: in the clamp path with both residuals already at zero, the
    // round-up overshoot from `Math.round(x * ratio)` can't be absorbed by
    // residuals (Math.max clamps the negative delta to 0). Subtract the
    // remaining overshoot from non-residual buckets in descending-size
    // order until delta reaches zero, so the final sum equals inputTokens
    // exactly. Loops because a single bucket may not be large enough to
    // absorb the entire overshoot (rare but possible at tiny inputTokens
    // with heavy calibration ratios). Without this loop, pathological inputs
    // could leave a residual of +1 or +2 tokens.
    if (delta < 0) {
        type BucketName =
            | "system"
            | "toolDefs"
            | "compartments"
            | "facts"
            | "memories"
            | "docs"
            | "profile";
        const get = (name: BucketName): number => {
            if (name === "system") return calibratedSystem;
            if (name === "toolDefs") return calibratedToolDefs;
            if (name === "compartments") return compartments;
            if (name === "facts") return facts;
            if (name === "docs") return docs;
            if (name === "profile") return profile;
            return memories;
        };
        const subtract = (name: BucketName, amount: number): void => {
            if (name === "system") calibratedSystem -= amount;
            else if (name === "toolDefs") calibratedToolDefs -= amount;
            else if (name === "compartments") compartments -= amount;
            else if (name === "facts") facts -= amount;
            else if (name === "docs") docs -= amount;
            else if (name === "profile") profile -= amount;
            else memories -= amount;
        };
        const buckets: BucketName[] = [
            "system",
            "toolDefs",
            "compartments",
            "facts",
            "memories",
            "docs",
            "profile",
        ];
        // Sort by current value descending so we drain the largest first.
        buckets.sort((a, b) => get(b) - get(a));
        for (const name of buckets) {
            if (delta >= 0) break;
            const value = get(name);
            if (value <= 0) continue;
            const adjustment = Math.min(value, -delta);
            subtract(name, adjustment);
            delta += adjustment;
        }
    }

    return {
        systemTokens: calibratedSystem,
        toolDefinitionTokens: calibratedToolDefs,
        compartmentTokens: compartments,
        factTokens: facts,
        memoryTokens: memories,
        docsTokens: docs,
        profileTokens: profile,
        conversationTokens: conversation,
        toolCallTokens: toolCalls,
    };
}
