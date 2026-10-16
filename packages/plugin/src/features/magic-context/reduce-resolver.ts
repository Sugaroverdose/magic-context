import type { Database } from "../../shared/sqlite";
import { normalizeIndexText } from "./message-index";
import { getPendingOps } from "./storage-ops";
import { AGE_RECLAIM_MIN_TOKENS } from "./storage-tags";

/**
 * The ids lane of the ctx_reduce v1 pointing grammar: the model copies wire
 * call ids; the resolver maps each to its tags-registry entry and hands the
 * internal tag numbers to the existing drop engine (queuePendingOp /
 * protection window). Resolution keys on `tags.content_id` (the wire call id,
 * the same key the FPE resolver uses); ids are session-scoped lookups — an id
 * copied from another session is `unknown` here, never a foreign release.
 */

export type ReduceInputOutcome =
    | { kind: "released"; messageId: string; tagNumber: number }
    | { kind: "already_released"; tagNumber: number }
    | { kind: "refused"; reason: "protected"; tagNumber?: number }
    /** Noop success: whitespace-only provider framing, nothing reclaimable. */
    | { kind: "noop"; reason: "provider-framing"; tagNumber: number }
    | { kind: "unknown" }
    /** Sample matched no live visible item (report-only, non-destructive). */
    | { kind: "no-match" }
    /** Sample matched >1 live visible item: the only batch-rejecting class. */
    | { kind: "ambiguous"; candidates: SampleCandidate[] };

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
            outcomes.push({ kind: "already_released", tagNumber: tag.tag_number });
            continue;
        }
        if (tag.status === "compacted") {
            outcomes.push({ kind: "already_released", tagNumber: tag.tag_number });
            continue;
        }
        if (deps.inertTagNumbers?.has(tag.tag_number)) {
            outcomes.push({ kind: "noop", reason: "provider-framing", tagNumber: tag.tag_number });
            continue;
        }
        if (deps.protectedTagNumbers.has(tag.tag_number)) {
            outcomes.push({ kind: "refused", reason: "protected", tagNumber: tag.tag_number });
            continue;
        }
        outcomes.push({ kind: "released", messageId: tag.message_id, tagNumber: tag.tag_number });
        seenQueue.add(tag.tag_number);
        toQueue.push({ tagNumber: tag.tag_number, messageId: tag.message_id });
    }

    return { outcomes, releasedTagNumbers: [...new Set(toQueue.map((i) => i.tagNumber))] };
}

/**
 * Ordered echo of the released items' registry tags, input-order, deduplicated.
 * Tags are the plugin's addressing mechanism — the echo is directly reusable
 * as `ctx_expand(tag=N)` without teaching any new handle format.
 */
export function releasedTagHandles(result: ReduceResolveResult): number[] {
    return successTagHandles(result.outcomes);
}

/**
 * Success array: one tag per input that landed (freshly released or noop),
 * input order, deduplicated. Noop facts are NOT marked inside the array —
 * they are reported outside as separate info lines (settled response shape:
 * the array mirrors the input, the reasons annotate it from the outside).
 */
export function successTagHandles(outcomes: readonly ReduceInputOutcome[]): number[] {
    const handles: number[] = [];
    const seen = new Set<number>();
    for (const outcome of outcomes) {
        if (
            (outcome.kind === "released" ||
                outcome.kind === "already_released" ||
                outcome.kind === "noop") &&
            !seen.has(outcome.tagNumber)
        ) {
            seen.add(outcome.tagNumber);
            handles.push(outcome.tagNumber);
        }
    }
    return handles;
}

/** Tag lists for the noop entries, grouped by reason, for outside-array info lines. */
export function noopTagLists(outcomes: readonly ReduceInputOutcome[]): {
    alreadyReleased: number[];
    nothingToReclaim: number[];
} {
    const alreadyReleased: number[] = [];
    const nothingToReclaim: number[] = [];
    for (const outcome of outcomes) {
        if (outcome.kind === "already_released" && !alreadyReleased.includes(outcome.tagNumber)) {
            alreadyReleased.push(outcome.tagNumber);
        } else if (outcome.kind === "noop" && !nothingToReclaim.includes(outcome.tagNumber)) {
            nothingToReclaim.push(outcome.tagNumber);
        }
    }
    return { alreadyReleased, nothingToReclaim };
}

/** Input handles (index into the array) for the given outcome kinds, in order. */
export function inputHandlesFor(
    outcomes: readonly ReduceInputOutcome[],
    kinds: ReduceInputOutcome["kind"][],
): number[] {
    const out: number[] = [];
    outcomes.forEach((outcome, index) => {
        if (kinds.includes(outcome.kind)) out.push(index);
    });
    return out;
}

/**
 * The samples lane: the model quotes a contiguous run of an item's own text,
 * copied exactly. Resolution is the LEXICAL lane only — one FTS5 phrase
 * query over the live `message_history_fts` mirror (tokenize='porter
 * unicode61', content-only so role terms never leak in), which absorbs case,
 * morphology, and whitespace variance on BOTH sides: the mirror indexes
 * whitespace-collapsed text, so a copied run matches its source modulo
 * whitespace runs even though neither side rewrites the other.
 *
 * A phrase matches MESSAGES (the mirror is per-message), which is exactly the
 * message-shell release class; the candidate must own a live `message` tag —
 * an FTS hit whose message has no registry handle is not a release candidate
 * at all ("what you cannot see is not a candidate"). More than one live
 * candidate is the ONE batch-rejecting class: the caller must reject the
 * whole call before applying anything (the forced retry must be
 * application-free, ≤1 apply event per reduce intent).
 */

