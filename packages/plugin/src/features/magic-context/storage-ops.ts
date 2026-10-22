import { getHarness } from "../../shared/harness";
import { sessionLog } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import type { PendingOp } from "./types";

const queuePendingOpStatements = new WeakMap<Database, PreparedStatement>();
const getPendingOpsStatements = new WeakMap<Database, PreparedStatement>();
const getPendingOpsCountStatements = new WeakMap<Database, PreparedStatement>();
const clearPendingOpsStatements = new WeakMap<Database, PreparedStatement>();
const removePendingOpStatements = new WeakMap<Database, PreparedStatement>();

function getQueuePendingOpStatement(db: Database): PreparedStatement {
    let stmt = queuePendingOpStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, ?, ?, ?, ?)",
        );
        queuePendingOpStatements.set(db, stmt);
    }
    return stmt;
}

function getPendingOpsStatement(db: Database): PreparedStatement {
    let stmt = getPendingOpsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare(
            "SELECT id, session_id, tag_id, operation, queued_at FROM pending_ops WHERE session_id = ? ORDER BY queued_at ASC, id ASC",
        );
        getPendingOpsStatements.set(db, stmt);
    }
    return stmt;
}

function getClearPendingOpsStatement(db: Database): PreparedStatement {
    let stmt = clearPendingOpsStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM pending_ops WHERE session_id = ?");
        clearPendingOpsStatements.set(db, stmt);
    }
    return stmt;
}

function getRemovePendingOpStatement(db: Database): PreparedStatement {
    let stmt = removePendingOpStatements.get(db);
    if (!stmt) {
        stmt = db.prepare("DELETE FROM pending_ops WHERE session_id = ? AND tag_id = ?");
        removePendingOpStatements.set(db, stmt);
    }
    return stmt;
}

interface PendingOpRow {
    id: number;
    session_id: string;
    tag_id: number;
    operation: string;
    queued_at: number;
}

function isPendingOpRow(row: unknown): row is PendingOpRow {
    if (row === null || typeof row !== "object") return false;
    const r = row as Record<string, unknown>;
    return (
        typeof r.id === "number" &&
        typeof r.session_id === "string" &&
        typeof r.tag_id === "number" &&
        typeof r.operation === "string" &&
        typeof r.queued_at === "number"
    );
}

function toPendingOp(row: PendingOpRow): PendingOp | null {
    if (row.operation !== "drop") {
        sessionLog(row.session_id, `unknown pending operation "${row.operation}"; ignoring`);
        return null;
    }

    return {
        id: row.id,
        sessionId: row.session_id,
        tagId: row.tag_id,
        operation: row.operation,
        queuedAt: row.queued_at,
    };
}

export function queuePendingOp(
    db: Database,
    sessionId: string,
    tagId: number,
    operation: PendingOp["operation"],
    queuedAt: number = Date.now(),
): void {
    getQueuePendingOpStatement(db).run(sessionId, tagId, operation, queuedAt, getHarness());
}

export function getPendingOps(db: Database, sessionId: string): PendingOp[] {
    const rows = getPendingOpsStatement(db).all(sessionId).filter(isPendingOpRow);

    return rows.map(toPendingOp).filter((op): op is PendingOp => op !== null);
}

/** Read durable queue depth without loading rows on a deferred pass. */
export function getPendingOpsCount(db: Database, sessionId: string): number | null {
    try {
        let statement = getPendingOpsCountStatements.get(db);
        if (!statement) {
            statement = db.prepare(
                "SELECT COUNT(*) AS count FROM pending_ops WHERE session_id = ?",
            );
            getPendingOpsCountStatements.set(db, statement);
        }
        const row = statement.get(sessionId) as { count?: number } | null;
        return typeof row?.count === "number" && Number.isFinite(row.count) ? row.count : null;
    } catch {
        // A diagnostic read must never turn a fail-open transform into a failure.
        return null;
    }
}

export function clearPendingOps(db: Database, sessionId: string): void {
    getClearPendingOpsStatement(db).run(sessionId);
}

const DORMANT_SESSION_GC_MS = 30 * 86_400_000;
const dormantGcStatements = new WeakMap<Database, PreparedStatement>();

/**
 * A queued drop lives in `pending_ops` until the owning session's apply lane
 * consumes it. A session that never runs again — the finished subagent, the
 * abandoned chat — never revisits its queue, so its rows are unreachable
 * bookkeeping that only grows. Clearing a dormant session's queue is safe on
 * resurrection: the scheduler re-derives drop candidates from tag state, and
 * a month-old stamp costs one re-stamp — against unbounded accumulation.
 * Idempotent and TTL-scoped, re-run from every database open, mirroring the
 * lease-heal law.
 */
export function purgeDormantSessionPendingOps(
    db: Database,
    nowMs: number = Date.now(),
    dormantMs: number = DORMANT_SESSION_GC_MS,
): number {
    const cutoffSeconds = Math.floor((nowMs - dormantMs) / 1000);
    try {
        let statement = dormantGcStatements.get(db);
        if (!statement) {
            statement = db.prepare(
                `DELETE FROM pending_ops
                 WHERE session_id IN (
                   SELECT session_id FROM session_meta
                   WHERE last_response_time > 0 AND last_response_time < ?
                 )`,
            );
            dormantGcStatements.set(db, statement);
        }
        return statement.run(cutoffSeconds).changes;
    } catch {
        // Boot maintenance must never fail an open over a swept queue.
        return 0;
    }
}

export function removePendingOp(db: Database, sessionId: string, tagId: number): void {
    getRemovePendingOpStatement(db).run(sessionId, tagId);
}
