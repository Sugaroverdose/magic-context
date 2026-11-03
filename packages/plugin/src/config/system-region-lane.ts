import { isCompactionEnabled } from "./agent-disable";

/**
 * The frozen system-region lane is an install-time CAPABILITY, not a config
 * surface (owner ruling 2026-11-03: the `system_region.enabled` switch is
 * dead — recovery is rollback, never a config flip). One decider, computed
 * once per handler boot from transformMode + compaction, then threaded as a
 * boolean — no per-site re-derivation (L0 spirit).
 *
 * The capability is the OpenCode-1 TypeScript lane: the Rust module composes
 * its own panel heads (no sentinel concept in crates/; appending the stored
 * region would double-serve from two baselines), the v2 adapter and Pi/OMP
 * boot their own surfaces that never call this predicate, and
 * compaction-off installs keep heads by the host-managed-window contract.
 * v2/Pi non-servitude is additionally pinned by boot logs and the C2 spy
 * laws.
 */
export function isSystemRegionLane(config: {
    transform_mode?: "ts" | "rust";
    compaction?: { enabled?: boolean } | false | null;
}): boolean {
    if (config.transform_mode === "rust") return false;
    if (config.compaction === false) return false;
    return isCompactionEnabled({ compaction: config.compaction ?? undefined });
}
