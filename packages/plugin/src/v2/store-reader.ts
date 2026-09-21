import {
    assertOpenCodeStoreGeneration,
    resolveOpenCodeDbPath,
    sourceOpenCodeDatabaseFilename,
} from "../shared/opencode-db-path";
import { Database } from "../shared/sqlite";

/** Compatibility export; shared/opencode-db-path.ts is the single filename authority. */
export function sourceDatabaseFilename(
    channel: string,
    env: NodeJS.ProcessEnv = process.env,
): string {
    return sourceOpenCodeDatabaseFilename("v2", channel, env);
}

/** GA data root resolved by the shared host-generation-aware resolver. */
export function gaDatabasePath(
    dataHome: string,
    channel = "latest",
    env: NodeJS.ProcessEnv = process.env,
): string {
    return resolveOpenCodeDbPath("v2", { dataHome, channel, env }).path;
}

// GA core-session-message.excerpt.js and oc-audit-7a31b5c0f7.md:166-184.
export type MessageType =
    | "agent-switched"
    | "model-switched"
    | "location-switched"
    | "user"
    | "synthetic"
    | "system"
    | "skill"
    | "shell"
    | "assistant"
    | "compaction"
    | "idle";

export const RAW_MESSAGE_TYPES = [
    "user",
    "synthetic",
    "assistant",
    "skill",
    "shell",
    "system",
] as const satisfies readonly MessageType[];
export interface MessageData {
    [key: string]: unknown;
    content?: Array<Record<string, unknown>>;
    text?: string;
    finish?: string;
    error?: unknown;
    model?: { id: string; providerID: string; variant?: string };
    tokens?: {
        input: number;
        output: number;
        reasoning: number;
        cache: { read: number; write: number };
    };
    time?: { created: number; completed?: number; streamed?: number };
}
export interface IdleData extends MessageData {
    outcome: "succeeded" | "failed" | "interrupted";
}
export interface CompactionData extends MessageData {
    status: string;
    summary?: string;
    recent?: string;
}
export interface StoreRow<T extends MessageType = MessageType> {
    id: string;
    session_id: string;
    type: T;
    seq: number;
    data: T extends "idle" ? IdleData : T extends "compaction" ? CompactionData : MessageData;
}
interface RawRow extends Omit<StoreRow, "data"> {
    data: string;
}

export const V2_STORE_READER_DEBUG_COUNTER_KEY = "magic-context.v2.store-reader-debug";

export interface V2StoreReaderDebugOperation {
    calls: number;
    decodedRows: number;
    maxDecodedRows: number;
}

export interface V2StoreReaderDebugCounters {
    decodedRows: number;
    operations: Record<string, V2StoreReaderDebugOperation>;
}

const debugSymbol = Symbol.for(V2_STORE_READER_DEBUG_COUNTER_KEY);
const debugGlobal = globalThis as typeof globalThis & {
    [key: symbol]: V2StoreReaderDebugCounters | undefined;
};

function debugCounters(): V2StoreReaderDebugCounters {
    return (debugGlobal[debugSymbol] ??= { decodedRows: 0, operations: {} });
}

function trackDecodeOperation<T>(name: string, operation: () => T): T {
    const counters = debugCounters();
    const before = counters.decodedRows;
    try {
        return operation();
    } finally {
        const decodedRows = counters.decodedRows - before;
        const current = counters.operations[name] ?? {
            calls: 0,
            decodedRows: 0,
            maxDecodedRows: 0,
        };
        current.calls += 1;
        current.decodedRows += decodedRows;
        current.maxDecodedRows = Math.max(current.maxDecodedRows, decodedRows);
        counters.operations[name] = current;
    }
}

export function getV2StoreReaderDebugCounters(): V2StoreReaderDebugCounters {
    const counters = debugCounters();
    return {
        decodedRows: counters.decodedRows,
        operations: Object.fromEntries(
            Object.entries(counters.operations).map(([name, operation]) => [
                name,
                { ...operation },
            ]),
        ),
    };
}

export function resetV2StoreReaderDebugCounters(): void {
    debugGlobal[debugSymbol] = { decodedRows: 0, operations: {} };
}

function decode(row: RawRow): StoreRow {
    debugCounters().decodedRows += 1;
    const data: unknown = JSON.parse(row.data);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error(`Invalid session_message data at seq ${row.seq}`);
    }
    if (
        row.type === "idle" &&
        !["succeeded", "failed", "interrupted"].includes(String((data as IdleData).outcome))
    ) {
        throw new Error(`Invalid idle outcome at seq ${row.seq}`);
    }
    return { ...row, data: data as MessageData };
}

