import type { Database } from "../../shared/sqlite";
import { normalizeIndexText } from "./message-index";
import { getPendingOps } from "./storage-ops";
import { AGE_RECLAIM_MIN_TOKENS } from "./storage-tags";
import type { CallIdTagResolver } from "./tag-call-bridge";

/**
 * The ctx_reduce v1 pointing grammar resolver: the model addresses items by
 * copied handles (`toolcall_ids` — wire call ids; `msg_samples` — verbatim
 * text excerpts). The resolver maps each input to its tags-registry entry and
 * classifies it; the caller enqueues the released/deferred set exactly once
 * through the active backend (queuePendingOp / module), keeping a single apply
 * point per call.
 *
 * Outcome vocabulary (settled response contract): every input maps to exactly
 * one outcome in INPUT ORDER (positional slots). `error` outcomes reject the
 * whole batch before anything is enqueued (the forced retry stays
 * application-free); `noop` outcomes are non-breaking successes reported with
 * their tag; `deferred` is the protected class queued for deferred
 * application (upstream semantics).
 */

export type ReduceInputOutcome =
    | { kind: "released"; tagNumber: number }
    /** Protected: queued now, applied once newer work displaces it. */
    | { kind: "deferred"; tagNumber: number }
    /** Non-breaking success: the desired end state is or will be true. */
    | {
          kind: "noop";
          reason: "released" | "compacted" | "queued" | "inert";
          tagNumber: number;
      }
    /** Broken input: the whole batch is rejected, nothing is enqueued. */
    | {
          kind: "error";
          reason: "no-such-id" | "nowhere" | "ambiguous";
          input: string;
          candidates?: SampleCandidate[];
      };

export interface ReduceResolveResult {
    /** One outcome per input, same order as the input array (positional). */
    outcomes: ReduceInputOutcome[];
    /**
     * Internal tag numbers to enqueue (released ∪ deferred), deduplicated.
     * The resolver does NOT queue — the caller enqueues this set exactly once.
     */
    queueTagNumbers: number[];
}

interface ReduceResolverDeps {
    db: Database;
    /** Tag numbers inside the protected working set (queued deferred). */
    protectedTagNumbers: ReadonlySet<number>;
    /** Tag numbers that are provider framing (nothing reclaimable). */
    inertTagNumbers?: ReadonlySet<number>;
}

interface RegistryView {
    statusByTag: Map<number, string>;
    pendingTags: Set<number>;
}

function readRegistryView(db: Database, sessionId: string): RegistryView {
    const rows = db
        .prepare(`SELECT tag_number, status FROM tags WHERE session_id = ?`)
        .all(sessionId) as unknown as { tag_number: number; status: string }[];
    const pending = new Set(
        getPendingOps(db, sessionId)
            .filter((op) => op.operation === "drop")
            .map((op) => op.tagId),
    );
    return {
        statusByTag: new Map(rows.map((row) => [row.tag_number, row.status])),
        pendingTags: pending,
    };
}

/** Shared classification of a resolved registry tag (both lanes). */
export function classifyRegistryTag(
    deps: { protectedTagNumbers: ReadonlySet<number>; inertTagNumbers?: ReadonlySet<number> },
    registry: RegistryView,
    tagNumber: number,
): ReduceInputOutcome {
    if (registry.pendingTags.has(tagNumber)) {
        return { kind: "noop", reason: "queued", tagNumber };
    }
    const status = registry.statusByTag.get(tagNumber);
    if (status === "dropped") {
        return { kind: "noop", reason: "released", tagNumber };
    }
    if (status === "compacted") {
        return { kind: "noop", reason: "compacted", tagNumber };
    }
    if (deps.inertTagNumbers?.has(tagNumber)) {
        return { kind: "noop", reason: "inert", tagNumber };
    }
    if (deps.protectedTagNumbers.has(tagNumber)) {
        return { kind: "deferred", tagNumber };
    }
    return { kind: "released", tagNumber };
}

/**
 * The `toolcall_ids` lane: copied wire call ids resolve through the call-id
 * bridge (the registry stores no call id; the bridge pairs wire calls to tags
 * by registration rank). An id absent from the registry can only be a
 * never-existing id (ids copied from another session are session-scoped
 * misses too) — a broken input, error class. Repeated ids are allowed: each
 * occurrence keeps its slot, queueing happens once.
 */