export interface SampleCandidate {
    messageId: string;
    excerpt: string;
    /** Internal registry number, resolver-side bookkeeping. */
    tagNumber?: number;
}

export type SampleOutcome =
    | { kind: "matched"; tagNumber: number; messageId: string }
    | { kind: "no-match" }
    | { kind: "ambiguous"; candidates: SampleCandidate[] };

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
    db: Database,
    sessionId: string,
    samples: readonly string[],
): SampleOutcome[] {
    if (samples.length === 0) return [];
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

    return samples.map((sample): SampleOutcome => {
        const query = ftsPhraseQuery(sample);
        if (query.length === 0) return { kind: "no-match" };

        const rows = matchStatement.all(
            SAMPLE_EXCERPT_CHARS,
            sessionId,
            query,
            SAMPLE_MATCH_LIMIT,
        ) as unknown as SampleRow[];

        const live: { tagNumber: number; candidate: SampleCandidate }[] = [];
        const seen = new Set<string>();
        for (const row of rows) {
            if (seen.has(row.message_id)) continue;
            seen.add(row.message_id);
            const tags = messageTags.all(sessionId, row.message_id) as unknown as {
                tag_number: number;
                status: string;
            }[];
            const liveTag = tags.find((tag) => tag.status === "active");
            // Registry-absent, corrupt-duplicate, or non-active matches are
            // not release candidates at all: "what you cannot see is not a
            // candidate". Ambiguity is computed over LIVE matches only.
            if (liveTag && tags.length === 1) {
                live.push({
                    tagNumber: liveTag.tag_number,
                    candidate: { messageId: row.message_id, excerpt: row.excerpt },
                });
            }
        }

        if (live.length === 0) return { kind: "no-match" };
        if (live.length === 1) {
            const only = live[0];
            return {
                kind: "matched",
                tagNumber: only.tagNumber,
                messageId: only.candidate.messageId,
            };
        }
        return {
            kind: "ambiguous",
            candidates: live
                .slice(0, 8)
                .map((entry) => ({ ...entry.candidate, tagNumber: entry.tagNumber })),
        };
    });
}

/**
 * Classify a sample-matched message tag against the same protection/pending
 * state the ids lane uses. Returns the shared input-outcome vocabulary.
 */
export function classifyMessageTag(
    deps: {
        db: Database;
        sessionId: string;
        protectedTagNumbers: ReadonlySet<number>;
        inertTagNumbers?: ReadonlySet<number>;
    },
    outcome: Extract<SampleOutcome, { kind: "matched" }>,
): ReduceInputOutcome {
    const pending = getPendingOps(deps.db, deps.sessionId);
    if (pending.some((op) => op.tagId === outcome.tagNumber && op.operation === "drop")) {
        return { kind: "already_released", tagNumber: outcome.tagNumber };
    }
    if (deps.inertTagNumbers?.has(outcome.tagNumber)) {
        return { kind: "noop", reason: "provider-framing", tagNumber: outcome.tagNumber };
    }
    if (deps.protectedTagNumbers.has(outcome.tagNumber)) {
        return { kind: "refused", reason: "protected", tagNumber: outcome.tagNumber };
    }
    return { kind: "released", messageId: outcome.messageId, tagNumber: outcome.tagNumber };
}

/**
 * The no-arg default: release everything already responded past. Selection is
 * the tool-output class only — active, unscheduled tool tags outside the
 * protected working set, past the token floor (sub-floor items cost more in
 * transform bytes than they save), and strictly BEFORE the newest user
 * message: in-flight work of the current turn is structurally unreachable by
 * the default, whatever the protection window's tail membership says. Text
 * shells are deliberately NOT bulk-collected: they are the conversation's
 * reference anchors, and their surgical release is what `samples` is for.
 * The same report-only outcome vocabulary applies (inert framing is skipped,
 * protected is excluded by construction, so what remains simply releases).
 */
export function resolveBulkDefault(
    deps: ReduceResolverDeps & { sessionId: string },
): ReduceResolveResult {
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

    const outcomes: ReduceInputOutcome[] = [];
    const releasedTagNumbers: number[] = [];
    for (const row of rows) {
        if (deps.inertTagNumbers?.has(row.tag_number)) {
            outcomes.push({ kind: "noop", reason: "provider-framing", tagNumber: row.tag_number });
            continue;
        }
        if (deps.protectedTagNumbers.has(row.tag_number)) {
            outcomes.push({ kind: "refused", reason: "protected", tagNumber: row.tag_number });
            continue;
        }
        outcomes.push({ kind: "released", messageId: row.message_id, tagNumber: row.tag_number });
        releasedTagNumbers.push(row.tag_number);
    }
    return { outcomes, releasedTagNumbers };
}
