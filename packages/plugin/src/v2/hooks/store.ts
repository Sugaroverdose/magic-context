import type {
    RawMessage,
    RawMessageOrdinalAnchor,
    RawMessageOrdinalEntry,
} from "../../hooks/magic-context/read-session-raw";
import {
    type MessageType,
    RAW_MESSAGE_TYPES,
    type StoreRow,
    type V2StoreReader,
} from "../store-reader";

const rawMessageTypes = new Set<MessageType>(RAW_MESSAGE_TYPES);
const isRawRow = (row: StoreRow) => rawMessageTypes.has(row.type);

function projectRawMessages(
    rows: readonly StoreRow[],
    ordinalFor: (row: StoreRow, index: number) => number,
): RawMessage[] {
    return rows.filter(isRawRow).map((row, index) => {
        const message: RawMessage = {
            id: row.id,
            ordinal: ordinalFor(row, index),
            role: row.type === "assistant" ? "assistant" : "user",
            createdAt: row.data.time?.created,
            parts:
                row.type === "assistant"
                    ? (row.data.content ?? []).map((part) => {
                          if (part.type !== "tool") return { ...part };
                          const state = part.state as Record<string, unknown>;
                          const content = state.content as
                              | Array<{ type: string; text?: string }>
                              | undefined;
                          return {
                              type: "tool",
                              tool: part.name,
                              callID: part.id,
                              state: {
                                  ...state,
                                  output:
                                      content
                                          ?.filter((p) => p.type === "text")
                                          .map((p) => p.text)
                                          .join("\n") ?? "",
                              },
                          };
                      })
                    : [{ type: "text", text: row.data.text ?? "" }],
        };
        // Keep host provenance available to coordinate repair without changing the
        // enumerable RawMessage shape shared with the v1 differential fixtures.
        Object.defineProperty(message, "storeType", { value: row.type, enumerable: false });
        return message;
    });
}

/** Ordinals count conversational rows in the complete session, never a post-fold window.
 * A window caller must supply the full history so compaction cannot reassign tag identities. */
export function rawMessages(
    rows: readonly StoreRow[],
    history: readonly StoreRow[] = rows,
): RawMessage[] {
    const ordinals = new Map(history.filter(isRawRow).map((row, index) => [row.id, index + 1]));
    return projectRawMessages(rows, (row) => {
        // A row outside the supplied history has no ordinal; 0 is never a live ordinal,
        // so a caller that windowed without passing full history fails visibly rather
        // than inheriting a neighbour's tag identity.
        return ordinals.get(row.id) ?? 0;
    });
}

/** Project a SQL-bounded page whose first row follows `afterOrdinal`. */
export function rawMessagePage(rows: readonly StoreRow[], afterOrdinal: number): RawMessage[] {
    return projectRawMessages(rows, (_row, index) => afterOrdinal + index + 1);
}

export type V2RawMessageReader = ((sessionID: string) => RawMessage[]) & {
    readPage: (
        sessionID: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ) => RawMessage[];
    findById: (sessionID: string, messageID: string) => RawMessage | null;
    ordinalOf: (sessionID: string, messageID: string) => number | null;
    ordinalMapForRange: (
        sessionID: string,
        fromOrdinal: number,
        toOrdinal: number,
    ) => Map<string, number>;
    readOrdinalPage: (
        sessionID: string,
        after: RawMessageOrdinalAnchor | null,
        limit: number,
    ) => RawMessageOrdinalEntry[];
    getCount: (sessionID: string) => number;
    getStoredCount: (sessionID: string) => number;
};

/**
 * Use the callable full read only when converting data between store generations,
 * because that repair must inspect every message part to preserve part-index tags.
 * Normal context and indexing passes use the SQL-bounded page and count methods.
 */
export function createV2RawMessageReader(openReader: () => V2StoreReader): V2RawMessageReader {
    const read = (sessionID: string) => {
        const reader = openReader();
        try {
            return rawMessages(reader.history(sessionID));
        } finally {
            reader.close();
        }
    };
    return Object.assign(read, {
        readPage: (
            sessionID: string,
            afterOrdinal: number,
            limit: number,
            finalWatermark: number,
        ) => {
            const reader = openReader();
            try {
                return rawMessagePage(
                    reader.messagePage(sessionID, afterOrdinal, limit, finalWatermark),
                    afterOrdinal,
                );
            } finally {
                reader.close();
            }
        },
        findById: (sessionID: string, messageID: string) => {
            const reader = openReader();
            try {
                const ordinal = reader.messageOrdinalById(sessionID, messageID);
                const row = reader.messageById(sessionID, messageID);
                if (ordinal === null || row === null) return null;
                return rawMessagePage([row], ordinal - 1)[0] ?? null;
            } finally {
                reader.close();
            }
        },
        ordinalOf: (sessionID: string, messageID: string) => {
            const reader = openReader();
            try {
                return reader.messageOrdinalById(sessionID, messageID);
            } finally {
                reader.close();
            }
        },
        ordinalMapForRange: (sessionID: string, fromOrdinal: number, toOrdinal: number) => {
            const reader = openReader();
            try {
                return reader.messageIdOrdinals(sessionID, fromOrdinal, toOrdinal);
            } finally {
                reader.close();
            }
        },
        readOrdinalPage: (
            sessionID: string,
            after: RawMessageOrdinalAnchor | null,
            limit: number,
        ) => {
            const reader = openReader();
            try {
                return reader.messageOrdinalPage(sessionID, after, limit);
            } finally {
                reader.close();
            }
        },
        getCount: (sessionID: string) => {
            const reader = openReader();
            try {
                return reader.messageCount(sessionID);
            } finally {
                reader.close();
            }
        },
        getStoredCount: (sessionID: string) => {
            const reader = openReader();
            try {
                return reader.storedMessageCount(sessionID);
            } finally {
                reader.close();
            }
        },
    });
}
