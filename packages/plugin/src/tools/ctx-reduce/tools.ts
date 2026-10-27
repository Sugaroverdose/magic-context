import { createHash } from "node:crypto";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { createHostOrdinalMint } from "../../features/magic-context/message-ordinal-mint";
import {
    getProtectionWindowForSession,
    type ProtectionWindowResult,
} from "../../features/magic-context/protection-window";
import { parseRangeString } from "../../features/magic-context/range-parser";
import {
    type OrdinalMint,
    ordinalForRegistryKey,
    type ReduceInputOutcome,
    resolveBulkDefault,
    resolveHandles,
} from "../../features/magic-context/reduce-resolver";
import {
    MINT_UNAVAILABLE,
    renderBulkSuccess,
    renderPointingError,
    renderPointingSuccess,
    selfStampSentence,
} from "../../features/magic-context/reduce-response";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsByNumbers,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getInertWhitespaceAssistantTags } from "../../features/magic-context/storage-tags";
import {
    type CallIdTagResolver,
    createRegistryCallIdResolver,
} from "../../features/magic-context/tool-call-registry";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { getErrorMessage } from "../../shared/error-message";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { renderCapabilityRefusal } from "../../shared/user-facing-codes";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_REDUCE_DESCRIPTION } from "./constants";
import type { CtxReduceArgs } from "./types";

