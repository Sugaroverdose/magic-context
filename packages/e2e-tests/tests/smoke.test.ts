/// <reference types="bun-types" />

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { TestHarness } from "../src/harness";

/**
 * Phase 1 smoke — verifies the harness is wired correctly:
 *   mock server reachable, opencode serve runs with isolated config, plugin loads
 *   from source, a prompt reaches the mock and returns, and the plugin initializes
 *   its SQLite DB.
 */

let h: TestHarness;

beforeAll(async () => {
    h = await TestHarness.create();
});

afterAll(async () => {
    await h.dispose();
});

describe("e2e smoke", () => {
    it("mock server and opencode serve are reachable", () => {
        expect(h.opencode.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    });

    it("sends a prompt, mock captures it, plugin initializes its DB", async () => {
        h.mock.reset();
        h.mock.setDefault({
            text: "response from mock",
            usage: {
                input_tokens: 100,
                output_tokens: 20,
                cache_creation_input_tokens: 100,
                cache_read_input_tokens: 0,
            },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "hi there");

        // Mock captured at least one request.
        const requests = h.mock.requests();
        expect(requests.length).toBeGreaterThanOrEqual(1);

        // Request body carries our text.
        const first = requests[0]!;
        const messages = first.body.messages as Array<{ role: string; content: unknown }>;
        expect(Array.isArray(messages)).toBe(true);
        expect(messages.length).toBeGreaterThan(0);
        expect(JSON.stringify(messages)).toContain("hi there");

        // Plugin created its DB and ran the transform (at least one tag persisted).
        await h.waitFor(() => h.hasContextDb(), { timeoutMs: 5000, label: "context.db created" });
        await h.waitFor(() => h.countTags(sessionId) > 0, {
            timeoutMs: 5000,
            label: "tags persisted",
        });
        expect(h.countTags(sessionId)).toBeGreaterThan(0);
    }, 60_000);
});
