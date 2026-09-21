import type { RawMessageProvider } from "../../hooks/magic-context/read-session-chunk";
import type {
    RawMessage,
    RawMessageOrdinalAnchor,
    RawMessageOrdinalEntry,
} from "../../hooks/magic-context/read-session-raw";

/**
 * Raw-history source for one OpenCode 2 session.
 *
 * Everything that needs the conversation's raw rows — the historian, the
 * protected-tail boundary, the module cold seed and the module's ordinal
 * resolution — reads through the shared per-session provider registry rather
 * than through OpenCode's own database. On OpenCode 2 that database holds a
 * different schema and a different projection, so reading it would be reading
 * the wrong store; this provider is what keeps every one of those readers on
 * the v2 store instead.
 *
 * The registry's generic fallbacks derive an ordinal page from message
 * timestamps. That is wrong here: v2 rows do not all carry a creation time, so
 * a timestamped assistant row and an untimed user row would sort against each
 * other on incomparable numbers. Every method below is supplied explicitly and
 * keyed on the canonical v2 ordinal — the same ordinal space the projection
 * assigns and the host-side coordinates use — so paging is a total order with
 * no timestamps in it at all.
 */
export function createV2RawMessageProvider(readMessages: () => RawMessage[]): RawMessageProvider {
    const ordinalEntry = (message: RawMessage): RawMessageOrdinalEntry => ({
        // The anchor's ordering field: the canonical ordinal, not a wall clock.
        timeCreated: message.ordinal,
        id: message.id,
        contributesOrdinal: true,
        hasValidInfo: true,
    });
    return {
        readMessages,
        readMessagePage: (afterOrdinal, limit, finalWatermark) =>
            readMessages()
                .filter(
                    (message) =>
                        message.ordinal > afterOrdinal && message.ordinal <= finalWatermark,
                )
                .slice(0, Math.max(0, Math.floor(limit))),
        readMessageById: (messageId) =>
            readMessages().find((message) => message.id === messageId) ?? null,
        readMessagePartsById: (messageId) =>
            readMessages().find((message) => message.id === messageId) ?? null,
        readMessageOrdinalById: (messageId) =>
            readMessages().find((message) => message.id === messageId)?.ordinal ?? null,
        readMessageIdOrdinals: () =>
            new Map(readMessages().map((message) => [message.id, message.ordinal])),
        readMessageOrdinalPage: (after: RawMessageOrdinalAnchor | null, limit: number) =>
            readMessages()
                .filter(
                    (message) =>
                        after === null ||
                        message.ordinal > after.timeCreated ||
                        (message.ordinal === after.timeCreated && message.id > after.id),
                )
                .slice(0, Math.max(1, Math.floor(limit)))
                .map(ordinalEntry),
        getMessageCount: () => readMessages().length,
        // The v2 projection has no compaction-summary rows to exclude, so the
        // stored count and the ordinal-bearing count are the same number.
        getStoredMessageCount: () => readMessages().length,
    };
}
