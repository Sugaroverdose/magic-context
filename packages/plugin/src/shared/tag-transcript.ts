/**
 * Harness-agnostic tagging over the Transcript interface.
 *
 * This is a deliberately minimal alternative to the OpenCode-specific
 * `tag-messages.ts` that operates on `MessageLike[]`. The OpenCode flow
 * carries 380+ lines of accumulated complexity:
 *
 *   - source-content persistence (for cross-pass detag/restore behavior),
 *   - tool-call indexing across separate "tool" and "tool_result" parts,
 *   - reasoning-byte tracking for historian projection,
 *   - file-part stable IDs,
 *   - existing-tag resolver with content-id fallback.
 *
 * Most of that is OpenCode-specific (cache stability across multi-pass
 * transforms, AI SDK part-id semantics, file part shapes). Pi's
 * `pi.on("context", ...)` fires once per LLM call with a complete
 * `AgentMessage[]`, so the cache-stability machinery doesn't apply and
 * we can use a much simpler tagging contract:
 *
 *   1. Walk the transcript in order.
 *   2. For each tag-eligible part (text, tool_use, tool_result), assign
 *      a tag number via the shared `Tagger`.
 *   3. Inject `§N§ ` prefix into the visible text (unless skipped).
 *   4. Build a `TagTarget` so `applyPendingOperations` from
 *      `apply-operations.ts` can replace this part with a sentinel when
 *      a queued drop fires.
 *
 * What's deliberately NOT here:
 *
 * - **Source-content persistence**. OpenCode needs it because parts can
 *   get re-tagged across cache-busting and cache-safe passes; Pi has
 *   no such pass distinction. If we ever need to "untag" or "restore
 *   original content" on Pi, we'd add it then.
 *
 * - **Tool-call indexing across split parts**. OpenCode separates
 *   `type:"tool"` (assistant invocation) from `type:"tool_result"` (next
 *   user message). Pi keeps tool calls inside the assistant message
 *   (kind: "tool_use") and tool results in separate ToolResultMessage
 *   entries surfaced as `kind: "tool_result"` parts via the adapter.
 *   We tag them independently — the historian/drop logic uses tag IDs
 *   not call IDs.
 *
 * - **Reasoning byte projection**. Pressure projection still works in
 *   the simplified Pi path; it just uses byteSize of the part text
 *   directly rather than splitting reasoning out separately.
 *
 * - **Recent reduce-call detection / commit detection**. Those are
 *   nudge-suppression heuristics. Pi's nudges land in 4b.4; for now
 *   we return `false` for both flags.
 *
 * Reuses unchanged from the OpenCode path:
 *
 *   - `Tagger` (DB-backed counter + assignment store).
 *   - `applyPendingOperations` (operates on `Map<number, TagTarget>`).
 *   - `applyFlushedStatuses` (same).
 *   - Tag prefix primitives (`prependTag`, `stripTagPrefix`, `byteSize`).
 *
 * Step 4b.2 ships this module + Pi `pi.on("context", ...)` wire-up.
 * Step 4b.3 builds the historian trigger on top of the same TagTargets.
 */

import type { ContextDatabase } from "../features/magic-context/storage";
import type { Tagger } from "../features/magic-context/tagger";
import { byteSize, prependTag } from "../hooks/magic-context/tag-content-primitives";
import type { TagTarget } from "../hooks/magic-context/tag-messages";
import type { Transcript, TranscriptPart } from "./transcript";

export interface TagTranscriptOptions {
    /**
     * When true, skip injecting `§N§` prefix into visible text. Tags
     * still get assigned in the DB so historian/drops can reference
     * them; the agent just doesn't see the markers. Used when
     * `ctx_reduce_enabled: false` (agent has no `ctx_reduce` tool to
     * act on the markers). Cache-safe because skip behavior is
     * consistent across passes.
     */
    skipPrefixInjection?: boolean;
}

export interface TagTranscriptResult {
    targets: Map<number, TagTarget>;
}

