/**
 * Empty assistant wire guard (opencode-go "assistant must not be empty" 400).
 *
 * The opencode-go converter emits one provider assistant per step block of a
 * host assistant row, and content only from `text`/`reasoning` (non-empty) +
 * `tool_calls` from tool parts. A block whose only content is a zero-length
 * `reasoning`/`text` part — persisted when a kimi-class stream closes a
 * reasoning block with no tokens — therefore serializes as
 * `{"role":"assistant","content":"","reasoning_content":""}`, which strict
 * validators reject at a fixed position on EVERY later request; the host row
 * itself looks healthy (its second block carries the real prose), so no
 * whole-row emptiness check can see it. The provider-boundary capture of
 * 2026-10-25 (evidence: docs/reports/empty-assistant-wire-20261025/ in the
 * research repo) pinned exactly this shape.
 *
 * The law: a served array must never contain an assistant unit the converter
 * would render with no content — so before the array is served, drop empty
 * `text`/`reasoning` parts, drop step blocks that then contain nothing
 * provider-visible, and drop assistant messages left with nothing visible.
 * Invisible vocabulary mirrors the wrapper's ASSISTANT_METADATA_PART_TYPES
 * (keep the two sets in sync); anything unrecognized counts as visible — the
 * guard removes known poison shapes only, never speculative content.
 *
 * Import-free leaf, mutation in place (the served array identity must survive
 * — callers splice the same array they returned). Stats are returned for the
 * single diagnostic line at the wiring site.
 */

type GuardablePart = { type?: unknown; text?: unknown };

export type GuardableMessage = {
    info: { role?: unknown };
    parts: GuardablePart[];
};

const PROVIDER_INVISIBLE_TYPES = new Set([
    "step-start",
    "step-finish",
    "snapshot",
    "patch",
    "agent",
    "retry",
    "subtask",
    "compaction",
]);

function isProviderVisible(part: GuardablePart): boolean {
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text" || type === "reasoning") {
        return typeof part.text === "string" && part.text.length > 0;
    }
    return !PROVIDER_INVISIBLE_TYPES.has(type);
}
function opensStepBlock(part: GuardablePart): boolean {
    return part.type === "step-start";
}

function blockIsInvisible(block: readonly GuardablePart[]): boolean {
    return !block.some(isProviderVisible);
}

export interface EmptyAssistantWireGuardStats {
    removedMessages: number;
    strippedParts: number;
}

export function applyEmptyAssistantWireGuard(
    messages: GuardableMessage[],
): EmptyAssistantWireGuardStats {
    const stats: EmptyAssistantWireGuardStats = { removedMessages: 0, strippedParts: 0 };
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.info?.role !== "assistant") continue;
        const parts = message.parts;
        // A zero-part assistant is the pending-shell shape (issue #327 keeps
        // it for thinking-binding recovery; the host's live streaming row has
        // the same shape). It is an UNPROVEN converter poison — the captured
        // opencode-go killer always carried parts — so the guard leaves it
        // alone. Only parts-bearing rows the converter would render empty
        // (all blocks provider-invisible) are removed.
        if (!Array.isArray(parts) || parts.length === 0) continue;
        const kept: GuardablePart[] = [];
        let pendingBlock: GuardablePart[] = [];
        let blockOpened = false;
        const flushBlock = (): void => {
            if (!blockOpened) return;
            if (!blockIsInvisible(pendingBlock)) kept.push(...pendingBlock);
            pendingBlock = [];
            blockOpened = false;
        };
        for (const part of parts) {
            if (opensStepBlock(part)) {
                flushBlock();
                blockOpened = true;
                pendingBlock = [part];
                continue;
            }
            if (blockOpened) {
                pendingBlock.push(part);
            } else {
                // Leading parts before any step-start form the head block.
                blockOpened = true;
                pendingBlock = [part];
            }
        }
        flushBlock();
        if (kept.length === 0 || !kept.some(isProviderVisible)) {
            messages.splice(index, 1);
            stats.removedMessages += 1;
            continue;
        }
        if (kept.length !== parts.length) {
            message.parts = kept;
            stats.strippedParts += parts.length - kept.length;
        }
    }
    return stats;
}
