import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { getDatabasePath } from "./storage-db";

export type TransformDecisionHarness = "opencode" | "pi";
export type TransformSchedulerDecision = "execute" | "defer";

export type CanonicalMaterializeReason =
    | "system_hash"
    | "model_change"
    | "project_memory_epoch"
    | "ttl_idle"
    | "explicit_flush"
    | "max_mutation_id"
    | "first_render"
    | "pressure_refold"
    | "upgrade_state"
    | "cached_m1_missing";

export interface PendingTransformDecision {
    tsMs: number;
    decision: TransformSchedulerDecision;
    materialized: boolean;
    materializeReason: CanonicalMaterializeReason | null;
    emergency: boolean;
    droppedTokens: number;
    droppedCount: number;
    inputTokens: number;
    bustedThisPass: boolean;
}

interface TransformDecisionRow extends PendingTransformDecision {
    sessionId: string;
    harness: TransformDecisionHarness;
    messageId: string;
}

interface PendingPiTransformDecision extends PendingTransformDecision {
    snapshotNewestAssistantEntryId: string | null;
}

type TransformDecisionWriter = (dbPath: string, row: TransformDecisionRow) => void;

const canonicalReasons = new Set<string>([
    "system_hash",
    "model_change",
    "project_memory_epoch",
    "ttl_idle",
    "explicit_flush",
    "max_mutation_id",
    "first_render",
    "pressure_refold",
    "upgrade_state",
    "cached_m1_missing",
]);

const piReasonAliases: Record<string, CanonicalMaterializeReason> = {
    project_memory_change: "project_memory_epoch",
    pending_mutations: "max_mutation_id",
    renderer_upgrade: "upgrade_state",
    cache_invalid: "cached_m1_missing",
    drift: "pressure_refold",
};

const sharedReasonAliases: Record<string, CanonicalMaterializeReason> = {
    model_key: "model_change",
    pressure: "pressure_refold",
};

const pendingDecisionBySession = new Map<string, PendingTransformDecision>();
const pendingPiDecisionBySession = new Map<string, PendingPiTransformDecision>();
const lastBoundMessageIdBySession = new Map<string, string>();
const scheduledWriteTokensBySession = new Map<string, Set<symbol>>();

let writerOverrideForTests: TransformDecisionWriter | null = null;

export function normalizeMaterializeReason(
    harness: TransformDecisionHarness,
    reason: string | null | undefined,
    rematerialized: boolean,
): CanonicalMaterializeReason | null {
    const raw = typeof reason === "string" ? reason.trim() : "";
    if (raw.length > 0) {
        const alias =
            sharedReasonAliases[raw] ??
            (harness === "pi" ? piReasonAliases[raw] : undefined) ??
            undefined;
        if (alias) return alias;
        if (canonicalReasons.has(raw)) return raw as CanonicalMaterializeReason;
        return null;
    }

    // OpenCode's pressure refold flips rematerialized=true without changing
    // mustMaterialize().reason. Pi records the same path as "drift" above, but
    // keep this fallback for cross-harness parity and future callers.
    return rematerialized ? "pressure_refold" : null;
}

export function clearOpenCodePendingTransformDecision(sessionId: string): void {
    pendingDecisionBySession.delete(sessionId);
}

export function clearTransformDecisionSession(sessionId: string): void {
    pendingDecisionBySession.delete(sessionId);
    pendingPiDecisionBySession.delete(sessionId);
    lastBoundMessageIdBySession.delete(sessionId);
    scheduledWriteTokensBySession.delete(sessionId);
}

export function recordPendingTransformDecision(
    sessionId: string,
    decision: PendingTransformDecision,
): void {
    if (!decision.bustedThisPass) {
        pendingDecisionBySession.delete(sessionId);
        return;
    }
    pendingDecisionBySession.set(sessionId, decision);
}

export function recordPendingPiTransformDecision(
    sessionId: string,
    decision: PendingTransformDecision,
    snapshotNewestAssistantEntryId: string | null,
): void {
    if (!decision.bustedThisPass) return;
    pendingPiDecisionBySession.set(sessionId, {
        ...decision,
        snapshotNewestAssistantEntryId,
    });
}

export function scheduleOpenCodeTransformDecisionWrite(args: {
    db: Database;
    sessionId: string;
    messageId: string;
    inputTokens: number;
}): boolean {
    const pending = pendingDecisionBySession.get(args.sessionId);
    if (!pending) return false;
    if (lastBoundMessageIdBySession.get(args.sessionId) === args.messageId) {
        return false;
    }
    const dbPath = getDatabasePath(args.db);
    if (!dbPath) return false;

    lastBoundMessageIdBySession.set(args.sessionId, args.messageId);
    pendingDecisionBySession.delete(args.sessionId);
    const token = addScheduledWriteToken(args.sessionId);
    setTimeout(() => {
        try {
            if (!hasScheduledWriteToken(args.sessionId, token)) return;
            writeTransformDecisionBestEffort(dbPath, {
                ...pending,
                sessionId: args.sessionId,
                harness: "opencode",
                messageId: args.messageId,
                inputTokens: args.inputTokens,
            });
        } finally {
            deleteScheduledWriteToken(args.sessionId, token);
        }
    }, 0);
    return true;
}