export function resolveIds(
    deps: ReduceResolverDeps & { sessionId: string; callIdResolver: CallIdTagResolver },
    ids: readonly string[],
): ReduceResolveResult {
    if (ids.length === 0) return { outcomes: [], queueTagNumbers: [] };
    const { db, sessionId } = deps;
    const tagsById = deps.callIdResolver.resolve(ids);
    const registry = readRegistryView(db, sessionId);

    const outcomes: ReduceInputOutcome[] = [];
    const queue = new Set<number>();
    for (const id of ids) {
        const tag = tagsById.get(id);
        if (!tag) {
            outcomes.push({ kind: "error", reason: "no-such-id", input: id });
            continue;
        }
        const outcome = classifyRegistryTag(deps, registry, tag.tag_number);
        outcomes.push(outcome);
        if (outcome.kind === "released" || outcome.kind === "deferred") {
            queue.add(tag.tag_number);
        }
    }
    return { outcomes, queueTagNumbers: [...queue] };
}

/**
 * The `msg_samples` lane: the model quotes a contiguous run of a message's own
 * text, copied exactly. Resolution is the LEXICAL lane only — one FTS5 phrase
 * query over the live `message_history_fts` mirror, which absorbs case,
 * morphology, and whitespace variance on both sides.
 *
 * The registry status doubles as the visibility scope: rows whose message tag
 * is `active` are the in-window candidates (the contract path: ≥2 active is
 * the ambiguity error); the same query's non-active rows are the diagnostic —
 * text that exists in the session but whose item is already out of the window
 * or queued is a noop, never an error. Only a phrase matching no row anywhere
 * is broken input ("exists nowhere").
 */

export interface SampleCandidate {
    messageId: string;
    excerpt: string;
    /** Internal registry number, resolver-side bookkeeping. */
    tagNumber?: number;
}

const SAMPLE_MATCH_LIMIT = 30;
const SAMPLE_EXCERPT_CHARS = 120;

