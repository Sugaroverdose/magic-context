import { describe, expect, test } from "bun:test";
import type { DbCacheEvent, SessionCacheStats } from "../../lib/types";
import {
  cacheEventPercentage,
  cacheHarnessOptions,
  cachePercentage,
  cacheRatioTitle,
  cacheSessionRatio,
  cacheSessionTitle,
  cacheSessionVisible,
} from "./CacheDiagnostics";

const brocaRow: SessionCacheStats = {
  harness: "broca",
  session_id: '{"project_root":"/tmp/project","harness":"opencode","session":"mc-historian:one"}',
  event_count: 2,
  total_cache_read: 120,
  total_cache_write: 40,
  total_input: 20,
  hit_ratio: 2 / 3,
  last_timestamp: "2026-01-01T00:00:00Z",
  last_activity_ms: 1,
  bust_count: 0,
  managed: true,
  is_subagent: false,
  title: "mc-historian:one",
};

function event(partial: Partial<DbCacheEvent>): DbCacheEvent {
  return {
    harness: "broca",
    message_id: "m",
    session_id: "s",
    timestamp: 1,
    input_tokens: 10,
    cache_read: 0,
    cache_write: 0,
    cache_reported: true,
    total_tokens: 10,
    hit_ratio: 0,
    severity: "full_bust",
    cause: null,
    agent: null,
    turn_id: "t",
    is_turn_start: false,
    context_limit: 0,
    context_limit_estimated: false,
    is_drop: false,
    aggregate: false,
    cold_start: false,
    cache_write_reported: true,
    ...partial,
  };
}

describe("cache reporting", () => {
  test("unreported event is neutral without a percentage", () => {
    expect(cacheEventPercentage(event({ cache_reported: false }))).toBe(
      "No cached tokens reported",
    );
  });

  test("reported zero retains its existing percentage", () => {
    expect(cacheEventPercentage(event({ cache_reported: true }))).toBe("0.0%");
  });

  test("mixed session scores only reported events", () => {
    const ratio = cacheSessionRatio([
      event({ cache_reported: false, input_tokens: 1000 }),
      event({ cache_read: 80, input_tokens: 20 }),
    ]);
    expect(ratio).toBe(0.8);
    expect(cachePercentage(ratio)).toBe("80.0%");
  });

  test("all-unreported session card has neutral text rather than red zero", () => {
    const ratio = cacheSessionRatio([event({ cache_reported: false })]);
    expect(ratio).toBeNull();
    expect(cachePercentage(ratio)).toBe("No cached tokens reported");
  });
});

describe("Broca cache sessions", () => {
  test("filter includes Broca and managed session rows keep their title", () => {
    expect(cacheHarnessOptions).toContainEqual({ value: "broca", label: "Broca" });
    expect(cacheSessionVisible(brocaRow, "broca", false, true)).toBe(true);
    expect(cacheSessionVisible(brocaRow, "pi", false, true)).toBe(false);
    expect(cacheSessionTitle(brocaRow)).toBe("mc-historian:one");
  });

  test("unmanaged Broca rows require the unmanaged toggle", () => {
    const unmanaged = { ...brocaRow, managed: false };
    expect(cacheSessionVisible(unmanaged, "broca", false, true)).toBe(false);
    expect(cacheSessionVisible(unmanaged, "broca", true, true)).toBe(true);
  });

  test("a run aggregate shows its own cached share and explains it", () => {
    const run = event({
      aggregate: true,
      severity: "aggregate",
      input_tokens: 993,
      cache_read: 114_560,
      hit_ratio: 114_560 / 115_553,
    });
    expect(cacheEventPercentage(run)).toBe("99.1%");
    expect(cacheRatioTitle(run)).toContain("whole run");
  });

  test("a cold first request explains that nothing was cached yet", () => {
    expect(cacheRatioTitle(event({ cold_start: true }))).toContain("First request");
  });
});
