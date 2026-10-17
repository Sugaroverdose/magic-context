import type { Database } from "../../shared/sqlite";
import { normalizeIndexText } from "./message-index";
import { getPendingOps } from "./storage-ops";
import { AGE_RECLAIM_MIN_TOKENS } from "./storage-tags";
import type { CallIdTagResolver } from "./tag-call-bridge";

/**
 * The ctx_reduce v1 pointing grammar resolver (Rev 5.3 + D18).
 *
 * The model addresses items through ONE array, `ctx_handles`: each entry is
 * either a wire call id copied exactly, a verbatim run of an item's own text,
 * or a range `<A>..<B>` naming the inclusive stretch between two such
 * handles. The resolver maps every entry to its tags-registry entries and
 * classifies them; the caller enqueues the released/deferred set exactly
 * once through the active backend (queuePendingOp / module), keeping a single
 * apply point per call.
 *
 * Entry resolution is by FORM, in strict order (D18 parse order):
 *   1. exact live call-id registry hit  -> the id lane;
 *   2. lexical phrase match of the FULL entry (live candidate or the
 *      same-query dead-registry diagnostic) -> the text lane;
 *   3. only when the full entry matched nowhere and contains `..`:
 *      the range lane, endpoints resolved through the same two lanes.
 * A literal `..` inside a quote therefore survives as phrase text.
 *
 * Outcome vocabulary (settled response contract): every entry maps to exactly
 * one outcome in INPUT ORDER (positional mirror). `error` outcomes reject the
 * whole batch before anything is enqueued (the forced retry stays
 * application-free); `noop` outcomes are non-breaking successes; `deferred`
 * is the protected class queued for deferred application (upstream
 * semantics); `range` is a composite whose slots the renderer echoes as the
 * ordinal span, with the per-item classes of the stretch inside it.
 */

export interface OrdinalMint {
    /** Host message order: message id -> 1-based ordinal in the session. */
    ordinalByMessageId: Map<string, number>;
}

export interface HandleItemRef {
    tagNumber: number;
    messageId: string;
}

export type ReduceInputOutcome =
    | { kind: "released"; tagNumber: number; messageId: string }
    /** Protected: queued now, applied once newer work displaces it. */
    | { kind: "deferred"; tagNumber: number; messageId: string }
    /** Non-breaking success: the desired end state is or will be true. */
    | {
          kind: "noop";
          reason: "released" | "compacted" | "queued" | "inert";
          tagNumber: number;
          messageId: string;
      }
    /**
     * Composite stretch outcome: the endpoints resolved, direction holds,
     * and every item inside the inclusive span was classified. Never
     * contains error items (endpoint errors surface at entry level).
     */
    | {
          kind: "range";
          fromOrdinal: number;
          toOrdinal: number;
          items: ReduceInputOutcome[];
      }
    /** Broken entry: the whole batch is rejected, nothing is enqueued. */
    | {
          kind: "error";
          reason: "ambiguous" | "not-found" | "reversed";
          input: string;
          candidates?: SampleCandidate[];
          /** Set when the failure happened inside a range entry. */
          range?: { entry: string; which: "start" | "end" | "both" };
      };

export interface ReduceResolveResult {
    /** One outcome per entry, same order as the input array (positional). */
    outcomes: ReduceInputOutcome[];
    /**
     * Internal tag numbers to enqueue (released ∪ deferred, entries and
     * range-inside items), deduplicated. The resolver does NOT queue — the
     * caller enqueues this set exactly once.
     */
    queueTagNumbers: number[];
    /**
     * Infrastructure failure (ordinal mint unavailable for a message the
     * batch needs): reported as-is by the tool, never an input class and
     * never a fabricated value.
     */
    internalError?: string;
}

interface ReduceResolverDeps {
    db: Database;
    /** Tag numbers inside the protected working set (queued deferred). */
    protectedTagNumbers: ReadonlySet<number>;
    /** Tag numbers that are provider framing (nothing reclaimable). */
    inertTagNumbers?: ReadonlySet<number>;
}

export interface HandleResolverDeps extends ReduceResolverDeps {
    sessionId: string;
    callIdResolver: CallIdTagResolver;
    /** Host message order; required by range entries and the echo mint. */
    mint?: OrdinalMint;
}

interface ReduceStatements {
    match: { all(...args: unknown[]): unknown[] };
    messageTags: { all(...args: unknown[]): unknown[] };
}

