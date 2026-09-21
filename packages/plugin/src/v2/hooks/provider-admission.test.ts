import { expect, test } from "bun:test";
import { refusesBeforeProvider } from "./provider-admission";

const RAW = 100_000;

const admission = (overrides: Partial<Parameters<typeof refusesBeforeProvider>[0]> = {}) =>
    refusesBeforeProvider({
        inputTokens: 0,
        rawContextLimit: RAW,
        hostCompactionReducedUsage: false,
        ...overrides,
    });

test("a request inside the provider window at 95% is refused", () => {
    expect(admission({ inputTokens: 95_000 })).toBe(true);
});

test("a request well under the provider window is admitted", () => {
    expect(admission({ inputTokens: 40_000 })).toBe(false);
});

test("crossing only the reply reserve is admitted so the transform can run the historian", () => {
    // 90k is 90% of the provider window, but 98% of the 91,808 tokens left once
    // room for the reply is taken out. Magic Context answers that pressure by
    // compacting history on this very pass, which needs the pass admitted.
    expect(admission({ inputTokens: 90_000 })).toBe(false);
});

test("usage already past the provider window is admitted so the overflow can be observed", () => {
    // Refusing here would strand the session: nothing shrinks the history, and
    // the provider's own overflow error — the only place the real window is
    // reported — is never received.
    expect(admission({ inputTokens: 388_000 })).toBe(false);
});

test("a model the catalog has no window for is admitted", () => {
    expect(admission({ inputTokens: 388_000, rawContextLimit: undefined })).toBe(false);
});

test("a host compaction newer than the measured reply admits one request", () => {
    // The tokens being judged were recorded before the host shrank the history,
    // so one request goes out to produce a current reading.
    expect(admission({ inputTokens: 96_000, hostCompactionReducedUsage: true })).toBe(false);
});
