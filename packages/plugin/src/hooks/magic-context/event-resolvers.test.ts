import { describe, expect, it } from "bun:test";
import {
    resolveCacheTtl,
    resolveContextLimit,
    resolveExecuteThreshold,
    resolveModelKey,
    resolveSessionId,
} from "./event-resolvers";

describe("event-resolvers", () => {
    describe("resolveContextLimit", () => {
        // resolveContextLimit reads from getModelsDevContextLimit (which overlays
        // opencode.json custom provider limits on top of the models.dev cache).
        // The tests below validate the fallback-to-default path. The models.dev
        // integration is covered by models-dev-cache tests.

        it("resolves anthropic context from models.dev when available", () => {
            //#when — models.dev may return 200K (real limit) or 128K (default if no models.json)
            const limit = resolveContextLimit("anthropic", "claude-opus-4-5");

            //#then — should NOT be 1M; uses models.dev real limit or conservative default
            expect(limit).toBeLessThanOrEqual(200_000);
            expect(limit).toBeGreaterThan(0);
        });

        it("returns default for missing provider", () => {
            //#when
            const limit = resolveContextLimit(undefined, "gpt-4o");

            //#then
            expect(limit).toBe(128_000);
        });

        it("returns default for unknown provider/model not in models.dev or opencode.json", () => {
            //#when
            const limit = resolveContextLimit("unknown-provider", "unknown-model-xyz");

            //#then
            expect(limit).toBe(128_000);
        });
    });

    describe("resolveCacheTtl", () => {
        it("returns direct string ttl for string config", () => {
            //#when
            const ttl = resolveCacheTtl("5m", "openai/gpt-4o");

            //#then
            expect(ttl).toBe("5m");
        });

        it("resolves provider/model and bare-model overrides", () => {
            //#given
            const cacheTtl = {
                default: "5m",
                "openai/gpt-4o": "1m",
                "gpt-4o-mini": "2m",
            };

            //#when
            const providerModel = resolveCacheTtl(cacheTtl, "openai/gpt-4o");
            const bareModel = resolveCacheTtl(cacheTtl, "openai/gpt-4o-mini");

            //#then
            expect(providerModel).toBe("1m");
            expect(bareModel).toBe("2m");
        });
    });

    describe("resolveExecuteThreshold", () => {
        it("returns direct number config unchanged (after max cap)", () => {
            expect(resolveExecuteThreshold(50, "openai/gpt-5.4-fast", 65)).toBe(50);
            expect(resolveExecuteThreshold(50, undefined, 65)).toBe(50);
        });

        it("caps any resolved value at 80%", () => {
            expect(resolveExecuteThreshold(95, "openai/gpt-4o", 65)).toBe(80);
            expect(
                resolveExecuteThreshold({ default: 95, "openai/gpt-4o": 90 }, "openai/gpt-4o", 65),
            ).toBe(80);
        });

        it("prefers exact provider/model key when present", () => {
            //#given — user wrote the derived key
            const config = { default: 65, "openai/gpt-5.4-fast": 25 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then
            expect(result).toBe(25);
        });

        it("falls back to base model key when user wrote base (no derived)", () => {
            //#given — user wrote base key, runtime is derived (e.g., -fast variant)
            const config = { default: 65, "openai/gpt-5.4": 25 };

            //#when — modelKey is the derived form
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then — should match "openai/gpt-5.4" after suffix strip
            expect(result).toBe(25);
        });

        it("prefers most-specific match when both derived and base configured", () => {
            //#given — user wrote BOTH keys, want derived to win
            const config = {
                default: 65,
                "openai/gpt-5.4-fast": 20,
                "openai/gpt-5.4": 40,
            };

            //#when
            const derived = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);
            const base = resolveExecuteThreshold(config, "openai/gpt-5.4", 65);

            //#then
            expect(derived).toBe(20);
            expect(base).toBe(40);
        });

        it("matches bare model id (no provider prefix) in config", () => {
            //#given — user wrote just the model id without provider
            const config = { default: 65, "gpt-5.4-fast": 25 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then
            expect(result).toBe(25);
        });

        it("matches bare base model id for derived runtime model", () => {
            //#given
            const config = { default: 65, "gpt-5.4": 30 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-5.4-fast", 65);

            //#then
            expect(result).toBe(30);
        });

        it("returns config.default when no keys match", () => {
            //#given
            const config = { default: 55, "anthropic/claude-opus-4-6": 40 };

            //#when
            const result = resolveExecuteThreshold(config, "openai/gpt-4o", 65);

            //#then
            expect(result).toBe(55);
        });

        it("returns fallback when config.default absent and no match", () => {
            //#given
            const config = { default: 0, "anthropic/claude-opus-4-6": 40 } as unknown as {
                default: number;
                [key: string]: number;
            };
            // Simulate missing default by deleting
            // biome-ignore lint/performance/noDelete: test setup requires actual missing key
            delete (config as Record<string, unknown>).default;

            //#when
            const result = resolveExecuteThreshold(
                config as { default: number; [key: string]: number },
                "openai/gpt-4o",
                65,
            );

            //#then
            expect(result).toBe(65);
        });

        it("returns config.default when modelKey is undefined", () => {
            //#given
            const config = { default: 42, "openai/gpt-5.4-fast": 25 };

            //#when
            const result = resolveExecuteThreshold(config, undefined, 65);

            //#then — undefined modelKey hits the no-model branch, not the per-model lookup
            expect(result).toBe(42);
        });
    });

    describe("resolveModelKey", () => {
        it("returns provider/model when both parts exist", () => {
            expect(resolveModelKey("openai", "gpt-4o")).toBe("openai/gpt-4o");
        });

        it("returns undefined when either part is missing", () => {
            expect(resolveModelKey(undefined, "gpt-4o")).toBeUndefined();
            expect(resolveModelKey("openai", undefined)).toBeUndefined();
        });
    });

    describe("resolveSessionId", () => {
        it("prefers properties.sessionID when present", () => {
            const sessionId = resolveSessionId({
                sessionID: "ses-direct",
                info: { id: "ses-info" },
            });
            expect(sessionId).toBe("ses-direct");
        });

        it("falls back to info.sessionID and info.id", () => {
            expect(resolveSessionId({ info: { sessionID: "ses-info" } })).toBe("ses-info");
            expect(resolveSessionId({ info: { id: "ses-id" } })).toBe("ses-id");
        });
    });
});
