/**
 * The frozen system-region lane is an install-time CAPABILITY, not a config
 * surface (owner rulings: 2026-11-03 the `system_region.enabled` switch is
 * dead; 2026-11-05 assembly-v2 Unit 1 the predicate is a pure constant — no
 * compaction-off arm, no transform-mode arm). Recovery is rollback, never a
 * config flip. One decider, computed once per handler boot, then threaded as
 * a boolean — no per-site re-derivation (L0 spirit).
 *
 * The parameter is accepted for call-site shape stability only; the body
 * reads nothing (pinned by system-region-lane-law.test.ts). Serving lanes:
 * every OpenCode 1/2 and Pi boot. `transform_mode: "rust"` never reaches
 * this predicate as a serving mode: the config-resolution funnel converts it
 * to a named boot refusal before the lane is consulted (transform-mode.ts).
 * The Rust module composes its own panel heads (no sentinel concept in
 * crates/), so serving region bytes from the TS side while the module is
 * active would double-serve from two baselines (#2704).
 */
export function isSystemRegionLane(_config?: unknown): boolean {
    return true;
}
