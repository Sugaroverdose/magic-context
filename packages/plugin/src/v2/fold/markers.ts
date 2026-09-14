import type { CompactionMarkerStrategy } from "../../hooks/magic-context/transform-postprocess-phase";

/** The v2 host owns its checkpoint rows; v1 marker writes and draft replay are inert. */
export const v2CompactionMarkerStrategy: CompactionMarkerStrategy = {
    applyDeferred: () => ({ kind: "already-current" }),
    reconcile: () => false,
};