export function findNewestPiAssistantEntryId(
    entries: readonly unknown[] | null | undefined,
): string | null {
    if (!Array.isArray(entries)) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || typeof entry !== "object") continue;
        const row = entry as { id?: unknown; type?: unknown; message?: unknown };
        if (row.type !== "message" || typeof row.id !== "string" || row.id.length === 0) {
            continue;
        }
        const message = row.message;
        if (
            message &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "assistant"
        ) {
            return row.id;
        }
    }
    return null;
}

export function schedulePiTransformDecisionResolve(args: {
    db: Database;
    sessionId: string;
    branchEntries: readonly unknown[] | null;
}): boolean {
    const pending = pendingPiDecisionBySession.get(args.sessionId);
    if (!pending) return false;
    const targetMessageId = findNewestPiAssistantEntryIdAfter(
        args.branchEntries,
        pending.snapshotNewestAssistantEntryId,
    );
    if (!targetMessageId) return false;
    const dbPath = getDatabasePath(args.db);
    if (!dbPath) return false;

    pendingPiDecisionBySession.delete(args.sessionId);
    const token = addScheduledWriteToken(args.sessionId);
    setTimeout(() => {
        try {
            if (!hasScheduledWriteToken(args.sessionId, token)) return;
            writeTransformDecisionBestEffort(dbPath, {
                ...pending,
                sessionId: args.sessionId,
                harness: "pi",
                messageId: targetMessageId,
            });
        } finally {
            deleteScheduledWriteToken(args.sessionId, token);
        }
    }, 0);
    return true;
}

function addScheduledWriteToken(sessionId: string): symbol {
    const token = Symbol(sessionId);
    let tokens = scheduledWriteTokensBySession.get(sessionId);
    if (!tokens) {
        tokens = new Set();
        scheduledWriteTokensBySession.set(sessionId, tokens);
    }
    tokens.add(token);
    return token;
}

function hasScheduledWriteToken(sessionId: string, token: symbol): boolean {
    return scheduledWriteTokensBySession.get(sessionId)?.has(token) === true;
}

function deleteScheduledWriteToken(sessionId: string, token: symbol): void {
    const tokens = scheduledWriteTokensBySession.get(sessionId);
    if (!tokens) return;
    tokens.delete(token);
    if (tokens.size === 0) scheduledWriteTokensBySession.delete(sessionId);
}

function findNewestPiAssistantEntryIdAfter(
    entries: readonly unknown[] | null,
    snapshotNewestAssistantEntryId: string | null,
): string | null {
    if (!Array.isArray(entries)) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (!entry || typeof entry !== "object") continue;
        const row = entry as { id?: unknown; type?: unknown; message?: unknown };
        if (row.type !== "message" || typeof row.id !== "string" || row.id.length === 0) {
            continue;
        }
        if (snapshotNewestAssistantEntryId !== null && row.id === snapshotNewestAssistantEntryId) {
            continue;
        }
        const message = row.message;
        if (
            message &&
            typeof message === "object" &&
            (message as { role?: unknown }).role === "assistant"
        ) {
            return row.id;
        }
    }
    return null;
}

function writeTransformDecisionBestEffort(dbPath: string, row: TransformDecisionRow): void {
    try {
        const writer = writerOverrideForTests ?? writeTransformDecisionRow;
        writer(dbPath, row);
    } catch {
        // Best-effort telemetry only. Never throw into OpenCode/Pi event or
        // context hooks; a locked/missing DB just drops this attribution row.
    }
}

function writeTransformDecisionRow(dbPath: string, row: TransformDecisionRow): void {
    const db = new Database(dbPath);
    try {
        db.exec("PRAGMA busy_timeout=0");
        db.prepare(
            `INSERT OR REPLACE INTO transform_decisions (
                session_id, harness, message_id, ts_ms, decision, materialized,
                materialize_reason, emergency, dropped_tokens, dropped_count, input_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            row.sessionId,
            row.harness,
            row.messageId,
            row.tsMs,
            row.decision,
            row.materialized ? 1 : 0,
            row.materializeReason,
            row.emergency ? 1 : 0,
            Math.max(0, Math.floor(row.droppedTokens)),
            Math.max(0, Math.floor(row.droppedCount)),
            Math.max(0, Math.floor(row.inputTokens)),
        );
    } finally {
        closeQuietly(db);
    }
}

export const __test = {
    getPending(sessionId: string): PendingTransformDecision | undefined {
        return pendingDecisionBySession.get(sessionId);
    },
    getPendingPi(sessionId: string): PendingPiTransformDecision | undefined {
        return pendingPiDecisionBySession.get(sessionId);
    },
    reset(): void {
        pendingDecisionBySession.clear();
        pendingPiDecisionBySession.clear();
        lastBoundMessageIdBySession.clear();
        scheduledWriteTokensBySession.clear();
        writerOverrideForTests = null;
    },
    setWriterForTests(writer: TransformDecisionWriter | null): void {
        writerOverrideForTests = writer;
    },
};
