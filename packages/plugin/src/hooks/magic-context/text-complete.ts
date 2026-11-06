import { stripPersistedAssistantText } from "./tag-content-primitives";

/**
 * Persistence-boundary handler for assistant completions
 * (`experimental.text.complete`). Delegates to `stripPersistedAssistantText`,
 * which persists the model's bytes verbatim (ctx_reduce v1 ruling). The
 * former four-pass cutting chain (leading runs, global pairs, malformed
 * hybrids, stray `§`) is retired — it cut bytes that followed a tag
 * positioned as shared knowledge. Header re-pinned 2026-11-06 per merge-gate
 * A3; the cutting described here no longer runs.
 */

export function createTextCompleteHandler() {
    return async (
        _input: { sessionID: string; messageID: string; partID: string },

        output: { text: string },
    ): Promise<void> => {
        output.text = stripPersistedAssistantText(output.text);
    };
}
