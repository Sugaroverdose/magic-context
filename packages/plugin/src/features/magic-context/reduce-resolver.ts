import type { Database } from "../../shared/sqlite";
import { getPendingOps } from "./storage-ops";

/**
 * The ids lane of the ctx_reduce v1 pointing grammar: the model copies wire
 * call ids; the resolver maps each to its tags-registry entry and hands the
 * internal tag numbers to the existing drop engine (queuePendingOp /
 * protection window). Resolution keys on `tags.content_id` (the wire call id,
 * the same key the FPE resolver uses); ids are session-scoped lookups — an id
 * copied from another session is `unknown` here, never a foreign release.
 */

export type ReduceInputOutcome =
    | { kind: "released"; messageId: string }
    | { kind: "already_released" }
    | { kind: "refused"; reason: "protected" | "provider-framing" }
    | { kind: "unknown" };

export interface ReduceResolveResult {
    /** One outcome per input id, same order as the input array. */
    outcomes: ReduceInputOutcome[];
    /**
     * Internal tag numbers classified `released`, deduplicated. The resolver
     * does NOT queue — the caller enqueues these exactly once through the
     * active backend (module or TS), keeping a single apply point.
     */
    releasedTagNumbers: number[];
}

interface ReduceResolverDeps {
    db: Database;
    /** Tag numbers inside the protected working set (not reclaimable now). */
    protectedTagNumbers: ReadonlySet<number>;
    /** Tag numbers that are provider framing (nothing to reclaim). */
    inertTagNumbers?: ReadonlySet<number>;
}

interface RegistryRow {
    tag_number: number;
    message_id: string;
    status: string;
    type: string;
}

function lookupByContentId(db: Database, sessionId: string, contentId: string): RegistryRow[] {
    return db
        .prepare(
            `SELECT tag_number, message_id, status, type
       FROM tags
      WHERE session_id = ? AND content_id = ?
      ORDER BY tag_number ASC
      LIMIT 2`,
        )
        .all(sessionId, contentId) as unknown as RegistryRow[];
}

/**
 * Resolve copied call ids to registry entries and classify each against the
 * registry. Non-destructive outcomes never reject the batch: every id gets a
 * report outcome while all `released` items form one queue set the caller
 * applies exactly once (≤1 apply event per call). `ids` must be deduplicated
 * by the caller BEFORE resolution — a repeated id would otherwise double the
 * released echo.
 */
export function resolveIds(
    deps: ReduceResolverDeps & { sessionId: string },
    ids: readonly string[],
): ReduceResolveResult {
    const { db, sessionId } = deps;

    const tagsById = new Map<string, RegistryRow | undefined>();
    for (const id of ids) {
        if (tagsById.has(id)) continue;
        const rows = lookupByContentId(db, sessionId, id);
        if (rows.length === 1) tagsById.set(id, rows[0]);
        else tagsById.set(id, undefined); // 0 rows = unknown; >1 = corrupt duplicate
    }

    const pendingMap = new Map(getPendingOps(db, sessionId).map((op) => [op.tagId, op.operation]));
    const outcomes: ReduceInputOutcome[] = [];
    const toQueue: { tagNumber: number; messageId: string }[] = [];
    const seenQueue = new Set<number>();

    for (const id of ids) {
        const tag = tagsById.get(id);
        if (!tag) {
            outcomes.push({ kind: "unknown" });
            continue;
        }
        if (tag.status === "dropped" || pendingMap.get(tag.tag_number) === "drop") {
            outcomes.push({ kind: "already_released" });
            continue;
        }
        if (tag.status === "compacted") {
            outcomes.push({ kind: "already_released" });
            continue;
        }
        if (deps.inertTagNumbers?.has(tag.tag_number)) {
            outcomes.push({ kind: "refused", reason: "provider-framing" });
            continue;
        }
        if (deps.protectedTagNumbers.has(tag.tag_number)) {
            outcomes.push({ kind: "refused", reason: "protected" });
            continue;
        }
        outcomes.push({ kind: "released", messageId: tag.message_id });
        seenQueue.add(tag.tag_number);
        toQueue.push({ tagNumber: tag.tag_number, messageId: tag.message_id });
    }

    return { outcomes, releasedTagNumbers: [...new Set(toQueue.map((i) => i.tagNumber))] };
}

/** Ordered echo of released message ids, input-order, deduplicated. */
export function releasedMessageHandles(result: ReduceResolveResult): string[] {
    const handles: string[] = [];
    const seen = new Set<string>();
    for (const outcome of result.outcomes) {
        if (outcome.kind === "released" && !seen.has(outcome.messageId)) {
            seen.add(outcome.messageId);
            handles.push(outcome.messageId);
        }
    }
    return handles;
}
