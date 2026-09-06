import { expect, test } from "bun:test";
import {
    PRODUCER_WINDOW_REFUSAL_MARGIN,
    producerWindowFailureReason,
} from "./producer-window-guard";

const maxOutputTokens = 1_000;
const usableInputTokens = 10_000;
const contextLimitTokens = usableInputTokens + maxOutputTokens;

test("producer source at 2x the usable window is refused with machine-readable numbers", () => {
    const reason = producerWindowFailureReason({
        producerSourceTokens: usableInputTokens * 2,
        contextLimitTokens,
        maxOutputTokens,
    });

    expect(PRODUCER_WINDOW_REFUSAL_MARGIN).toBe(0.15);
    expect(reason).toBe(
        "producer_source_exceeds_window producer_source_tokens=20000 usable_input_tokens=10000 context_limit_tokens=11000 max_output_tokens=1000 refusal_margin=0.15",
    );
});

test("producer source at 1.05x the usable window is admitted", () => {
    expect(
        producerWindowFailureReason({
            producerSourceTokens: usableInputTokens * 1.05,
            contextLimitTokens,
            maxOutputTokens,
        }),
    ).toBeNull();
});

test("unknown producer windows do not refuse", () => {
    expect(
        producerWindowFailureReason({
            producerSourceTokens: 1_000_000,
            maxOutputTokens,
        }),
    ).toBeNull();
});
