export interface TagEntry {
    tagNumber: number;
    messageId: string;
    type: "message" | "tool" | "file";
    status: "active" | "dropped" | "compacted";
    /**
     * How a dropped tag is rendered on every replay pass (frozen at drop
     * time, re-derived deterministically from the original wire part each pass):
     *  - "full": the RELEASED shape — the pair keeps its block structure, the
     *    arguments become an FPE token carrier in the copy-source seat and the
     *    result slot is empty (TOOL_RELEASED_SENTINEL). A model copying this
     *    call re-emits the token; the tool.execute.before resolver runs the
     *    original input. Deterministic in tag id + session key.
     *  - "erased": the pair leaves the wire (a model stamp's removal intent;
     *    the host store keeps the real bytes, so each pass removes again).
     *  - "skeleton_real": keep the tool_use call with its REAL arguments,
     *    output -> "". Used for small inputs dropped inside the newest-call
     *    window and for the call whose result ends the request.
     *  - "truncated": legacy skeleton; new drops never persist it, and replay
     *    normalizes it to the "full" released shape.
     *  - "edit_marker": like "truncated" but for an edit/write superseded by a
     *    later edit to the same file; keep the filePath verbatim and a short
     *    region-hint prefix of the diff, so the agent still sees WHICH file and
     *    region it edited. Only produced when the smart_drops config is on.
     *  - "message_empty" / "message_filler": message-drop render shape,
     *    frozen at apply — "" on routes measured to accept empty dropped
     *    content (role-gated), the canonical `[dropped §N§]` placeholder
     *    elsewhere. Only message tags carry these; replay never re-decides.
     *    (Adjudicated against ARCHITECTURE invariant 2: the filler keeps the
     *    single canonical placeholder string; the lineage's constant filler
     *    variant is not shipped — census addendum Unit 5.)
     */
    dropMode:
        | "full"
        | "erased"
        | "truncated"
        | "skeleton_real"
        | "skeleton_stripped"
        | "edit_marker"
        | "edit_marker_stripped"
        | "message_empty"
        | "message_filler";
    toolName: string | null;
    inputByteSize: number;
    byteSize: number;
    reasoningByteSize: number;
    sessionId: string;
    /**
     * Caveman compression depth applied to this tag's text part. 0 = none,
     * 1 = lite, 2 = full, 3 = ultra. Only meaningful for `type: "message"`;
     * tool/file tags stay at 0. Used by experimental age-tier caveman
     * heuristic to avoid re-compressing text that already matches the
     * target depth for its age band.
     */
    cavemanDepth: number;
    /**
     * For `type: "tool"` tags: the assistant message id where the
     * underlying tool call was invoked. Identity for a tool tag is the
     * triple `(sessionId, messageId/callID, toolOwnerMessageId)` —
     * including this field disambiguates collisions when OpenCode's
     * per-turn callID counter produces the same id across turns.
     *
     * NULL on:
     *   - all `type: "message"` and `type: "file"` tags (not applicable)
     *   - legacy tool tags written before plugin v0.16.x (the
     *     tag-owner-fix migration v10). The runtime lazily adopts these
     *     orphan rows on first observation; backfill populates them at
     *     plugin startup against the OpenCode DB.
     *
     * See plan v3.3.1 in `.alfonso/plans/tag-owner-fix-plan.md`.
     */
    toolOwnerMessageId: string | null;
}

export interface PendingOp {
    id: number;
    sessionId: string;
    tagId: number;
    /**
     * Queue provenance — the queue has no author column, so this value is the
     * only record of who asked: "drop" = model stamp (ctx_reduce tool lanes;
     * apply erases), "auto_drop" = compartment runner (a system actor; apply
     * uses sweeper shapes and preserves ctx_reduce receipts).
     */
    operation: "drop" | "auto_drop";
    queuedAt: number;
}

export interface SessionMeta {
    sessionId: string;
    lastResponseTime: number;
    cacheTtl: string;
    counter: number;
    lastNudgeTokens: number;
    lastNudgeBand: "far" | "near" | "urgent" | "critical" | null;
    lastTransformError: string | null;
    isSubagent: boolean;
    lastContextPercentage: number;
    lastInputTokens: number;
    observedSafeInputTokens: number;
    cacheAlertSent: boolean;
    timesExecuteThresholdReached: number;
    compartmentInProgress: boolean;
    systemPromptHash: string;
    systemPromptTokens: number;
    conversationTokens: number;
    toolCallTokens: number;
    clearedReasoningThroughTag: number;
    toolReclaimWatermark: number;
    lastTodoState: string;
    cachedM0Bytes: Buffer | null;
    /** Frozen image payload paired atomically with cachedM0Bytes. */
    cachedM0MuralDataUrl: string | null;
    cachedM0MuralHash: string | null;
    cachedM1Bytes: Buffer | null;
    cachedM0ProjectMemoryEpoch: number | null;
    cachedM0WorkspaceFingerprint: string | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    cachedM0MaxMemoryId: number | null;
    /**
     * Pi message stable-id scheme version (Pi-only; OpenCode ignores it).
     * NULL/0 = legacy index-based `pi-msg-*` ids; >=1 = real-SessionEntry-id
     * scheme. Drives the one-time forced execute+materialize cutover when a
     * session's stored scheme is below PI_STABLE_ID_SCHEME.
     */
    piStableIdScheme: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0MaxMemoryMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    /** HARD-bust markers: provider-side cache-eviction signals (system/tools/model). */
    cachedM0SystemHash: string | null;
    cachedM0ToolSetHash: string | null;
    cachedM0ModelKey: string | null;
    /** Pi-only HARD marker: project identity captured in the cached m[0] baseline. */
    cachedM0ProjectIdentity: string | null;
    /**
     * Unit 2 volatile delta segment (region-only migration Task 1): bytes
     * served after the region at the tail of system[0], rendered against the
     * region row named by `cachedM0MaterializedAt`. null = nothing pending.
     */
    regionVolatileBytes: Buffer | null;
    regionVolatileWatermark: number;
    lastObservedModelKey: string | null;
    lastUsageContextLimit: number;
    priorBoundaryOrdinal: number;
    protectedTailPolicyVersion: number;
    protectedTailDrainWindowStartedAt: number;
    protectedTailDrainTokens: number;
    recoveryNoEligibleHeadCount: number;
    forceEmergencyBypassWindowStart: number;
    forceEmergencyBypassUsed: number;
    /** Set only after an explicit OpenCode dialog choice; keeps the fresh dialog dismissed. */
    upgradeRemindedAt: number | null;
    /** Most recent push reminder delivery, used for the bounded re-notification cooldown. */
    upgradeReminderLastSentAt: number | null;
    /** Total delivered upgrade reminders; the hard cap prevents an endless nag loop. */
    upgradeReminderCount: number;
}

export type SchedulerDecision = "execute" | "defer";

export interface ContextUsage {
    percentage: number;
    inputTokens: number;
}
