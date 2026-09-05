export const PRODUCER_WINDOW_REFUSAL_MARGIN = 0.15;

export interface ProducerWindowFailureInput {
    producerSourceTokens: number;
    contextLimitTokens?: number;
    maxOutputTokens: number;
}

export function producerWindowFailureReason(input: ProducerWindowFailureInput): string | null {
    const { producerSourceTokens, contextLimitTokens, maxOutputTokens } = input;
    if (
        typeof contextLimitTokens !== "number" ||
        !Number.isFinite(contextLimitTokens) ||
        contextLimitTokens <= 0 ||
        !Number.isFinite(producerSourceTokens) ||
        producerSourceTokens <= 0 ||
        !Number.isFinite(maxOutputTokens) ||
        maxOutputTokens < 0
    ) {
        return null;
    }
    const usableInputTokens = Math.max(0, Math.floor(contextLimitTokens - maxOutputTokens));
    const refusalThreshold = usableInputTokens * (1 + PRODUCER_WINDOW_REFUSAL_MARGIN);
    if (producerSourceTokens < refusalThreshold) return null;

    return `producer_source_exceeds_window producer_source_tokens=${Math.round(producerSourceTokens)} usable_input_tokens=${usableInputTokens} context_limit_tokens=${Math.round(contextLimitTokens)} max_output_tokens=${Math.round(maxOutputTokens)} refusal_margin=${PRODUCER_WINDOW_REFUSAL_MARGIN}`;
}
