import { describe, expect, test } from "bun:test";

import { DREAMER_AGENT } from "../agents/dreamer";
import { HISTORIAN_AGENT } from "../agents/historian";
import { SIDEKICK_AGENT } from "../agents/sidekick";
import { parseProviderModel, resolveFallbackChain } from "./resolve-fallbacks";

describe("resolveFallbackChain", () => {
    test("returns builtin chain when user provides nothing", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, undefined);
        // Builtin DREAMER_FALLBACK_CHAIN expands to multiple provider/model entries.
        expect(chain.length).toBeGreaterThan(2);
        // Every entry must be in "provider/model" form.
        for (const entry of chain) {
            expect(entry.indexOf("/")).toBeGreaterThan(0);
        }
    });

    test("returns builtin chain for empty string", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, "");
        expect(chain.length).toBeGreaterThan(0);
    });

    test("returns builtin chain for empty array", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, []);
        expect(chain.length).toBeGreaterThan(0);
    });

    test("user-only when user provides valid fallback_models string", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, "anthropic/claude-sonnet-4-6");
        expect(chain).toEqual(["anthropic/claude-sonnet-4-6"]);
    });

    test("user-only when user provides valid fallback_models array", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, [
            "anthropic/claude-sonnet-4-6",
            "google/gemini-3-flash",
        ]);
        expect(chain).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]);
    });

    test("dedupes user-provided list", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, [
            "anthropic/claude-sonnet-4-6",
            "anthropic/claude-sonnet-4-6",
            "google/gemini-3-flash",
        ]);
        expect(chain).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]);
    });

    test("strips invalid 'provider/model' entries", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, [
            "anthropic/claude-sonnet-4-6",
            "no-slash-here",
            "/leading-slash",
            "trailing-slash/",
            "",
            "  ",
        ]);
        expect(chain).toEqual(["anthropic/claude-sonnet-4-6"]);
    });

    test("trims whitespace in user entries", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, [
            "  anthropic/claude-sonnet-4-6  ",
            "\tgoogle/gemini-3-flash\n",
        ]);
        expect(chain).toEqual(["anthropic/claude-sonnet-4-6", "google/gemini-3-flash"]);
    });

    test("returns empty array for unknown agent with no user fallbacks", () => {
        const chain = resolveFallbackChain("unknown-agent", undefined);
        expect(chain).toEqual([]);
    });

    test("returns user fallbacks for unknown agent when provided", () => {
        const chain = resolveFallbackChain("unknown-agent", ["foo/bar"]);
        expect(chain).toEqual(["foo/bar"]);
    });

    test("HISTORIAN_AGENT has builtin chain", () => {
        const chain = resolveFallbackChain(HISTORIAN_AGENT, undefined);
        expect(chain.length).toBeGreaterThan(0);
    });

    test("SIDEKICK_AGENT has builtin chain", () => {
        const chain = resolveFallbackChain(SIDEKICK_AGENT, undefined);
        expect(chain.length).toBeGreaterThan(0);
    });

    test("user-only policy: builtin not appended even if user set short list", () => {
        const chain = resolveFallbackChain(DREAMER_AGENT, ["anthropic/claude-sonnet-4-6"]);
        expect(chain).toEqual(["anthropic/claude-sonnet-4-6"]);
        // Confirm length is exactly 1, not user+builtin
        expect(chain.length).toBe(1);
    });
});

describe("parseProviderModel", () => {
    test("parses standard provider/model", () => {
        expect(parseProviderModel("anthropic/claude-sonnet-4-6")).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("handles model id with slashes (only splits on first slash)", () => {
        expect(parseProviderModel("lemonade/GLM-4.7-Flash-GGUF/main")).toEqual({
            providerID: "lemonade",
            modelID: "GLM-4.7-Flash-GGUF/main",
        });
    });

    test("trims whitespace", () => {
        expect(parseProviderModel("  anthropic/claude-sonnet-4-6  ")).toEqual({
            providerID: "anthropic",
            modelID: "claude-sonnet-4-6",
        });
    });

    test("returns null for no slash", () => {
        expect(parseProviderModel("anthropic")).toBeNull();
    });

    test("returns null for leading slash", () => {
        expect(parseProviderModel("/claude-sonnet-4-6")).toBeNull();
    });

    test("returns null for trailing slash", () => {
        expect(parseProviderModel("anthropic/")).toBeNull();
    });

    test("returns null for empty string", () => {
        expect(parseProviderModel("")).toBeNull();
    });
});
