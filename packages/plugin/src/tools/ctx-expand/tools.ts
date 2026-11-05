import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { getLastCompartmentEndMessage } from "../../features/magic-context/compartment-storage";
import type { ContextDatabase } from "../../features/magic-context/storage";
import { readSessionChunk } from "../../hooks/magic-context/read-session-chunk";
import type { ToolExpansionMap } from "../../shared/historian-tool-template";
import { unwrapImitatedReducedArgs } from "../unwrap-imitated-reduced-args";
import { CTX_EXPAND_DESCRIPTION, CTX_EXPAND_TOKEN_BUDGET, stampWithdrawnLine } from "./constants";
import { resolveCtxExpandMode } from "./mode";
import { renderItemByTag, renderMessageByOrdinal, renderVerboseRange } from "./render";
import type { CtxExpandArgs } from "./types";
import { withdrawStampsForOrdinals, withdrawStampsForTags } from "./withdraw";

export { CTX_EXPAND_LIGHT_DESCRIPTION } from "../light-descriptions";

export interface CtxExpandToolDeps {
    db: ContextDatabase;
    expandTools?: ToolExpansionMap;
}

const ctxExpandArgsShape = {
    start: tool.schema
        .number()
        .optional()
        .describe(
            "First message ordinal of the range (a <session-history> heading's start, a ctx_search hit, or a ctx_reduce echo), not a tag number.",
        ),
    end: tool.schema
        .number()
        .optional()
        .describe("Last message ordinal of the range, inclusive, not a tag number."),
    verbose: tool.schema
        .boolean()
        .optional()
        .describe(
            "With start/end: one entry per message with ordinal and per-part preview instead of the transcript.",
        ),
    message: tool.schema
        .number()
        .optional()
        .describe(
            "Message ordinal from a <session-history> heading, a ctx_search hit, or a ctx_reduce echo. Returns that one message in full. Use alone.",
        ),
};
// The tool definition exposes only the documented argument shape to the model
// provider, but older callers may still send extra arguments. Parse with
// passthrough so execute() can receive those fields without advertising them.
const ctxExpandArgsSchema = tool.schema.object(ctxExpandArgsShape).passthrough();

/** One canonical line per revoked slot, appended after the recovery text. */
function appendWithdrawLines(text: string, withdrawn: readonly number[]): string {
    if (withdrawn.length === 0) return text;
    return `${text}\n\n${withdrawn.map((slot) => stampWithdrawnLine(slot)).join("\n")}`;
}

function createCtxExpandTool(deps: CtxExpandToolDeps): ToolDefinition {
    return tool({
        description: CTX_EXPAND_DESCRIPTION,
        args: ctxExpandArgsShape,
        async execute(rawArgs: CtxExpandArgs, toolContext) {
            const parsedArgs = ctxExpandArgsSchema.safeParse(rawArgs);
            let args = (parsedArgs.success ? parsedArgs.data : rawArgs) as CtxExpandArgs;
            args = unwrapImitatedReducedArgs(args, ["tag", "message", "start"], {
                start: "number",
                end: "number",
                verbose: "boolean",
                message: "number",
            });
            const sessionId = toolContext.sessionID;
            const mode = resolveCtxExpandMode(args, "positive");
            if (mode.kind === "error") {
                return mode.message;
            }
            if (mode.kind === "tag") {
                const withdrawn = withdrawStampsForTags(deps.db, sessionId, [mode.tag]);
                return appendWithdrawLines(
                    renderItemByTag(deps.db, sessionId, mode.tag),
                    withdrawn,
                );
            }
            if (mode.kind === "message") {
                const withdrawn = withdrawStampsForOrdinals(
                    deps.db,
                    sessionId,
                    mode.message,
                    mode.message,
                );
                return appendWithdrawLines(
                    renderMessageByOrdinal(sessionId, mode.message),
                    withdrawn,
                );
            }
            const { start, end, verbose } = mode;

            // Clamp the range to the last compartment boundary, mirroring
            // ctx_search: anything after that boundary is the live tail the
            // agent already sees in context, so re-reading it just burns output
            // tokens and duplicates visible content. -1 means "no compartments
            // yet" → nothing is compacted, so don't clamp.
            const lastCompartmentEnd = getLastCompartmentEndMessage(deps.db, sessionId);
            if (lastCompartmentEnd >= 0 && start > lastCompartmentEnd) {
                // The live tail is exactly where a held, not-yet-landed stamp
                // sits, so the early return still revokes the queue row.
                const withdrawn = withdrawStampsForOrdinals(deps.db, sessionId, start, end);
                return appendWithdrawLines(
                    `Range ${start}-${end} is entirely within the live tail (after the last compacted message ${lastCompartmentEnd}); those messages are already visible in context.`,
                    withdrawn,
                );
            }
            const effectiveEnd = lastCompartmentEnd >= 0 ? Math.min(end, lastCompartmentEnd) : end;
            const withdrawn = withdrawStampsForOrdinals(deps.db, sessionId, start, effectiveEnd);

            // Verbose mode: each message separate, with ids + per-part previews.
            if (verbose) {
                const v = renderVerboseRange(
                    sessionId,
                    start,
                    effectiveEnd,
                    CTX_EXPAND_TOKEN_BUDGET,
                    deps.expandTools,
                );
                if (!v.text) {
                    return appendWithdrawLines(
                        `No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`,
                        withdrawn,
                    );
                }
                const out = [
                    `Messages ${start}-${v.lastOrdinal} (verbose). Recover any one in full with ctx_expand(message=<ordinal>):`,
                    "",
                    v.text,
                ];
                if (v.truncated) {
                    out.push(
                        "",
                        `Truncated at message ${v.lastOrdinal} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${v.lastOrdinal + 1} end=${effectiveEnd} verbose=true for more.`,
                    );
                }
                return appendWithdrawLines(out.join("\n"), withdrawn);
            }

            const chunk = readSessionChunk(
                sessionId,
                CTX_EXPAND_TOKEN_BUDGET,
                start,
                effectiveEnd + 1, // readSessionChunk uses exclusive end
                { expand: false },
            );

            if (!chunk.text || chunk.messageCount === 0) {
                return appendWithdrawLines(
                    `No messages found in range ${start}-${effectiveEnd}. The range may be outside this session's history.`,
                    withdrawn,
                );
            }

            const lines: string[] = [];
            lines.push(
                `Messages ${chunk.startIndex}-${chunk.endIndex} (${chunk.messageCount} messages, ~${chunk.tokenEstimate} tokens):`,
            );
            lines.push("");
            lines.push(chunk.text);

            if (chunk.endIndex < effectiveEnd) {
                lines.push("");
                lines.push(
                    `Truncated at message ${chunk.endIndex} (budget: ~${CTX_EXPAND_TOKEN_BUDGET} tokens). Call again with start=${chunk.endIndex + 1} end=${effectiveEnd} for more.`,
                );
            }

            return appendWithdrawLines(lines.join("\n"), withdrawn);
        },
    });
}

export function createCtxExpandTools(deps: CtxExpandToolDeps): Record<string, ToolDefinition> {
    return {
        ctx_expand: createCtxExpandTool(deps),
    };
}