export { CTX_REDUCE_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxReduceToolDeps {
    db: Database;
    /**
     * Union projection form: protectedSet (tag-number set form).
     * Coordinate space: tag-number space.
     * Empty-window behavior: empty set means zero tool tags are protected by the window;
     * requested drops apply immediately, and non-tool tags are never reclaim targets.
     */
    protectedSet?: ReadonlySet<number> | ((sessionId: string) => ReadonlySet<number>);
    /** DI seam for the ids lane's wire-call-id -> registry pairing (tests). */
    callIdResolver?: CallIdTagResolver;
    /** DI seam for the canonical message-ordinal mint (tests). */
    ordinalMint?: OrdinalMint | ((sessionId: string) => OrdinalMint | undefined);
    getProtectionWindow?: (sessionId: string) => ProtectionWindowResult;
    floor?: number;
    getSessionTokens?: (sessionId: string) => number;
    rustToolBackends?: RustToolBackends;
}

function formatRawDropForAck(rawDrop: string): string {
    return rawDrop
        .trim()
        .split(",")
        .map((token) => {
            const trimmed = token.trim();
            return /^\d+$/.test(trimmed) ? `§${trimmed}§` : trimmed;
        })
        .join(", ");
}

const ctxReduceArgsShape = {
    // ctx_reduce v1 (Rev 5.3): the numeric 'drop' parameter is no longer
    // advertised to the model. The schema below is passthrough, so old-shaped
    // or imitated calls still reach execute() and the upstream numeric path
    // stays intact.
    ctx_handles: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
            "Exact targets of the stamp, copied from your context: a tool call id, the shortest phrase copied word-for-word from a message's text (prose — a tool call is released ONLY by its call id; its arguments and its output are never stamp identifiers, copy the id from the call) that only that one item on the desk matches, or a span of two such pointers joined by `..`.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxReduceArgsSchema = tool.schema.object(ctxReduceArgsShape).passthrough();

function createCtxReduceTool(deps: CtxReduceToolDeps): ToolDefinition {
    let fallbackCommandSequence = 0;

    const commandIdForInvocation = (sessionId: string, toolContext: unknown): string => {
        const context =
            toolContext !== null && typeof toolContext === "object"
                ? (toolContext as Record<string, unknown>)
                : {};
        const callId =
            (typeof context.callID === "string" && context.callID.trim()) ||
            (typeof context.callId === "string" && context.callId.trim());
        if (callId) {
            const stableId = `oc-${sessionId}-${callId}`;
            if (Buffer.byteLength(stableId) <= 128) return stableId;
            return `oc-${createHash("sha256").update(stableId).digest("hex")}`;
        }
        fallbackCommandSequence += 1;
        const monotonicId = `oc-${sessionId}-${fallbackCommandSequence}`;
        return Buffer.byteLength(monotonicId) <= 128
            ? monotonicId
            : `oc-${createHash("sha256").update(monotonicId).digest("hex")}`;
    };

    const resolveProtectionContext = (
        sessionId: string,
    ): {
        protectedSet: ReadonlySet<number>;
        inertTagNumbers: Set<number>;
    } => {
        let protectedSet: ReadonlySet<number>;
        if (deps.protectedSet) {
            protectedSet =
                typeof deps.protectedSet === "function"
                    ? deps.protectedSet(sessionId)
                    : deps.protectedSet;
        } else if (deps.getProtectionWindow) {
            protectedSet = deps.getProtectionWindow(sessionId).protectedTagNumbers;
        } else {
            protectedSet = getProtectionWindowForSession(
                deps.db,
                sessionId,
                deps.floor,
            ).protectedTagNumbers;
        }
        const inertTagNumbers = new Set(
            getInertWhitespaceAssistantTags(deps.db, sessionId).map((tag) => tag.tagNumber),
        );
        return { protectedSet, inertTagNumbers };
    };

    const touchNudgeWatermark = (sessionId: string) => {
        const currentInputTokens =
            deps.getSessionTokens?.(sessionId) ??
            getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
        updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });
    };

    const ordinalMintFor = (sessionId: string): OrdinalMint | undefined => {
        if (deps.ordinalMint) {
            return typeof deps.ordinalMint === "function"
                ? deps.ordinalMint(sessionId)
                : deps.ordinalMint;
        }
        return createHostOrdinalMint(deps.db, sessionId);
    };

    /** One apply event: route the released set through the active backend. */
    const applyReleasedTags = async (
        invokeContext: { sessionID: string; directory: string },
        tagNumbers: readonly number[],
    ): Promise<{ refused?: string; deduped: boolean; selfStamped: Set<number> }> => {
        const sessionId = invokeContext.sessionID;
        // Self-stamp refusal: ctx_reduce's own reports are housekeeping —
        // keep-count exemplars plus the aged strip clean them automatically.
        // Stamping one only burns a slot and hides the trail of what was
        // already released. Never reaches a backend.
        const numbers = [...new Set(tagNumbers)];
        const selfStamped = new Set(
            getTagsByNumbers(deps.db, sessionId, numbers)
                .filter((tag) => tag.toolName?.toLowerCase() === "ctx_reduce")
                .map((tag) => tag.tagNumber),
        );
        const queueable = numbers.filter((n) => !selfStamped.has(n));
        const rustReduce = deps.rustToolBackends?.reduce;
        if (rustReduce) {
            try {
                const response = await rustReduce({
                    sessionId,
                    projectRoot: invokeContext.directory,
                    drop: queueable.join(","),
                    commandId: commandIdForInvocation(sessionId, invokeContext),
                });
                const value =
                    response !== null && typeof response === "object" && "result" in response
                        ? (response as { result?: unknown }).result
                        : response;
                const record =
                    value !== null && typeof value === "object"
                        ? (value as Record<string, unknown>)
                        : null;
                if (record === null || record.ok !== true) {
                    return {
                        refused: renderCapabilityRefusal("context_cleanup"),
                        deduped: false,
                        selfStamped,
                    };
                }
                return {
                    deduped: typeof record.queued === "number" && record.queued === 0,
                    selfStamped,
                };
            } catch {
                return {
                    refused: renderCapabilityRefusal("context_cleanup"),
                    deduped: false,
                    selfStamped,
                };
            }
        }
        try {
            const now = Date.now();
            deps.db
                .transaction(() => {
                    for (const tagNumber of queueable) {
                        queuePendingOp(deps.db, sessionId, tagNumber, "drop", now);
                    }
                })
                .immediate();
        } catch (error) {
            return {
                refused: `Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
                deduped: false,
                selfStamped,
            };
        }
        return { deduped: false, selfStamped };
    };

    /** No-arg default: release everything already responded past. */
    const executeBulkRelease = async (invokeContext: {
        sessionID: string;
        directory: string;
    }): Promise<string> => {
        const sessionId = invokeContext.sessionID;
        const { protectedSet, inertTagNumbers } = resolveProtectionContext(sessionId);
        const mint = ordinalMintFor(sessionId);
        if (!mint) return MINT_UNAVAILABLE;
        const result = resolveBulkDefault({
            db: deps.db,
            sessionId,
            protectedTagNumbers: protectedSet,
            inertTagNumbers,
            mint,
        });
        if (result.releasedItems.length === 0) {
            return result.protectedItems.length > 0
                ? JSON.stringify({
                      note: "Nothing older to release; newer work is still protected.",
                  })
                : JSON.stringify({
                      note: "Nothing to release: no consumed tool output is waiting.",
                  });
        }
        const apply = await applyReleasedTags(
            invokeContext,
            result.releasedItems.map((item) => item.tagNumber),
        );
        if (apply.refused) {
            return apply.refused;
        }
        touchNudgeWatermark(sessionId);
        return renderBulkSuccess(
            apply.deduped,
            result.releasedItems,
            result.inertItems,
            result.protectedItems.length,
            mint,
            apply.selfStamped.size,
        );
    };

    const executePointingLane = async (
        invokeContext: { sessionID: string; directory: string },
        rawHandles: string[],
    ): Promise<string> => {
        const sessionId = invokeContext.sessionID;
        // Slot parity (review 2026-10-27): every sent entry keeps its slot in
        // the report — empty/blank entries are not filtered out, they resolve
        // to their own zero-token error. The mirror answers slot for slot.
        const handles = rawHandles.map((handle) => handle.trim());
        if (handles.length === 0) {
            return "Error: 'ctx_handles' must contain entries.";
        }

        const { protectedSet, inertTagNumbers } = resolveProtectionContext(sessionId);
        const mint = ordinalMintFor(sessionId);
        if (!mint) return MINT_UNAVAILABLE;

        // Validation completes BEFORE any enqueue: the batch resolves against
        // the registry without touching it; any error class rejects the whole
        // batch, so the forced retry is application-free (one apply event per
        // reduce intent, ≤1 contiguous cache divergence).
        const result = resolveHandles(
            {
                db: deps.db,
                sessionId,
                protectedTagNumbers: protectedSet,
                inertTagNumbers,
                callIdResolver:
                    deps.callIdResolver ?? createRegistryCallIdResolver(deps.db, sessionId),
                mint,
            },
            handles,
        );
        if (result.internalError) {
            return result.internalError;
        }

        const errors = result.outcomes.filter(
            (outcome): outcome is Extract<ReduceInputOutcome, { kind: "error" }> =>
                outcome.kind === "error",
        );
        if (errors.length > 0) {
            // S-4 ruling + 2026-10-22 Rev 6.1 amendment: a plain not-found OR
            // a plain ambiguous entry among resolvable siblings is a graceful
            // noop (siblings stamp, the slot reports). Loud whole-call failure
            // stays for: anything inside a RANGE entry — dead endpoints and
            // ambiguous endpoints alike (the span is a guess) — everything
            // failed (nothing stamped is the truth), and mint failure. The
            // loud path reports EVERY failing entry, grouped by class+note.
            const loud =
                errors.length === result.outcomes.length ||
                errors.some((outcome) => outcome.range !== undefined);
            if (loud) {
                return renderPointingError(errors);
            }
        }

        let selfStampedToReport: ReadonlySet<number> | undefined;
        if (result.queueTagNumbers.length > 0) {
            const apply = await applyReleasedTags(invokeContext, result.queueTagNumbers);
            if (apply.refused) {
                return apply.refused;
            }
            if (apply.selfStamped.size > 0) selfStampedToReport = apply.selfStamped;
            if (apply.deduped) {
                // Module-side dedupe beat the registry read: those inputs are
                // already released; report, do not claim a fresh release.
                const remap = (outcome: ReduceInputOutcome): ReduceInputOutcome =>
                    outcome.kind === "released" && !apply.selfStamped.has(outcome.tagNumber)
                        ? {
                              kind: "noop",
                              reason: "released",
                              tagNumber: outcome.tagNumber,
                              messageId: outcome.messageId,
                          }
                        : outcome;
                result.outcomes = result.outcomes.map((outcome) =>
                    outcome.kind === "range"
                        ? { ...outcome, items: outcome.items.map(remap) }
                        : remap(outcome),
                );
            }
            touchNudgeWatermark(sessionId);
        }

        return renderPointingSuccess(handles, result.outcomes, mint, selfStampedToReport);
    };

    return tool({
        description: CTX_REDUCE_DESCRIPTION,
        args: ctxReduceArgsShape,
        async execute(rawArgs: CtxReduceArgs, toolContext) {
            const parsedArgs = ctxReduceArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxReduceArgs;
            args = unwrapImitatedReducedArgs(args, ["drop"], { drop: "string" });
            const sessionId = toolContext.sessionID;

            const hasHandles = Array.isArray(args.ctx_handles) && args.ctx_handles.length > 0;
            if (hasHandles && args.drop) {
                return "Error: 'ctx_handles' and 'drop' cannot be combined in one call.";
            }
            if (!hasHandles && !args.drop) {
                if ("drop" in args) {
                    return "Error: 'drop' must be a non-empty list of tag ids.";
                }
                return await executeBulkRelease(toolContext);
            }

            if (hasHandles) {
                return await executePointingLane(toolContext, args.ctx_handles as string[]);
            }

            const dropArg = args.drop;
            if (!dropArg) {
                return "Error: 'drop' must be provided.";
            }

            const rustReduce = deps.rustToolBackends?.reduce;
            if (rustReduce) {
                try {
                    const response = await rustReduce({
                        sessionId,
                        projectRoot: toolContext.directory,
                        drop: dropArg,
                        commandId: commandIdForInvocation(sessionId, toolContext),
                    });
                    const value =
                        response !== null && typeof response === "object" && "result" in response
                            ? (response as { result?: unknown }).result
                            : response;
                    const record =
                        value !== null && typeof value === "object"
                            ? (value as Record<string, unknown>)
                            : null;
                    if (record === null || record.ok !== true) {
                        const error =
                            record && "error" in record
                                ? (record as { error?: unknown }).error
                                : undefined;
                        const errorRecord =
                            error !== null && typeof error === "object"
                                ? (error as { message?: unknown })
                                : undefined;
                        const message =
                            (typeof error === "string" && error.trim() ? error : undefined) ??
                            (typeof errorRecord?.message === "string" && errorRecord.message.trim()
                                ? errorRecord.message
                                : undefined) ??
                            (typeof record?.message === "string" && record.message.trim()
                                ? record.message
                                : "module rejected agent_drops.append");
                        sessionLog(sessionId, "ctx_reduce capability refusal", message);
                        return renderCapabilityRefusal("context_cleanup");
                    }
                    const queued = typeof record.queued === "number" ? record.queued : 0;
                    if (queued <= 0) {
                        return "All requested tags were already queued or processed. No new action is needed.";
                    }
                    // The module owns range parsing and tag canonicalization. Keep
                    // the existing queued acknowledgement shape without
                    // reimplementing that parsing in the OpenCode tool.
                    return `Queued: drop ${formatRawDropForAck(dropArg)}.`;
                } catch (error) {
                    sessionLog(sessionId, "ctx_reduce capability refusal", error);
                    return renderCapabilityRefusal("context_cleanup");
                }
            }

            let dropIds: number[] = [];

            try {
                dropIds = parseRangeString(dropArg);
            } catch (e) {
                return `Error: Invalid range syntax. ${(e as Error).message}`;
            }

            const allIds = [...new Set(dropIds)];

            const allTags = getTagsBySession(deps.db, sessionId);
            const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
            const unknownIds = allIds.filter((id) => !foundSet.has(id));
            if (unknownIds.length > 0) {
                return `Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`;
            }

            // Self-stamp refusal: ctx_reduce's own reports are housekeeping,
            // cleaned automatically (keep-count exemplars + aged strip).
            const ctxReduceSelfStampIds = new Set(
                allTags
                    .filter((tag) => tag.toolName?.toLowerCase() === "ctx_reduce")
                    .map((tag) => tag.tagNumber),
            );
            const ctxReduceSelfStampCount = new Set(
                dropIds.filter((id) => ctxReduceSelfStampIds.has(id)),
            ).size;
            dropIds = dropIds.filter((id) => !ctxReduceSelfStampIds.has(id));
            const selfStampNote =
                ctxReduceSelfStampCount > 0 ? ` ${selfStampSentence(ctxReduceSelfStampCount)}` : "";
            if (dropIds.length === 0 && ctxReduceSelfStampCount > 0) {
                return selfStampSentence(ctxReduceSelfStampCount);
            }

            // Form: protectedSet (tag-number set form). Coordinate space: tag-number space.
            // Empty-window behavior: empty set means zero tool tags are protected by the window;
            // non-tool tags never become reclaim targets.
            let protectedSet: ReadonlySet<number>;
            if (deps.protectedSet) {
                protectedSet =
                    typeof deps.protectedSet === "function"
                        ? deps.protectedSet(sessionId)
                        : deps.protectedSet;
            } else if (deps.getProtectionWindow) {
                protectedSet = deps.getProtectionWindow(sessionId).protectedTagNumbers;
            } else {
                protectedSet = getProtectionWindowForSession(
                    deps.db,
                    sessionId,
                    deps.floor,
                ).protectedTagNumbers;
            }

            const tagStatusMap = new Map(allTags.map((tag) => [tag.tagNumber, tag.status]));
            const inertWhitespaceTagNumbers = new Set(
                getInertWhitespaceAssistantTags(deps.db, sessionId).map((tag) => tag.tagNumber),
            );
            const inertDropIds = [
                ...new Set(dropIds.filter((id) => inertWhitespaceTagNumbers.has(id))),
            ];
            const inertNote =
                inertDropIds.length > 0
                    ? `Skipped: ${inertDropIds
                          .map((id) => `§${id}§ is provider framing, nothing to reclaim`)
                          .join("; ")}.`
                    : "";

            const pendingOps = getPendingOps(deps.db, sessionId);
            const pendingMap = new Map(pendingOps.map((op) => [op.tagId, op.operation]));

            const conflicts: string[] = [];
            for (const id of dropIds) {
                if (tagStatusMap.get(id) === "compacted" && !inertWhitespaceTagNumbers.has(id)) {
                    conflicts.push(`§${id}§ is from before compaction`);
                }
            }
            if (conflicts.length > 0) {
                return `Error: Conflicting operations — ${conflicts.join("; ")}.`;
            }

            const preFilterDropCount = dropIds.length;
            dropIds = dropIds.filter(
                (id) =>
                    !inertWhitespaceTagNumbers.has(id) &&
                    tagStatusMap.get(id) !== "dropped" &&
                    pendingMap.get(id) !== "drop",
            );
            const skippedCount = preFilterDropCount - dropIds.length;

            if (dropIds.length === 0) {
                return [
                    inertNote,
                    "All requested tags were already queued or processed. No new action is needed.",
                    ctxReduceSelfStampCount > 0 ? selfStampSentence(ctxReduceSelfStampCount) : "",
                ]
                    .filter(Boolean)
                    .join(" ");
            }

            try {
                deps.db
                    .transaction(() => {
                        const now = Date.now();
                        for (const id of dropIds) {
                            queuePendingOp(deps.db, sessionId, id, "drop", now);
                        }
                    })
                    .immediate();
            } catch (error) {
                const errorMessage = getErrorMessage(error);
                return `Error: Failed to queue ctx_reduce operations. ${errorMessage}`;
            }

            const currentInputTokens =
                deps.getSessionTokens?.(sessionId) ??
                getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
            updateSessionMeta(deps.db, sessionId, { lastNudgeTokens: currentInputTokens });

            const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
            const deferredDropIds = [...new Set(dropIds.filter((id) => protectedSet.has(id)))];
            const skippedNote =
                skippedCount > 0
                    ? ` ${skippedCount} requested tag${skippedCount === 1 ? " was" : "s were"} already queued and need no action.`
                    : "";

            let heldSentence = "";
            if (deferredDropIds.length === 1) {
                heldSentence = `Held: §${deferredDropIds[0]} is inside the protected working set; it applies once newer work displaces it.`;
            } else if (deferredDropIds.length > 1) {
                heldSentence = `Held: ${deferredDropIds.map((id) => `§${id}`).join(", ")} are inside the protected working set; they apply once newer work displaces them.`;
            }

            if (immediateDropIds.length > 0 && heldSentence.length > 0) {
                return `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""} ${heldSentence}${selfStampNote}`;
            }
            if (immediateDropIds.length > 0) {
                return `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}${selfStampNote}`;
            }
            if (heldSentence.length > 0) {
                return `${heldSentence}${skippedNote}${inertNote ? ` ${inertNote}` : ""}${selfStampNote}`;
            }
            return `Queued: drop ${formatIds(dropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}${selfStampNote}`;
        },
    });
}

function formatIds(ids: number[]): string {
    return ids.map((id) => `§${id}§`).join(", ");
}

export function createCtxReduceTools(deps: CtxReduceToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_reduce: createCtxReduceTool(deps),
    };
}