function ftsPhraseQuery(sample: string): string {
    const collapsed = normalizeIndexText(sample);
    if (collapsed.length === 0) return "";
    // Tokens must survive tokenization; a quote with no word characters can
    // never form a phrase.
    if (!/[\p{L}\p{N}_]/u.test(collapsed)) return "";
    const escaped = collapsed.replace(/"/g, '""');
    return `content : ("${escaped}")`;
}

interface SampleRow {
    message_id: string;
    excerpt: string;
}

export function resolveSamples(
    deps: ReduceResolverDeps & { sessionId: string },
    samples: readonly string[],
): ReduceResolveResult {
    if (samples.length === 0) return { outcomes: [], queueTagNumbers: [] };
    const { db, sessionId } = deps;
    const matchStatement = db.prepare(
        `SELECT message_id, substr(content, 1, ?) AS excerpt
           FROM message_history_fts
          WHERE session_id = ? AND message_history_fts MATCH ?
          ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC
          LIMIT ?`,
    );
    const messageTags = db.prepare(
        `SELECT tag_number, status FROM tags
          WHERE session_id = ? AND message_id = ? AND type = 'message'
          ORDER BY tag_number ASC LIMIT 2`,
    );
    const registry = readRegistryView(db, sessionId);

    const outcomes: ReduceInputOutcome[] = [];
    const queue = new Set<number>();
    for (const sample of samples) {
        const query = ftsPhraseQuery(sample);
        if (query.length === 0) {
            outcomes.push({ kind: "error", reason: "nowhere", input: sample });
            continue;
        }
        const rows = matchStatement.all(
            SAMPLE_EXCERPT_CHARS,
            sessionId,
            query,
            SAMPLE_MATCH_LIMIT,
        ) as unknown as SampleRow[];

        const live: { tagNumber: number; candidate: SampleCandidate }[] = [];
        const dead: { tagNumber: number }[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
            if (seen.has(row.message_id)) continue;
            seen.add(row.message_id);
            const tags = messageTags.all(sessionId, row.message_id) as unknown as {
                tag_number: number;
                status: string;
            }[];
            const rowTag = tags.find(
                (tag) =>
                    tag.status === "active" ||
                    tag.status === "dropped" ||
                    registry.pendingTags.has(tag.tag_number),
            );
            if (!rowTag || tags.length !== 1) continue;
            if (rowTag.status === "active" && !registry.pendingTags.has(rowTag.tag_number)) {
                live.push({
                    tagNumber: rowTag.tag_number,
                    candidate: { messageId: row.message_id, excerpt: row.excerpt },
                });
            } else {
                dead.push({ tagNumber: rowTag.tag_number });
            }
        }

        if (live.length === 1) {
            const outcome = classifyRegistryTag(deps, registry, live[0].tagNumber);
            outcomes.push(outcome);
            if (outcome.kind === "released" || outcome.kind === "deferred") {
                queue.add(live[0].tagNumber);
            }
            continue;
        }
        if (live.length > 1) {
            outcomes.push({
                kind: "error",
                reason: "ambiguous",
                input: sample,
                candidates: live
                    .slice(0, 8)
                    .map((entry) => ({ ...entry.candidate, tagNumber: entry.tagNumber })),
            });
            continue;
        }
        // Zero live candidates: the same rows carry the diagnostic (out-of-window
        // / dead-registry items are noops); zero registry rows anywhere is the
        // nowhere error.
        const diagnostic = dead.find((entry) => registry.statusByTag.has(entry.tagNumber));
        if (diagnostic) {
            outcomes.push(classifyRegistryTag(deps, registry, diagnostic.tagNumber));
            continue;
        }
        outcomes.push({ kind: "error", reason: "nowhere", input: sample });
    }
    return { outcomes, queueTagNumbers: [...queue] };
}

/**
 * The no-arg default: release everything already responded past. Selection is
 * the tool-output class only — active, unscheduled tool tags outside the
 * protected working set, past the token floor (sub-floor items cost more in
 * transform bytes than they save), and strictly BEFORE the newest user
 * message: in-flight work of the current turn is structurally unreachable by
 * the default. Text shells are deliberately NOT bulk-collected: they are the
 * conversation's reference anchors, and their surgical release is what
 * `msg_samples` is for. Protected items are NOT queued here (nothing was
 * pointed at them; the model's explicit call is what defers them).
 */
export function resolveBulkDefault(deps: ReduceResolverDeps & { sessionId: string }): {
    releasedTagNumbers: number[];
    inertTagNumbers: number[];
    protectedTagNumbers: number[];
} {
    const { db, sessionId } = deps;
    const lastUser = db
        .prepare(
            `SELECT MAX(CAST(message_ordinal AS INTEGER)) AS ordinal
               FROM message_history_fts
              WHERE session_id = ? AND role = 'user'`,
        )
        .get(sessionId) as { ordinal: number | null } | undefined;

    const ordinalClause =
        typeof lastUser?.ordinal === "number"
            ? `AND (fts.message_ordinal IS NULL OR CAST(fts.message_ordinal AS INTEGER) < ?)`
            : "";
    const statement = db.prepare(
        `SELECT t.tag_number, t.message_id
           FROM tags t
           LEFT JOIN message_history_fts fts
             ON fts.session_id = t.session_id AND fts.message_id = t.message_id
          WHERE t.session_id = ?
            AND t.status = 'active'
            AND t.type = 'tool'
            AND NOT EXISTS (
                SELECT 1 FROM pending_ops
                 WHERE pending_ops.session_id = t.session_id
                   AND pending_ops.tag_id = t.tag_number
                   AND pending_ops.operation = 'drop'
            )
            AND ((t.token_count IS NULL AND t.input_token_count IS NULL)
                 OR (COALESCE(t.token_count, 0) + COALESCE(t.input_token_count, 0)) >= ?)
            ${ordinalClause}
          ORDER BY t.tag_number ASC`,
    );
    const rows = (typeof lastUser?.ordinal === "number"
        ? statement.all(sessionId, AGE_RECLAIM_MIN_TOKENS, lastUser.ordinal)
        : statement.all(sessionId, AGE_RECLAIM_MIN_TOKENS)) as unknown as {
        tag_number: number;
        message_id: string;
    }[];

    const releasedTagNumbers: number[] = [];
    const inert: number[] = [];
    const protectedTags: number[] = [];
    for (const row of rows) {
        if (deps.inertTagNumbers?.has(row.tag_number)) {
            inert.push(row.tag_number);
            continue;
        }
        if (deps.protectedTagNumbers.has(row.tag_number)) {
            protectedTags.push(row.tag_number);
            continue;
        }
        releasedTagNumbers.push(row.tag_number);
    }
    return { releasedTagNumbers, inertTagNumbers: inert, protectedTagNumbers: protectedTags };
}