/**
 * Tag eligible parts of a transcript and build TagTargets for them.
 *
 * "Eligible" means: parts that contribute meaningfully to the LLM input
 * and whose content can be replaced when dropped. Specifically:
 *
 *   - text parts (user or assistant): tagged as type "message", inject
 *     prefix into the visible text, target supports setContent.
 *   - thinking parts: NOT tagged. Reasoning content has provider-
 *     specific signed-content semantics (Anthropic redacted_thinking,
 *     etc.) and replacing them mid-conversation breaks signature
 *     verification. The historian's clear-reasoning pass handles them
 *     separately if needed.
 *   - tool_use parts (assistant tool invocations): tagged as type
 *     "tool", target supports drop/truncate via the tag-content
 *     primitives.
 *   - tool_result parts (folded into user messages by the Pi adapter):
 *     tagged as type "tool", paired with the corresponding invocation
 *     for full-pair drops.
 *   - image, file, structural, unknown: skipped.
 *
 * The contentId we pass to the tagger uses the part's stable id when
 * available, otherwise a synthetic locator. Pi's adapter exposes:
 *   - tool_use parts: id = ToolCall.id (from pi-ai)
 *   - tool_result parts: id = ToolResultMessage.toolCallId
 *   - text parts: id = undefined → we synthesize from message+ordinal
 */
export function tagTranscript(
    sessionId: string,
    transcript: Transcript,
    tagger: Tagger,
    db: ContextDatabase,
    options: TagTranscriptOptions = {},
): TagTranscriptResult {
    const skipPrefixInjection = options.skipPrefixInjection === true;
    const targets = new Map<number, TagTarget>();

    db.transaction(() => {
        for (let msgIndex = 0; msgIndex < transcript.messages.length; msgIndex += 1) {
            const message = transcript.messages[msgIndex];
            if (message === undefined) continue;
            const messageId = message.info.id;

            let textOrdinal = 0;

            for (let partIndex = 0; partIndex < message.parts.length; partIndex += 1) {
                const part = message.parts[partIndex];
                if (part === undefined) continue;

                if (part.kind === "text") {
                    // Synthetic message ids (Pi tail synthetic user with
                    // no id) cannot be tagged — there's no stable handle
                    // to bind a tag to across passes. Pass through
                    // untagged; this is rare (only happens for the
                    // dangling tool-result tail case in Pi).
                    if (messageId === undefined) {
                        textOrdinal += 1;
                        continue;
                    }
                    tagTextPart({
                        sessionId,
                        message,
                        messageId,
                        msgIndex,
                        textOrdinal,
                        part,
                        tagger,
                        db,
                        targets,
                        skipPrefixInjection,
                    });
                    textOrdinal += 1;
                    continue;
                }

                if (part.kind === "tool_use" || part.kind === "tool_result") {
                    if (messageId === undefined) continue;
                    tagToolPart({
                        sessionId,
                        message,
                        messageId,
                        msgIndex,
                        partIndex,
                        part,
                        tagger,
                        db,
                        targets,
                        skipPrefixInjection,
                    });
                }
                // thinking, image, file, structural, unknown → skip.
            }
        }
    })();

    return { targets };
}

interface TagTextPartArgs {
    sessionId: string;
    message: { info: { id?: string; role: string } };
    messageId: string;
    msgIndex: number;
    textOrdinal: number;
    part: TranscriptPart;
    tagger: Tagger;
    db: ContextDatabase;
    targets: Map<number, TagTarget>;
    skipPrefixInjection: boolean;
}

function tagTextPart(args: TagTextPartArgs): void {
    const text = args.part.getText() ?? "";
    const contentId = `${args.messageId}:p${args.textOrdinal}`;
    const tagId = args.tagger.assignTag(
        args.sessionId,
        contentId,
        "message",
        byteSize(text),
        args.db,
    );

    if (!args.skipPrefixInjection) {
        args.part.setText(prependTag(tagId, text));
    }

    args.targets.set(tagId, buildTextTarget(args.part, args.message));
}

interface TagToolPartArgs {
    sessionId: string;
    message: { info: { id?: string; role: string } };
    messageId: string;
    msgIndex: number;
    partIndex: number;
    part: TranscriptPart;
    tagger: Tagger;
    db: ContextDatabase;
    targets: Map<number, TagTarget>;
    skipPrefixInjection: boolean;
}

