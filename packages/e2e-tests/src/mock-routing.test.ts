import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { assertHistorianMockRouting, assertMockEndpoint, pinMockAgents } from "./mock-routing";

describe("mock child-agent routing", () => {
  it("pins omitted and blank models without enabling the dreamer", () => {
    expect(pinMockAgents({ historian: { model: "", disable: true } }, "mock/main")).toEqual({
      historian: { opencode: { model: "mock/main" }, disable: true },
      dreamer: { opencode: { model: "mock/main" }, disable: true },
    });
  });

  it("rejects off-mock primary, harness-specific and fallback child models", () => {
    for (const historian of [
      { model: "anthropic/real" },
      { opencode: { model: "anthropic/real" } },
      { fallback_models: ["anthropic/real"] },
    ]) {
      expect(() => pinMockAgents({ historian }, "mock/main")).toThrow("must use mock model");
    }
  });

  it("rejects a real provider endpoint even when a mock model name is used", () => {
    expect(() =>
      assertMockEndpoint("https://api.anthropic.com/v1", "http://127.0.0.1:1234"),
    ).toThrow("Off-mock provider endpoint");
    expect(() =>
      assertMockEndpoint("https://api.anthropic.com/v1", "https://api.anthropic.com/v1"),
    ).toThrow("expected loopback");
    assertMockEndpoint("http://127.0.0.1:1234", "http://127.0.0.1:1234");
  });

  it("rejects an external historian attempt even after successful mock fallback", () => {
    const db = new Database(":memory:");
    try {
      db.exec(
        "CREATE TABLE subagent_invocations (harness TEXT, subagent TEXT, provider_id TEXT, model_id TEXT)",
      );
      db.exec(
        "INSERT INTO subagent_invocations VALUES ('opencode', 'historian', 'anthropic', 'claude-fable-5-1'), ('opencode', 'historian', 'mock-anthropic', 'mock-sonnet')",
      );
      expect(() =>
        assertHistorianMockRouting(db, "opencode", "mock-anthropic/mock-sonnet"),
      ).toThrow("Off-mock historian request");
      db.exec("DELETE FROM subagent_invocations WHERE provider_id = 'anthropic'");
      assertHistorianMockRouting(db, "opencode", "mock-anthropic/mock-sonnet");
    } finally {
      db.close();
    }
  });
});