interface RegistryView {
    statusByTag: Map<number, string>;
    messageIdByTag: Map<number, string>;
    pendingTags: Set<number>;
}

function readRegistryView(db: Database, sessionId: string): RegistryView {
    const rows = db
        .prepare(`SELECT tag_number, message_id, status FROM tags WHERE session_id = ?`)
        .all(sessionId) as unknown as {
        tag_number: number;
        message_id: string;
        status: string;
    }[];
    const pending = new Set(
        getPendingOps(db, sessionId)
            .filter((op) => op.operation === "drop")
            .map((op) => op.tagId),
    );
    return {
        statusByTag: new Map(rows.map((row) => [row.tag_number, row.status])),
        messageIdByTag: new Map(rows.map((row) => [row.tag_number, row.message_id])),
        pendingTags: pending,
    };
}

/** Shared classification of a resolved registry tag. */
export function classifyRegistryTag(
    deps: { protectedTagNumbers: ReadonlySet<number>; inertTagNumbers?: ReadonlySet<number> },
    registry: RegistryView,
    tagNumber: number,
): ReduceInputOutcome {
    const messageId = registry.messageIdByTag.get(tagNumber) ?? "";
    if (registry.pendingTags.has(tagNumber)) {
        return { kind: "noop", reason: "queued", tagNumber, messageId };
    }
    const status = registry.statusByTag.get(tagNumber);
    if (status === "dropped") {
        return { kind: "noop", reason: "released", tagNumber, messageId };
    }
    if (status === "compacted") {
        return { kind: "noop", reason: "compacted", tagNumber, messageId };
    }
    if (deps.inertTagNumbers?.has(tagNumber)) {
        return { kind: "noop", reason: "inert", tagNumber, messageId };
    }
    if (deps.protectedTagNumbers.has(tagNumber)) {
        return { kind: "deferred", tagNumber, messageId };
    }
    return { kind: "released", tagNumber, messageId };
}

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

interface PhraseOutcome {
    outcome: ReduceInputOutcome;
}

/**
 * The text lane for one full string: the LEXICAL lane only — one FTS5 phrase
 * query over the live `message_history_fts` mirror, which absorbs case,
 * morphology, and whitespace variance on both sides. The registry status
 * doubles as the visibility scope: rows whose message tag is `active` are the
 * in-window candidates (≥2 active is the ambiguity error); the same query's
 * non-active rows are the diagnostic — text whose item is out of the window
 * or queued is a noop, never an error. Only a phrase matching no row anywhere
 * "exists nowhere" (the caller may still fall through to the range lane).
 */