function tagToolPart(args: TagToolPartArgs): void {
    // Prefer the part's stable id (tool call id from Pi/OpenCode); fall
    // back to a synthetic locator. Tool calls and their results MAY
    // share an id (Pi sets toolCallId on ToolResultMessage to match the
    // originating ToolCall.id); when that happens, both tag operations
    // resolve to the same tag number — desired behavior, since drops
    // target the call-id pair as a unit.
    const stableId = args.part.id;
    const contentId = stableId ?? `${args.messageId}:t${args.partIndex}`;
    const text = args.part.getText() ?? "";
    const meta = args.part.getToolMetadata();
    const tagId = args.tagger.assignTag(
        args.sessionId,
        contentId,
        "tool",
        byteSize(text),
        args.db,
        0,
        meta.toolName ?? null,
        meta.inputByteSize,
    );

    // For tool parts, the visible payload is the tool result text. We
    // can inject the tag prefix into it for in-text references; this
    // matches the OpenCode behavior of tagging tool outputs.
    if (!args.skipPrefixInjection && args.part.kind === "tool_result") {
        const tagged = prependTag(tagId, text);
        args.part.setText(tagged);
    }

    args.targets.set(tagId, buildToolTarget(args.part, args.message));
}

/**
 * TagTarget for a tag-eligible text part. The shared
 * `applyPendingOperations` flow calls `setContent` to swap in a
 * sentinel like `[dropped §N§]` when a queued drop fires; `getContent`
 * returns the current visible text so the truncated-preview path can
 * compute its before/after.
 *
 * The `message.info.role` is used by `buildReplacementContent` in
 * `apply-operations.ts` to differentiate user-message drops (which
 * preserve a truncated preview) from assistant drops (full sentinel).
 */
function buildTextTarget(
    part: TranscriptPart,
    message: { info: { id?: string; role: string } },
): TagTarget {
    return {
        setContent(content: string): boolean {
            return part.setText(content);
        },
        getContent(): string | null {
            return part.getText() ?? null;
        },
        // `message` is typed as MessageLike, which has parts: unknown[].
        // We don't carry parts here (the apply-operations flow only
        // reads `info.role` on this field), so a minimal stub is
        // sufficient.
        message: {
            info: { id: message.info.id, role: message.info.role },
            parts: [],
        },
    };
}

/**
 * TagTarget for a tag-eligible tool part. Tool parts get full-drop
 * (replace with `[dropped §N§]`) or truncated-drop (replace with
 * `[truncated]`) treatment from `applyFlushedStatuses` based on the
 * stored `drop_mode` column. We expose both via the standard target
 * surface; replaceWithSentinel is the canonical mutation, with
 * truncated-drop using the "[truncated]" string.
 */
function buildToolTarget(
    part: TranscriptPart,
    message: { info: { id?: string; role: string } },
): TagTarget {
    return {
        setContent(content: string): boolean {
            return part.setToolOutput(content) || part.setText(content);
        },
        getContent(): string | null {
            return part.getText() ?? null;
        },
        drop(): "removed" | "absent" {
            // Replace the tool part's visible content with a "[dropped]"
            // shell. We can't physically remove the part because Pi
            // requires tool_use ↔ tool_result pairing for the LLM call
            // to validate; instead we shrink the content to a sentinel.
            // For Pi the current Transcript contract treats both
            // invocation and result parts symmetrically — both expose
            // setText / setToolOutput.
            const replaced = part.replaceWithSentinel(`[dropped \u00a7${part.id ?? "?"}\u00a7]`);
            return replaced ? "removed" : "absent";
        },
        truncate(): "truncated" | "absent" {
            // Truncate the tool output to a fixed sentinel string. Done
            // via setToolOutput so the underlying tool_result content
            // gets the truncation; falls back to setText for cases
            // where the part type doesn't support setToolOutput.
            const ok = part.setToolOutput("[truncated]") || part.setText("[truncated]");
            return ok ? "truncated" : "absent";
        },
        message: {
            info: { id: message.info.id, role: message.info.role },
            parts: [],
        },
    };
}
