// Age-based removal of whole reasoning parts for providers other than
// canonical Anthropic.
//
// Canonical Anthropic keeps its older lane (clearOldReasoning writes
// "[cleared]", stripClearedReasoning swaps in an empty sentinel that OpenCode's
// Anthropic adapter drops). Other adapters would send "[cleared]" or an empty
// block as content, and on OpenAI Responses the encrypted reasoning payload
// lives in the part's provider metadata, so rewriting text would not shrink
// the request at all. This lane removes the whole part instead, together with
// any provider metadata it carries.
//
// Cache contract: new message ids are selected only on a pass that already
// rebuilds the provider cache and are persisted before any byte changes. Every
// pass, defer passes included, splices exactly the persisted set at final
// representation, after every lane that addresses parts by index has run.

import { isRecord } from "../../shared/record-type-guard";
import { makeWholeMessageSentinel } from "./sentinel";
import { findLatestAssistantReasoningMutationExemptMessage } from "./strip-content";
import type { MessageLike } from "./tag-messages";

const REMOVABLE_REASONING_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

function isReasoningPart(part: unknown): boolean {
    return isRecord(part) && REMOVABLE_REASONING_TYPES.has(String(part.type));
}

/**
 * True when the message keeps something the model provider will receive after
 * its reasoning is gone: non-empty visible text, a tool call, or a file.
 * Without that, removal would leave an empty assistant message, which some
 * adapters send as-is.
 */
function hasWireContentBesideReasoning(message: MessageLike): boolean {
    return message.parts.some((part) => {
        if (!isRecord(part) || part.ignored === true) return false;
        if (part.type === "tool" || part.type === "file") return true;
        return part.type === "text" && typeof part.text === "string" && part.text.trim() !== "";
    });
}

function newestAssistant(messages: MessageLike[]): MessageLike | undefined {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index].info.role === "assistant") return messages[index];
    }
    return undefined;
}

/**
 * Pick assistant message ids whose reasoning should be removed on this
 * rebuilding pass. Pure; the caller persists the result before applying it.
 *
 * A message qualifies when its tag is at most `maxTag - clearReasoningAge`, it
 * carries a reasoning part, it is not the newest assistant (nor the newest one
 * with replayable content), and it keeps wire content after removal.
 *
 * With `prefixBound` (models whose signed thinking is bound to the request
 * prefix), the walk stops at the first reasoning-bearing assistant that is
 * neither already removed nor eligible, so the removed set stays a contiguous
 * oldest prefix and never leaves an older block behind a removed newer one.
 */
export function selectReasoningRemovals(args: {
    messages: MessageLike[];
    messageTagNumbers: Map<MessageLike, number>;
    clearReasoningAge: number;
    alreadyRemoved: ReadonlySet<string>;
    prefixBound: boolean;
}): string[] {
    let maxTag = 0;
    for (const tag of args.messageTagNumbers.values()) if (tag > maxTag) maxTag = tag;
    const cutoff = maxTag - args.clearReasoningAge;
    if (maxTag === 0 || cutoff <= 0) return [];

    const newest = newestAssistant(args.messages);
    const exempt = findLatestAssistantReasoningMutationExemptMessage(args.messages);
    const selected: string[] = [];
    for (const message of args.messages) {
        if (message.info.role !== "assistant") continue;
        if (!message.parts.some(isReasoningPart)) continue;
        const id = message.info.id;
        if (typeof id === "string" && args.alreadyRemoved.has(id)) continue;
        const tag = args.messageTagNumbers.get(message) ?? 0;
        const eligible =
            typeof id === "string" &&
            id.length > 0 &&
            message !== newest &&
            message !== exempt &&
            tag > 0 &&
            tag <= cutoff &&
            hasWireContentBesideReasoning(message);
        if (eligible) {
            selected.push(id);
        } else if (args.prefixBound) {
            break;
        }
    }
    return selected;
}

/**
 * Splice every reasoning part out of the assistant messages named in `ids`.
 * Runs on every pass. The persisted set is replayed unconditionally, so a
 * removed block never returns, even if a revert later makes its message the
 * newest one. When an earlier drop has already emptied a message, a
 * whole-message placeholder keeps it from being sent empty.
 */
export function removeReasoningParts(
    messages: MessageLike[],
    ids: ReadonlySet<string>,
    providerID: string | undefined,
): number {
    if (ids.size === 0) return 0;
    let removed = 0;
    for (const message of messages) {
        if (message.info.role !== "assistant") continue;
        const id = message.info.id;
        if (typeof id !== "string" || !ids.has(id)) continue;
        const before = message.parts.length;
        const kept = message.parts.filter((part) => !isReasoningPart(part));
        if (kept.length === before) continue;
        removed += before - kept.length;
        message.parts.length = 0;
        message.parts.push(...kept);
        if (!hasWireContentBesideReasoning(message)) {
            message.parts.push(makeWholeMessageSentinel(providerID));
        }
    }
    return removed;
}
