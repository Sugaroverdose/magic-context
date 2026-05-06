import { isRecord } from "../../shared/record-type-guard";

/**
 * Whole-message sentinel placeholder for providers that DO NOT filter
 * empty assistant content out of their wire payload.
 *
 * Background: when `stripDroppedPlaceholderMessages` /
 * `stripSystemInjectedMessages` / `replaySentinelByMessageIds` reduce a
 * whole assistant message to one sentinel part, the resulting AI-SDK
 * `ModelMessage` becomes `{ role: "assistant", content: "" }`. Anthropic
 * and Bedrock filter such empty messages out via their `normalizeMessages`
 * step (see OpenCode's `provider/transform.ts:55-73`), so the wire never
 * sees them. Most other providers (openai-compatible, openrouter, google,
 * ...) do not, and the empty-content message reaches the wire — and is
 * rejected by stricter backends (e.g. Moonshot/Kimi: "must not be empty").
 *
 * Using a non-empty placeholder text whose value won't be filtered keeps
 * the wire valid while still telling the model honestly that something
 * was dropped. For Anthropic/Bedrock we still emit `""` so their existing
 * filter continues removing the message — no wire-shape change for them.
 */
export const WHOLE_MESSAGE_PLACEHOLDER_TEXT = "[dropped]";

/**
 * Decide whether a model accepts empty assistant `content` on the wire.
 *
 * "Accepts" here means: OpenCode's own `normalizeMessages` (or the AI SDK)
 * filters out empty text/reasoning/messages BEFORE they reach the
 * provider, so an empty sentinel is safe AND lets the message disappear
 * from the wire entirely (a small token-count optimization).
 *
 * Rule: only the canonical `anthropic` provider. Everything else gets the
 * non-empty `[dropped]` placeholder.
 *
 * Trade-off: providers that ALSO filter empties but aren't the canonical
 * Anthropic provider (e.g. Bedrock, Google-Vertex Anthropic) will see
 * `[dropped]` here instead of `""`. Their filter doesn't remove non-empty
 * content, so the message stays on the wire — one cache bust on rollout,
 * then stable. Acceptable given the alternative is broader matching that
 * risks misclassifying non-filter providers as filter-friendly (which
 * would re-introduce the empty-message rejection bug we're fixing).
 */
function modelAcceptsEmptyContent(providerID?: string): boolean {
    return providerID === "anthropic";
}

/**
 * Create an empty-text sentinel to replace a stripped message PART (not a
 * whole message) while preserving the array's length and index positions
 * across passes.
 *
 * For per-part sentinelization, empty text is always safe — the message
 * still has other content (text/tool/reasoning) so it never reaches the
 * wire as an empty assistant message.
 *
 * Why sentinels exist: some providers (Antigravity/Gemini-routed-Claude,
 * some OpenRouter configs) hash the full serialized messages[] array as
 * their prompt-cache key. Any array-length change between turns busts the
 * cache. Replacing removed parts with inert `{type:"text", text:""}`
 * placeholders keeps the array shape stable so subsequent turns can hit
 * cache on the unchanged prefix.
 *
 * For Anthropic/Bedrock/Google-SDK providers, `provider/transform.ts:55-73`
 * (or the SDK itself) filters out parts where `text === ""`, so the
 * sentinel never reaches the wire. Wire behavior stays identical to the
 * previous `.filter()`/`.splice()` behavior.
 *
 * `cache_control` inheritance: if the original part carried provider-side
 * cache-breakpoint metadata (`cache_control` / `cacheControl`), the
 * sentinel inherits it. OpenCode currently only sets cache markers on the
 * last two system+non-system messages (never on mid-history parts we
 * strip), so this is defensive, but cheap.
 */
export function makeSentinel(originalPart: unknown): {
    type: "text";
    text: string;
} & Record<string, unknown> {
    const sentinel: { type: "text"; text: string } & Record<string, unknown> = {
        type: "text",
        text: "",
    };
    if (isRecord(originalPart)) {
        if (originalPart.cache_control !== undefined) {
            sentinel.cache_control = originalPart.cache_control;
        }
        if (originalPart.cacheControl !== undefined) {
            sentinel.cacheControl = originalPart.cacheControl;
        }
    }
    return sentinel;
}

/**
 * Create a sentinel for replacing a WHOLE assistant message's parts list.
 *
 * Picks `""` when the live provider is the canonical Anthropic provider
 * (whose AI-SDK normalization filters empty content from the wire),
 * `[dropped]` otherwise. See `modelAcceptsEmptyContent` for the rule.
 *
 * The chosen placeholder text is kept in `WHOLE_MESSAGE_PLACEHOLDER_TEXT`
 * so `isSentinel` recognizes both shapes (idempotency on replay).
 */
export function makeWholeMessageSentinel(
    providerID?: string,
): { type: "text"; text: string } & Record<string, unknown> {
    return {
        type: "text",
        text: modelAcceptsEmptyContent(providerID) ? "" : WHOLE_MESSAGE_PLACEHOLDER_TEXT,
    };
}

/**
 * Detect whether a part is already a sentinel produced by `makeSentinel`
 * or `makeWholeMessageSentinel`. Used by strip functions to stay
 * idempotent — don't re-count or re-mutate a sentinel we already
 * installed.
 *
 * Recognizes both empty (`""`) and whole-message-placeholder
 * (`[dropped]`) sentinel text values.
 */
export function isSentinel(part: unknown): boolean {
    if (!isRecord(part)) return false;
    if (part.type !== "text") return false;
    if (typeof part.text !== "string") return false;
    return part.text === "" || part.text === WHOLE_MESSAGE_PLACEHOLDER_TEXT;
}

/**
 * Replay a previously-persisted set of message IDs by replacing each
 * matching message's parts with a single whole-message sentinel. Used to
 * keep the wire shape stable across defer passes when OpenCode rebuilds
 * messages from its DB — any message whose ID is in `ids` was
 * neutralized on a prior bust pass and should be neutralized again now.
 *
 * `providerID` controls which sentinel shape is installed (see
 * `makeWholeMessageSentinel`). Pass the live session's provider so the
 * replayed wire shape matches the fresh sentinelization on the current
 * pass — providers that don't filter empties get `[dropped]`, Anthropic
 * gets `""`.
 *
 * Returns the number of messages replayed + the set of IDs that were NOT
 * found in the current message array (caller can prune them from the
 * persisted set so we stop carrying stale IDs forever).
 */
export function replaySentinelByMessageIds(
    messages: Array<{ info: { id?: string }; parts: unknown[] }>,
    ids: Set<string>,
    providerID?: string,
): { replayed: number; missingIds: string[] } {
    if (ids.size === 0) return { replayed: 0, missingIds: [] };
    const seen = new Set<string>();
    let replayed = 0;
    for (const msg of messages) {
        const id = msg.info.id;
        if (!id || !ids.has(id)) continue;
        seen.add(id);
        // Idempotent skip — already neutralized on an earlier pass in this turn
        if (msg.parts.length === 1 && isSentinel(msg.parts[0])) continue;
        msg.parts.length = 0;
        msg.parts.push(makeWholeMessageSentinel(providerID));
        replayed++;
    }
    const missingIds: string[] = [];
    for (const id of ids) if (!seen.has(id)) missingIds.push(id);
    return { replayed, missingIds };
}
