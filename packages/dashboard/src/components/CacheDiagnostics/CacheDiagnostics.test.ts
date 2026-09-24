import { describe, expect, test } from "bun:test";
import type { SessionCacheStats } from "../../lib/types";
import { cacheHarnessOptions, cacheSessionTitle, cacheSessionVisible } from "./CacheDiagnostics";

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
});
