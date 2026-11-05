export type ResolvedTransformMode = "ts" | "rust";

export interface ResolveTransformModeArgs {
    configured: ResolvedTransformMode;
    userTierHasSubc: boolean;
    compactionEnabled: boolean;
}

/**
 * Named boot refusal (assembly-v2 Unit 1, migration plan Task 4 Step 4,
 * spec §21 amendment): `transform_mode: "rust"` is shelved — the frozen
 * system-region lane serves unconditionally, and the Rust module composes its
 * own panel heads, so an active rust mode would double-serve from two
 * baselines (#2704). Every rust request resolves to `ts` with this warning;
 * there is no configuration that re-enables it on this product line. The
 * args stay in the signature so call sites and future revival keep their
 * shape; the resolver reads none of them.
 */
export const RUST_BOOT_REFUSAL_WARNING =
    "rust transform mode is refused at boot (frozen system-region lane; the Rust module is shelved) — running ts.";

export function resolveTransformMode(args: ResolveTransformModeArgs): {
    mode: ResolvedTransformMode;
    warnings: string[];
} {
    if (args.configured !== "rust") return { mode: "ts", warnings: [] };
    return {
        mode: "ts",
        warnings: [RUST_BOOT_REFUSAL_WARNING],
    };
}
