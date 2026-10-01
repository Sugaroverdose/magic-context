import type { ProviderRoute, ScenarioSpec } from "../types";

/**
 * Bedrock Converse with a Bedrock API key (sent as a bearer token). Claude's thinking blocks
 * carry provider signatures; the question is whether Bedrock accepts a request after the
 * oldest of them are removed. Sonnet 5.5 is one of the models whose signed thinking is bound to
 * the exact preceding history, so a `prefix_mismatch` refusal would show up there first.
 */
const bedrockBase = {
    credentialId: "apikey:amazon-bedrock",
    providerId: "amazon-bedrock",
    npm: "@ai-sdk/amazon-bedrock",
    upstreamBase: "https://bedrock-runtime.us-east-1.amazonaws.com",
    protocol: "bedrock-converse",
    providerOptions: { region: "us-east-1" },
    modelConfig: { limit: { context: 200_000, output: 8_192 } },
    modelOptions: { reasoningConfig: { type: "enabled", budgetTokens: 1024 } },
} as const satisfies Omit<ProviderRoute, "id" | "model">;

export const bedrockHaiku: ProviderRoute = {
    ...bedrockBase,
    id: "bedrock-haiku-4-5",
    model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
};

export const bedrockSonnet55: ProviderRoute = {
    ...bedrockBase,
    id: "bedrock-sonnet-5-5",
    // models.dev lists Sonnet 5.5 on Bedrock only under the bare id and the `global.`
    // cross-region inference profile (no `us.` profile), so this route uses the global one.
    model: "global.anthropic.claude-sonnet-5-5",
};

export const scenarios: ScenarioSpec[] = [
    { route: bedrockHaiku, kind: "age", loopSteps: 12, clearReasoningAge: 10, callBudget: 21 },
    { route: bedrockSonnet55, kind: "age", loopSteps: 12, clearReasoningAge: 10, callBudget: 21 },
];