function resolvePhrase(
    deps: ReduceResolverDeps & { sessionId: string },
    registry: RegistryView,
    statements: ReduceStatements,
    text: string,
): PhraseOutcome {
    const { sessionId } = deps;
    const query = ftsPhraseQuery(text);
    if (query.length === 0) {
        return { outcome: { kind: "error", reason: "not-found", input: text } };
    }
    const rows = statements.match.all(
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
        const tags = statements.messageTags.all(sessionId, row.message_id) as unknown as {
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
        return { outcome: classifyRegistryTag(deps, registry, live[0].tagNumber) };
    }
    if (live.length > 1) {
        return {
            outcome: {
                kind: "error",
                reason: "ambiguous",
                input: text,
                candidates: live
                    .slice(0, 8)
                    .map((entry) => ({ ...entry.candidate, tagNumber: entry.tagNumber })),
            },
        };
    }
    // Zero live candidates: the same rows carry the diagnostic (out-of-window
    // / dead-registry items are noops); zero registry rows anywhere matched
    // nothing.
    const diagnostic = dead.find((entry) => registry.statusByTag.has(entry.tagNumber));
    if (diagnostic) {
        return { outcome: classifyRegistryTag(deps, registry, diagnostic.tagNumber) };
    }
    return { outcome: { kind: "error", reason: "not-found", input: text } };
}

/**
 * Resolve one string to a registry position through the two pointing lanes
 * (id hit, then phrase). Used for plain entries and for range endpoints
 * alike; classification is NOT applied (endpoints are geometry, not claims).
 */
function resolvePosition(
    deps: HandleResolverDeps,
    registry: RegistryView,
    statements: ReduceStatements,
    callIdResolver: CallIdTagResolver,
    text: string,
): { tag: HandleItemRef } | { error: Extract<ReduceInputOutcome, { kind: "error" }> } {
    const direct = callIdResolver.resolve([text]).get(text);
    if (direct) {
        return { tag: { tagNumber: direct.tag_number, messageId: direct.message_id } };
    }
    const phrase = resolvePhrase(deps, registry, statements, text).outcome;
    if (phrase.kind === "error") {
        return { error: phrase };
    }
    if (phrase.kind === "range") {
        // Unreachable: the phrase lane never produces range outcomes.
        return { error: { kind: "error", reason: "not-found", input: text } };
    }
    return { tag: { tagNumber: phrase.tagNumber, messageId: phrase.messageId } };
}

const RANGE_SEPARATOR = "..";

function splitRangeEntry(entry: string): { from: string; to: string } | undefined {
    const index = entry.indexOf(RANGE_SEPARATOR);
    if (index <= 0) return undefined;
    const from = entry.slice(0, index).trim();
    const to = entry.slice(index + RANGE_SEPARATOR.length).trim();
    if (from.length === 0 || to.length === 0) return undefined;
    return { from, to };
}

interface SpanMembership {
    tagNumber: number;
    messageId: string;
    ordinal: number;
    tagOrder: number;
}

/**
 * The merged `ctx_handles` lane (Rev 5.3): form resolution in strict order —
 * id hit, phrase of the full entry, range split as strict fallback. Repeated
 * entries are allowed: each occurrence keeps its slot, queueing happens once.
 */
export function resolveHandles(
    deps: HandleResolverDeps,
    entries: readonly string[],
): ReduceResolveResult {
    if (entries.length === 0) return { outcomes: [], queueTagNumbers: [] };
    const { db, sessionId } = deps;
    const match = db.prepare(
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
    const statements = { match, messageTags };
    const registry = readRegistryView(db, sessionId);
    const tagsById = deps.callIdResolver.resolve(entries);

    const outcomes: ReduceInputOutcome[] = [];
    const queue = new Set<number>();
    const collect = (outcome: ReduceInputOutcome) => {
        outcomes.push(outcome);
        if (outcome.kind === "released" || outcome.kind === "deferred") {
            queue.add(outcome.tagNumber);
        }
        if (outcome.kind === "range") {
            for (const item of outcome.items) {
                if (item.kind === "released" || item.kind === "deferred") {
                    queue.add(item.tagNumber);
                }
            }
        }
    };

    const ordinalOf = (messageId: string): number | undefined =>
        deps.mint?.ordinalByMessageId.get(messageId);

    for (const entry of entries) {
        const direct = tagsById.get(entry);
        if (direct) {
            collect(classifyRegistryTag(deps, registry, direct.tag_number));
            continue;
        }
        const phrase = resolvePhrase(deps, registry, statements, entry).outcome;
        if (phrase.kind !== "error" || phrase.reason === "ambiguous") {
            collect(phrase);
            continue;
        }
        const range = splitRangeEntry(entry);
        if (!range) {
            collect({ kind: "error", reason: "not-found", input: entry });
            continue;
        }
        if (!deps.mint) {
            return {
                outcomes,
                queueTagNumbers: [...queue],
                internalError: "Error: message positions are unavailable for range entries.",
            };
        }
        const start = resolvePosition(deps, registry, statements, deps.callIdResolver, range.from);
        if ("error" in start) {
            collect({
                ...start.error,
                range: { entry, which: "start" },
            });
            continue;
        }
        const end = resolvePosition(deps, registry, statements, deps.callIdResolver, range.to);
        if ("error" in end) {
            collect({
                ...end.error,
                range: { entry, which: "end" },
            });
            continue;
        }
        const fromOrdinal = ordinalOf(start.tag.messageId);
        const toOrdinal = ordinalOf(end.tag.messageId);
        if (fromOrdinal === undefined || toOrdinal === undefined) {
            return {
                outcomes,
                queueTagNumbers: [...queue],
                internalError:
                    "Error: could not resolve message positions for the range endpoints.",
            };
        }
        if (fromOrdinal > toOrdinal) {
            collect({ kind: "error", reason: "reversed", input: entry });
            continue;
        }
        // Inclusive enumeration of the stretch (D18): every registered item
        // between the endpoints, ordered by message position then registry
        // order; the per-item classes apply inside (a range cannot smuggle a
        // protected item past the report discipline).
        const span = collectSpanItems(
            db,
            sessionId,
            deps.mint,
            start.tag,
            end.tag,
            fromOrdinal,
            toOrdinal,
        );
        if (span === "reversed") {
            collect({ kind: "error", reason: "reversed", input: entry });
            continue;
        }
        if (span === "missing") {
            return {
                outcomes,
                queueTagNumbers: [...queue],
                internalError: "Error: range endpoints do not name registered items.",
            };
        }
        const items: ReduceInputOutcome[] = [];
        for (const membership of span) {
            const item = classifyRegistryTag(deps, registry, membership.tagNumber);
            items.push(item);
            if (item.kind === "released" || item.kind === "deferred") {
                queue.add(item.tagNumber);
            }
        }
        outcomes.push({ kind: "range", fromOrdinal, toOrdinal, items });
    }
    return { outcomes, queueTagNumbers: [...queue] };
}

function collectSpanItems(
    db: Database,
    sessionId: string,
    mint: OrdinalMint,
    start: HandleItemRef,
    end: HandleItemRef,
    fromOrdinal: number,
    toOrdinal: number,
): SpanMembership[] | "reversed" | "missing" {
    const messageIdsInSpan: { messageId: string; ordinal: number }[] = [];
    for (const [messageId, ordinal] of mint.ordinalByMessageId) {
        if (ordinal >= fromOrdinal && ordinal <= toOrdinal) {
            messageIdsInSpan.push({ messageId, ordinal });
        }
    }
    if (messageIdsInSpan.length === 0) return "missing";
    messageIdsInSpan.sort((a, b) => a.ordinal - b.ordinal);

    const rows: { tag_number: number; message_id: string }[] = [];
    const CHUNK = 400;
    for (let offset = 0; offset < messageIdsInSpan.length; offset += CHUNK) {
        const chunk = messageIdsInSpan.slice(offset, offset + CHUNK);
        const placeholders = chunk.map(() => "?").join(",");
        const chunkRows = db
            .prepare(
                `SELECT tag_number, message_id FROM tags
                  WHERE session_id = ? AND message_id IN (${placeholders})
                  ORDER BY tag_number ASC`,
            )
            .all(sessionId, ...chunk.map((entry) => entry.messageId)) as unknown as {
            tag_number: number;
            message_id: string;
        }[];
        rows.push(...chunkRows);
    }

    const ordinalByMessage = new Map(
        messageIdsInSpan.map((entry) => [entry.messageId, entry.ordinal]),
    );
    const memberships = rows
        .map((row) => ({
            tagNumber: row.tag_number,
            messageId: row.message_id,
            ordinal: ordinalByMessage.get(row.message_id) ?? 0,
            tagOrder: row.tag_number,
        }))
        .sort((a, b) => a.ordinal - b.ordinal || a.tagOrder - b.tagOrder);

    // Bound to the endpoints themselves (inclusive). Endpoint tags exist by
    // construction; the bounds keep same-message stretches precise. A
    // same-message stretch whose endpoints invert in registration order is
    // the reversed case, not a miss.
    const startIndex = memberships.findIndex((m) => m.tagNumber === start.tagNumber);
    const endIndex = memberships.findIndex((m) => m.tagNumber === end.tagNumber);
    if (startIndex < 0 || endIndex < 0) return "missing";
    if (startIndex > endIndex) return "reversed";
    return memberships.slice(startIndex, endIndex + 1);
}

/**
 * The no-arg default: release everything already responded past. Selection is
 * the tool-output class only — active, unscheduled tool tags outside the
 * protected working set, past the token floor (sub-floor items cost more in
 * transform bytes than they save), and strictly BEFORE the newest user
 * message: in-flight work of the current turn is structurally unreachable by
 * the default. Text shells are deliberately NOT bulk-collected: they are the
 * conversation's reference anchors, and their surgical release is what the
 * pointing grammar is for. Protected items are NOT queued here (nothing was
 * pointed at them; the model's explicit call is what defers them).
 */
export function resolveBulkDefault(deps: ReduceResolverDeps & { sessionId: string }): {
    releasedItems: HandleItemRef[];
    inertItems: HandleItemRef[];
    protectedItems: HandleItemRef[];
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

    const releasedItems: HandleItemRef[] = [];
    const inertItems: HandleItemRef[] = [];
    const protectedItems: HandleItemRef[] = [];
    for (const row of rows) {
        const item = { tagNumber: row.tag_number, messageId: row.message_id };
        if (deps.inertTagNumbers?.has(row.tag_number)) {
            inertItems.push(item);
            continue;
        }
        if (deps.protectedTagNumbers.has(row.tag_number)) {
            protectedItems.push(item);
            continue;
        }
        releasedItems.push(item);
    }
    return { releasedItems, inertItems, protectedItems };
}