/** Opens an existing store read-only; missing/corrupt stores propagate errors, never an empty history. */
export class V2StoreReader {
    private readonly db: Database;
    constructor(path: string) {
        this.db = new Database(path, { readonly: true, fileMustExist: true });
        try {
            assertOpenCodeStoreGeneration(this.db, "v2", path);
        } catch (error) {
            this.db.close();
            throw error;
        }
    }
    close(): void {
        this.db.close();
    }

    /** Exclusive cursor, ascending seq. IDs are not chronological in the v2 store. */
    page(
        sessionID: string,
        options: {
            after?: number;
            through?: number;
            limit?: number;
            type?: MessageType;
        } = {},
    ): { rows: StoreRow[]; cursor: number | undefined } {
        return trackDecodeOperation("page", () => {
            const limit = options.limit ?? 100;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
                throw new Error("Invalid page limit");
            const after = options.after ?? -1;
            if (!Number.isSafeInteger(after)) throw new Error("Invalid seq cursor");
            if (options.through !== undefined && !Number.isSafeInteger(options.through))
                throw new Error("Invalid seq upper bound");
            const predicates = ["session_id = ?", "seq > ?"];
            const parameters: Array<string | number> = [sessionID, after];
            if (options.through !== undefined) {
                predicates.push("seq <= ?");
                parameters.push(options.through);
            }
            if (options.type) {
                predicates.push("type = ?");
                parameters.push(options.type);
            }
            const rows = (
                this.db
                    .prepare(`SELECT id, session_id, type, seq, data FROM session_message
                        WHERE ${predicates.join(" AND ")}
                        ORDER BY seq ASC LIMIT ?`)
                    .all(...parameters, limit) as RawRow[]
            ).map(decode);
            return { rows, cursor: rows.at(-1)?.seq };
        });
    }

