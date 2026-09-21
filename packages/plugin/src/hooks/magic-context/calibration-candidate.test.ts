import { expect, it } from "bun:test";
import { CalibrationCandidates } from "./calibration-candidate";
import { calibrationForModelKey } from "./decision-calibration";

it("candidate EMA remains inactive at N=2 and N=3 and deduplicates correlated completions", () => {
    const tracker = new CalibrationCandidates();
    const seed = calibrationForModelKey("anthropic/claude-fable-5-1");
    const capture = (requestId: string) =>
        tracker.capture({
            harness: "test",
            sessionId: "s",
            requestId,
            seed,
            rawTokens: 100,
            complete: true,
            systemObserved: true,
            systemLocal: 10,
        });
    capture("a");
    expect(
        tracker.complete({
            harness: "test",
            sessionId: "s",
            modelKey: seed.modelKey,
            requestId: "a",
            responseId: "ra",
            providerInput: 150,
            completedAt: 1,
        }).ema,
    ).toBe(1.5);
    capture("b");
    expect(
        tracker.complete({
            harness: "test",
            sessionId: "s",
            modelKey: seed.modelKey,
            requestId: "b",
            responseId: "rb",
            providerInput: 200,
            completedAt: 2,
        }),
    ).toMatchObject({ ema: 1.625, n: 2 });
    capture("c");
    expect(
        tracker.complete({
            harness: "test",
            sessionId: "s",
            modelKey: seed.modelKey,
            requestId: "c",
            responseId: "rc",
            providerInput: 100,
            completedAt: 3,
        }),
    ).toMatchObject({ ema: 1.46875, n: 3 });
    expect(
        tracker.complete({
            harness: "test",
            sessionId: "s",
            modelKey: seed.modelKey,
            requestId: "c",
            responseId: "rc",
            providerInput: 100,
            completedAt: 3,
        }).n,
    ).toBe(3);
    expect(calibrationForModelKey(seed.modelKey).proseRatio).toBe(1.571778);
});

it("partial observations and ambiguous overlapping attempts cannot increase N", () => {
    const tracker = new CalibrationCandidates();
    const seed = calibrationForModelKey("anthropic/claude-fable-5-2");
    const capture = {
        harness: "test",
        sessionId: "s",
        requestId: "a",
        seed,
        rawTokens: 100,
        complete: true,
        systemObserved: false,
        systemLocal: 10,
    };
    expect(tracker.capture(capture).source).toBe("family-fallback");
    tracker.capture(capture);
    tracker.observeSystem("test", "s", seed.modelKey, 20);
    expect(
        tracker.complete({
            harness: "test",
            sessionId: "s",
            modelKey: seed.modelKey,
            requestId: "a",
            responseId: "ra",
            providerInput: 150,
            completedAt: 1,
        }),
    ).toMatchObject({ n: 0, completeness: "partial" });
});

it("fresh system capture replaces the old count and model records remain isolated", () => {
    const tracker = new CalibrationCandidates();
    const seed = calibrationForModelKey("anthropic/claude-fable-5-1");
    tracker.capture({
        harness: "test",
        sessionId: "s",
        requestId: "a",
        seed,
        rawTokens: 100,
        complete: true,
        systemObserved: false,
        systemLocal: 10,
    });
    tracker.observeSystem("test", "s", seed.modelKey, 30);
    const sample = tracker.complete({
        harness: "test",
        sessionId: "s",
        modelKey: seed.modelKey,
        requestId: "a",
        responseId: "ra",
        providerInput: 180,
        completedAt: 1,
    });
    expect(sample).toMatchObject({ sample: 1.5, n: 1, completeness: "complete" });
    expect(
        tracker.complete({
            harness: "test",
            sessionId: "other",
            modelKey: seed.modelKey,
            requestId: "a",
            responseId: "ra",
            providerInput: 180,
            completedAt: 1,
        }).n,
    ).toBe(0);
});

it("rejects stale, invalid, aborted and restart-unmatched responses without pooling routes", () => {
    const tracker = new CalibrationCandidates();
    const seed = calibrationForModelKey("anthropic/claude-fable-5-1");
    const base = {
        harness: "test",
        sessionId: "s",
        seed,
        rawTokens: 100,
        complete: true,
        systemObserved: true,
        systemLocal: 10,
    };
    tracker.capture({ ...base, requestId: "older" });
    tracker.capture({ ...base, requestId: "newer" });
    const response = {
        harness: "test",
        sessionId: "s",
        modelKey: seed.modelKey,
        requestId: "newer",
        responseId: "rn",
        providerInput: 200,
        completedAt: 2,
    };
    expect(tracker.complete(response)).toMatchObject({ n: 1, ema: 2 });
    expect(
        tracker.complete({ ...response, requestId: "older", responseId: "ro", completedAt: 1 }).n,
    ).toBe(1);
    tracker.capture({ ...base, requestId: "bad" });
    expect(
        tracker.complete({
            ...response,
            requestId: "bad",
            responseId: "rb",
            providerInput: Number.NaN,
            completedAt: 3,
        }).n,
    ).toBe(1);
    tracker.capture({ ...base, requestId: "aborted" });
    expect(
        tracker.complete({
            ...response,
            requestId: "aborted",
            responseId: "ra",
            failed: true,
            completedAt: 4,
        }).n,
    ).toBe(1);
    expect(new CalibrationCandidates().complete(response).n).toBe(0);
    expect(
        tracker.complete({
            ...response,
            modelKey: "openrouter/anthropic/claude-fable-5-1",
            responseId: "route",
        }).n,
    ).toBe(0);
});
