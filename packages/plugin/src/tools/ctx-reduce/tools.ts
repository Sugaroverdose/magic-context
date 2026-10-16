import { createHash } from "node:crypto";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import {
    getProtectionWindowForSession,
    type ProtectionWindowResult,
} from "../../features/magic-context/protection-window";
import { parseRangeString } from "../../features/magic-context/range-parser";
import {
    classifyMessageTag,
    type ReduceInputOutcome,
    releasedMessageHandles,
    resolveBulkDefault,
    resolveIds,
    resolveSamples,
} from "../../features/magic-context/reduce-resolver";
import {
    getOrCreateSessionMeta,
    getPendingOps,
    getTagsBySession,
    queuePendingOp,
    updateSessionMeta,
} from "../../features/magic-context/storage";
import { getInertWhitespaceAssistantTags } from "../../features/magic-context/storage-tags";
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
    drop: tool.schema
        .string()
        .optional()
        .describe('Tag IDs to drop: "3-5", "1,2,9", "1-5,8,12-15".'),
    ids: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
            "Call ids of tool calls to release, copied exactly from the calls as they appear in context.",
        ),
    samples: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe(
            "Quote a contiguous run of the item's own text, copied exactly — not reworded, not shortened with ellipses.",
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

    /** One apply event: route the released set through the active backend. */
    const applyReleasedTags = async (
        invokeContext: { sessionID: string; directory: string },
        tagNumbers: readonly number[],
    ): Promise<{ refused?: string; deduped: boolean }> => {
        const sessionId = invokeContext.sessionID;
        const rustReduce = deps.rustToolBackends?.reduce;
        if (rustReduce) {
            try {
                const response = await rustReduce({
                    sessionId,
                    projectRoot: invokeContext.directory,
                    drop: tagNumbers.join(","),
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
                    return { refused: renderCapabilityRefusal("context_cleanup"), deduped: false };
                }
                return {
                    deduped: typeof record.queued === "number" && record.queued === 0,
                };
            } catch {
                return { refused: renderCapabilityRefusal("context_cleanup"), deduped: false };
            }
        }
        try {
            const now = Date.now();
            deps.db
                .transaction(() => {
                    for (const tagNumber of tagNumbers) {
                        queuePendingOp(deps.db, sessionId, tagNumber, "drop", now);
                    }
                })
                .immediate();
        } catch (error) {
            return {
                refused: `Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
                deduped: false,
            };
        }
        return { deduped: false };
    };

    /** No-arg default: release everything already responded past. */
    const executeBulkRelease = async (invokeContext: {
        sessionID: string;
        directory: string;
    }): Promise<string> => {
        const sessionId = invokeContext.sessionID;
        const { protectedSet, inertTagNumbers } = resolveProtectionContext(sessionId);
        const result = resolveBulkDefault({
            db: deps.db,
            sessionId,
            protectedTagNumbers: protectedSet,
            inertTagNumbers,
        });
        if (result.releasedTagNumbers.length === 0) {
            const held = result.outcomes.some(
                (outcome) => outcome.kind === "refused" && outcome.reason === "protected",
            );
            return held
                ? "Nothing older to release; newer work is still protected."
                : "Nothing to release: no consumed tool output is waiting.";
        }
        const apply = await applyReleasedTags(invokeContext, result.releasedTagNumbers);
        if (apply.refused) {
            return apply.refused;
        }
        let handles = releasedMessageHandles(result);
        if (apply.deduped) {
            handles = [];
        } else {
            touchNudgeWatermark(sessionId);
        }
        const inert = result.outcomes.filter(
            (outcome) => outcome.kind === "refused" && outcome.reason === "provider-framing",
        ).length;
        const lines: string[] = [];
        if (handles.length > 0) {
            lines.push(`Released everything responded past: ${handles.join(", ")}.`);
        } else {
            lines.push("Already released: nothing left to do.");
        }
        if (inert > 0) {
            lines.push(`Ignored: ${inert} is provider framing, nothing to reclaim.`);
        }
        return lines.join(" ");
    };

    const executePointingLane = async (
        invokeContext: { sessionID: string; directory: string },
        rawIds: string[],
        rawSamples: string[],
    ): Promise<string> => {
        const sessionId = invokeContext.sessionID;
        const ids = [...new Set(rawIds.map((id) => id.trim()).filter((id) => id.length > 0))];
        const samples = rawSamples
            .map((sample) => sample.trim())
            .filter((sample) => sample.length > 0);
        if (ids.length === 0 && samples.length === 0) {
            return "Error: 'ids'/'samples' must contain entries.";
        }

        const { protectedSet, inertTagNumbers } = resolveProtectionContext(sessionId);

        // Samples resolve FIRST: ambiguity is the only batch-rejecting class
        // and the rejection must land before anything applies, so the forced
        // retry is application-free (one apply event per reduce intent).
        const sampleReleased: { tagNumber: number; messageId: string }[] = [];
        const sampleOutcomes: ReduceInputOutcome[] = resolveSamples(
            deps.db,
            sessionId,
            samples,
        ).map((outcome): ReduceInputOutcome => {
            if (outcome.kind === "matched") {
                const classified = classifyMessageTag(
                    {
                        db: deps.db,
                        sessionId,
                        protectedTagNumbers: protectedSet,
                        inertTagNumbers,
                    },
                    outcome,
                );
                if (classified.kind === "released") {
                    sampleReleased.push({
                        tagNumber: outcome.tagNumber,
                        messageId: outcome.messageId,
                    });
                }
                return classified;
            }
            if (outcome.kind === "ambiguous") {
                return { kind: "ambiguous", candidates: outcome.candidates };
            }
            return { kind: "no-match" };
        });
        const ambiguous = sampleOutcomes.find(
            (outcome): outcome is ReduceInputOutcome & { kind: "ambiguous" } =>
                outcome.kind === "ambiguous",
        );
        if (ambiguous) {
            const lines = [
                "Ambiguous: a sample matches more than one visible item — nothing was released.",
            ];
            for (const candidate of ambiguous.candidates) {
                lines.push(
                    `- ${candidate.messageId}: ${candidate.excerpt.length > 0 ? candidate.excerpt : "(see item)"}…`,
                );
            }
            lines.push("Copy a longer run and send the same batch again.");
            return lines.join("\n");
        }

        const result = resolveIds(
            {
                db: deps.db,
                sessionId,
                protectedTagNumbers: protectedSet,
                inertTagNumbers,
            },
            ids,
        );

        const releaseCounts = () => {
            let released = 0;
            let already = 0;
            let unknown = 0;
            let held = 0;
            let inert = 0;
            let noMatch = 0;
            for (const outcome of [...result.outcomes, ...sampleOutcomes]) {
                if (outcome.kind === "no-match") noMatch += 1;
                if (outcome.kind === "released") released += 1;
                else if (outcome.kind === "already_released") already += 1;
                else if (outcome.kind === "unknown") unknown += 1;
                else if (outcome.kind === "refused") {
                    if (outcome.reason === "protected") held += 1;
                    else inert += 1;
                }
            }
            return { released, already, unknown, held, inert, noMatch };
        };

        const queueNumbers = [
            ...new Set([...result.releasedTagNumbers, ...sampleReleased.map((r) => r.tagNumber)]),
        ];
        let sampleReleasedHandles = [...new Set(sampleReleased.map((r) => r.messageId))];

        if (queueNumbers.length > 0) {
            const apply = await applyReleasedTags(invokeContext, queueNumbers);
            if (apply.refused) {
                return apply.refused;
            }
            if (apply.deduped) {
                // Module-side dedupe beat the registry read: those inputs are
                // already released; report, do not echo.
                result.outcomes = result.outcomes.map((outcome) =>
                    outcome.kind === "released" ? { kind: "already_released" } : outcome,
                );
                sampleReleasedHandles = [];
                for (const outcome of sampleOutcomes) {
                    if (outcome.kind === "released") {
                        const mutable = outcome as { kind: string; messageId?: string };
                        mutable.kind = "already_released";
                        delete mutable.messageId;
                    }
                }
            }
            touchNudgeWatermark(sessionId);
        }

        const { released, already, unknown, held, inert, noMatch } = releaseCounts();
        const lines: string[] = [];
        const handles = releasedMessageHandles(result);
        if (handles.length > 0) {
            lines.push(`Released: ${handles.join(", ")}.`);
        } else if (released > 0) {
            lines.push(`Released: ${released}.`);
        }
        if (sampleReleasedHandles.length > 0) {
            lines.push(`Released from samples: ${sampleReleasedHandles.join(", ")}.`);
        }
        if (noMatch > 0) {
            lines.push(`No match: ${noMatch} sample(s) found nothing in your visible context.`);
        }
        if (already > 0) {
            lines.push(`Already released: ${already} input(s) — nothing left to do.`);
        }
        if (unknown > 0) {
            lines.push(`Unknown: ${unknown} input(s) match no call in this session.`);
        }
        if (held > 0) {
            lines.push(
                `Held: ${held} inside the protected working set; applies once newer work displaces it.`,
            );
        }
        if (inert > 0) {
            lines.push(`Ignored: ${inert} is provider framing, nothing to reclaim.`);
        }
        return lines.join(" ");
    };

    return tool({
        description: CTX_REDUCE_DESCRIPTION,
        args: ctxReduceArgsShape,
        async execute(rawArgs: CtxReduceArgs, toolContext) {
            const parsedArgs = ctxReduceArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxReduceArgs;
            args = unwrapImitatedReducedArgs(args, ["drop"], { drop: "string" });
            const sessionId = toolContext.sessionID;

            const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
            const hasSamples = Array.isArray(args.samples) && args.samples.length > 0;
            if ((hasIds || hasSamples) && args.drop) {
                return "Error: 'ids'/'samples' and 'drop' cannot be combined in one call.";
            }
            if (!hasIds && !hasSamples && !args.drop) {
                if ("drop" in args) {
                    return "Error: 'drop' must be a non-empty list of tag ids.";
                }
                return await executeBulkRelease(toolContext);
            }

            if (hasIds || hasSamples) {
                return await executePointingLane(
                    toolContext,
                    hasIds ? (args.ids as string[]) : [],
                    hasSamples ? (args.samples as string[]) : [],
                );
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
                    // The module owns range parsing and tag canonicalization. Keep the
                    // existing queued acknowledgement shape without reimplementing that
                    // parsing in the OpenCode tool.
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
                return `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""} ${heldSentence}`;
            }
            if (immediateDropIds.length > 0) {
                return `Queued: drop ${formatIds(immediateDropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}`;
            }
            if (heldSentence.length > 0) {
                return `${heldSentence}${skippedNote}${inertNote ? ` ${inertNote}` : ""}`;
            }
            return `Queued: drop ${formatIds(dropIds)}.${skippedNote}${inertNote ? ` ${inertNote}` : ""}`;
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