    /**
     * Read one page from the contiguous raw-message ordinal space. OpenCode seq
     * includes non-conversation rows, so the CTE maps the two ordinal boundaries
     * to seq values without hydrating any row outside the requested page.
     */
    messagePage(
        sessionID: string,
        afterOrdinal: number,
        limit: number,
        finalWatermark: number,
    ): StoreRow[] {
        return trackDecodeOperation("messagePage", () => {
            if (!Number.isSafeInteger(afterOrdinal) || afterOrdinal < 0)
                throw new Error("Invalid raw-message ordinal cursor");
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000)
                throw new Error("Invalid page limit");
            if (!Number.isSafeInteger(finalWatermark) || finalWatermark < 0)
                throw new Error("Invalid raw-message watermark");
            const pageSize = Math.min(limit, finalWatermark - afterOrdinal);
            if (pageSize <= 0) return [];
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const maximumSeq = Number.MAX_SAFE_INTEGER;
            const rows = this.db
                .prepare(
                    `WITH bounds AS (
                        SELECT
                            CASE WHEN ? = 0 THEN -1 ELSE COALESCE((
                                SELECT seq FROM session_message
                                WHERE session_id = ? AND type IN (${rawTypes})
                                ORDER BY seq ASC LIMIT 1 OFFSET ?
                            ), -1) END AS after_seq,
                            COALESCE((
                                SELECT seq FROM session_message
                                WHERE session_id = ? AND type IN (${rawTypes})
                                ORDER BY seq ASC LIMIT 1 OFFSET ?
                            ), ?) AS watermark_seq
                    )
                    SELECT id, session_id, type, seq, data FROM session_message, bounds
                    WHERE session_id = ?
                      AND type IN (${rawTypes})
                      AND seq > bounds.after_seq
                      AND seq <= bounds.watermark_seq
                    ORDER BY seq ASC LIMIT ?`,
                )
                .all(
                    afterOrdinal,
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    Math.max(0, afterOrdinal - 1),
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    finalWatermark - 1,
                    maximumSeq,
                    sessionID,
                    ...RAW_MESSAGE_TYPES,
                    pageSize,
                ) as RawRow[];
            return rows.map(decode);
        });
    }

    messageCount(sessionID: string): number {
        return trackDecodeOperation("messageCount", () => {
            const rawTypes = RAW_MESSAGE_TYPES.map(() => "?").join(", ");
            const row = this.db
                .prepare(
                    `SELECT COUNT(*) AS count FROM session_message
                     WHERE session_id = ? AND type IN (${rawTypes})`,
                )
                .get(sessionID, ...RAW_MESSAGE_TYPES) as { count?: number } | undefined;
            return typeof row?.count === "number" ? row.count : 0;
        });
    }

    range(sessionID: string, after: number, through: number): StoreRow[] {
        return trackDecodeOperation("range", () =>
            through <= after ? [] : this.all(sessionID, after, undefined, through),
        );
    }

    sequenceForId(sessionID: string, id: string | null | undefined): number | undefined {
        if (!id) return undefined;
        const row = this.db
            .prepare("SELECT seq FROM session_message WHERE session_id = ? AND id = ? LIMIT 1")
            .get(sessionID, id) as { seq?: number } | undefined;
        return typeof row?.seq === "number" ? row.seq : undefined;
    }

    latestSequenceForIds(sessionID: string, ids: readonly string[]): number {
        let latest = -1;
        for (let offset = 0; offset < ids.length; offset += 500) {
            const chunk = ids.slice(offset, offset + 500);
            const row = this.db
                .prepare(
                    `SELECT MAX(seq) AS seq FROM session_message
                     WHERE session_id = ? AND id IN (${chunk.map(() => "?").join(", ")})`,
                )
                .get(sessionID, ...chunk) as { seq?: number | null } | undefined;
            if (typeof row?.seq === "number") latest = Math.max(latest, row.seq);
        }
        return latest;
    }

    private compactionByStatus(
        sessionID: string,
        status: "completed" | "running",
    ): StoreRow<"compaction"> | undefined {
        const row = this.db
            .prepare(`SELECT id, session_id, type, seq, data FROM session_message
                WHERE session_id = ? AND type = 'compaction'
                  AND json_extract(data, '$.status') = ?
                ORDER BY seq DESC LIMIT 1`)
            .get(sessionID, status) as RawRow | undefined;
        return row ? (decode(row) as StoreRow<"compaction">) : undefined;
    }

    // Only a completed compaction is a stable history boundary; a running or
    // failed compaction must not hide rows from the active context.
    latestCompaction(sessionID: string): StoreRow<"compaction"> | undefined {
        return trackDecodeOperation("latestCompaction", () =>
            this.compactionByStatus(sessionID, "completed"),
        );
    }

    latestRunningCompaction(sessionID: string): StoreRow<"compaction"> | undefined {
        return trackDecodeOperation("latestRunningCompaction", () =>
            this.compactionByStatus(sessionID, "running"),
        );
    }

    idleRows(sessionID: string, after = -1): StoreRow<"idle">[] {
        return trackDecodeOperation(
            "idleRows",
            () => this.all(sessionID, after, "idle") as StoreRow<"idle">[],
        );
    }

    latestSequence(sessionID: string): number {
        const row = this.db
            .prepare("SELECT MAX(seq) AS seq FROM session_message WHERE session_id = ?")
            .get(sessionID) as { seq: number | null } | undefined;
        return typeof row?.seq === "number" ? row.seq : -1;
    }

    latestAssistant(sessionID: string): StoreRow<"assistant"> | undefined {
        return trackDecodeOperation("latestAssistant", () => {
            const row = this.db
                .prepare(`SELECT id, session_id, type, seq, data FROM session_message
                    WHERE session_id = ? AND type = 'assistant'
                    ORDER BY seq DESC LIMIT 1`)
                .get(sessionID) as RawRow | undefined;
            return row ? (decode(row) as StoreRow<"assistant">) : undefined;
        });
    }

    /** Include the completed checkpoint itself, matching the host history cut. */
    window(sessionID: string): StoreRow[] {
        return trackDecodeOperation("window", () =>
            this.db.transaction(() => {
                const cut = this.latestCompaction(sessionID);
                return this.all(sessionID, cut ? cut.seq - 1 : -1);
            })(),
        );
    }

    /**
     * Read every retained row for conversion rebases and explicit diagnostics.
     * Context passes use messagePage/count/range instead; this must not be their
     * ordinary source because conversion rebases alone need every part payload.
     */
    history(sessionID: string): StoreRow[] {
        return trackDecodeOperation("history", () => this.all(sessionID, -1));
    }

    private all(
        sessionID: string,
        after: number,
        type?: MessageType,
        through?: number,
    ): StoreRow[] {
        const rows: StoreRow[] = [];
        for (;;) {
            const page = this.page(sessionID, { after, through, type });
            rows.push(...page.rows);
            if (page.rows.length < 100 || page.cursor === undefined) return rows;
            after = page.cursor;
        }
    }
}
