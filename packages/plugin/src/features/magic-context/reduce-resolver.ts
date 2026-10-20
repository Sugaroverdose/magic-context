import type { Database } from "../../shared/sqlite";
import { normalizeIndexText } from "./message-index";
import { getPendingOps } from "./storage-ops";
import { AGE_RECLAIM_MIN_TOKENS } from "./storage-tags";
import type { CallIdTagResolver } from "./tool-call-registry";

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
    /** Host message order: bare message id -> 1-based ordinal in the session. */
    ordinalByMessageId: Map<string, number>;
    /** Wire call id -> the ordinal of its owner message (tool registry rows). */
    ordinalByCallId?: Map<string, number>;
    /**
     * Ordinal of the newest user message in the canonical space (live store).
     * The bulk lane's boundary: nothing newer than this is reclaimable.
     */
    latestUserOrdinal?: number;
}

/** Strip the registry's text-content suffix (`:pK`) from a message key. */
export function registryMessageBase(messageId: string): string {
    return messageId.replace(/:p\d+$/, "");
}

/**
 * Pi synthetic registration keys (`pi-msg-<ordinal>-<ts>-<role>`) freeze the
 * birth position into the key. Pi histories are append-only, so the embedded
 * ordinal stays the canonical position after id adoption would have.
 */
const SYNTHETIC_PI_MESSAGE_KEY = /^pi-msg-(\d+)-/;

function syntheticBirthOrdinal(key: string): number | undefined {
    const match = SYNTHETIC_PI_MESSAGE_KEY.exec(key);
    if (!match) return undefined;
    const ordinal = Number(match[1]);
    return Number.isFinite(ordinal) && ordinal > 0 ? ordinal : undefined;
}

/**
 * Resolve the canonical ordinal for any key a registry row can carry:
 * bare message id (mirror / file rows), suffixed content key `base:pK`
 * (message rows), wire call id (tool rows), or a Pi synthetic registration
 * key whose birth ordinal is embedded in the grammar. `undefined` means the
 * key does not name a positioned message — never a guessed position.
 */
export function ordinalForRegistryKey(
    mint: OrdinalMint | undefined,
    key: string,
): number | undefined {
    if (!mint) return undefined;
    const direct = mint.ordinalByMessageId.get(key) ?? mint.ordinalByCallId?.get(key);
    if (typeof direct === "number") return direct;
    const base = registryMessageBase(key);
    if (base === key) return syntheticBirthOrdinal(key);
    const live = mint.ordinalByMessageId.get(base);
    if (typeof live === "number") return live;
    return syntheticBirthOrdinal(base);
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
     * Composite stretch outcome: the endpoints resolved and every tag
     * between them (registration order, inclusive, direction-agnostic)
     * was classified. Never contains error items (endpoint errors surface
     * at entry level). Ordinals mint the echo slot; an unpositionable
     * endpoint falls back to echoing the entry itself.
     */
    | {
          kind: "range";
          fromOrdinal?: number;
          toOrdinal?: number;
          items: ReduceInputOutcome[];
      }
    /** Broken entry: the whole batch is rejected, nothing is enqueued. */
    | {
          kind: "error";
          reason: "ambiguous" | "not-found";
          input: string;
          candidates?: SampleCandidate[];
          /** Set when the failure happened inside a range entry. */
          range?: { entry: string; which: "start" | "end" | "both" };
          /**
           * The entry tokenizes to zero tokens (pure punctuation/decoration):
           * the index is mute about it and no scan runs (S-2). The report
           * names the shape so the caller re-points by prose or call id.
           */
          zeroToken?: true;
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
    /** S-2 byte-verify lane: MATCH shortlist narrowed by a literal substring. */
    verify: { all(...args: unknown[]): unknown[] };
}

interface RegistryView {
    statusByTag: Map<number, string>;
    messageIdByTag: Map<number, string>;
    typeByTag: Map<number, string>;
    tokensByTag: Map<number, number | null>;
    pendingTags: Set<number>;
    /** Message-class tags keyed by the bare message id (`base` of `base:pK`). */
    tagNumbersByMessageBase: Map<string, number[]>;
}

function readRegistryView(db: Database, sessionId: string): RegistryView {
    const rows = db
        .prepare(
            `SELECT tag_number, message_id, status, type, token_count, input_token_count
               FROM tags WHERE session_id = ?`,
        )
        .all(sessionId) as unknown as {
        tag_number: number;
        message_id: string;
        status: string;
        type: string;
        token_count: number | null;
        input_token_count: number | null;
    }[];
    const pending = new Set(
        getPendingOps(db, sessionId)
            .filter((op) => op.operation === "drop")
            .map((op) => op.tagId),
    );
    const tagNumbersByMessageBase = new Map<string, number[]>();
    for (const row of rows) {
        if (row.type !== "message") continue;
        const base = registryMessageBase(row.message_id);
        const existing = tagNumbersByMessageBase.get(base);
        if (existing) existing.push(row.tag_number);
        else tagNumbersByMessageBase.set(base, [row.tag_number]);
    }
    for (const list of tagNumbersByMessageBase.values()) list.sort((a, b) => a - b);
    return {
        statusByTag: new Map(rows.map((row) => [row.tag_number, row.status])),
        messageIdByTag: new Map(rows.map((row) => [row.tag_number, row.message_id])),
        typeByTag: new Map(rows.map((row) => [row.tag_number, row.type])),
        tokensByTag: new Map(
            rows.map((row) => [
                row.tag_number,
                row.token_count === null && row.input_token_count === null
                    ? null
                    : (row.token_count ?? 0) + (row.input_token_count ?? 0),
            ]),
        ),
        pendingTags: pending,
        tagNumbersByMessageBase,
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

/**
 * S-2 byte-verify predicate. The shortlist is fetched by the same MATCH,
 * then each row's full content is tested with a substring check. The check
 * collapses whitespace runs to a single space on BOTH sides (the mirror
 * normalizes the index text the same way, so a tab/spaces copy-drift is the
 * accepted absorbed surface, not a survivor discriminator) and is
 * ASCII-case-insensitive, matching the index lane's case absorption.
 * Interior punctuation is faithful — that is where the identity signal lives,
 * and the one case the head/tail-trim ruling does not cover. SQLite `LIKE`
 * is not used: its `%`/`_` wildcards would need escaping and it cannot
 * express the whitespace-collapse the index contract requires.
 */
function isByteSurvivor(content: string, entry: string): boolean {
    return collapseWhitespace(content).includes(collapseWhitespace(entry));
}

function collapseWhitespace(text: string): string {
    return text.toLowerCase().replace(/\s+/g, " ").trim();
}

interface SampleRow {
    message_id: string;
    excerpt: string;
}

interface PhraseOutcome {
    outcome: ReduceInputOutcome;
}

/**
 * The text lane for one full string: the LEXICAL lane — one FTS5 phrase
 * query over the live `message_history_fts` mirror, which absorbs case,
 * morphology, and whitespace variance on both sides. The registry status
 * doubles as the visibility scope: rows whose message tag is `active` are the
 * in-window candidates; the same query's non-active rows are the diagnostic —
 * text whose item is out of the window or queued is a noop, never an error.
 * Decision gate (S-2): unique skeleton hit stamps with no byte check;
 * ≥2 hits run the substring verify over the shortlist and the SURVIVORS
 * decide (1 → stamp, 0 → not-found without naming ghosts, ≥2 → found-twice
 * listing survivors). Zero skeleton hits means byte-emptiness for a
 * token-bearing entry (the index and LIKE share the tokenization boundary):
 * not-found, no scan. The caller may still fall through to the range lane.
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
        // Zero-token entry (pure punctuation/arrows/marks): the index has no
        // terms to query and NO byte scan runs — decoration points via the
        // call id of what it decorates (S-1 form law). Report names the shape.
        return {
            outcome: { kind: "error", reason: "not-found", input: text, zeroToken: true },
        };
    }
    const rows = statements.match.all(
        SAMPLE_EXCERPT_CHARS,
        sessionId,
        query,
        SAMPLE_MATCH_LIMIT,
    ) as unknown as SampleRow[];

    type LiveRow = { tagNumber: number; candidate: SampleCandidate };
    const joinRows = (
        source: SampleRow[],
        live: LiveRow[],
        dead: { tagNumber: number }[],
    ): void => {
        const seen = new Set<string>();
        for (const row of source) {
            if (seen.has(row.message_id)) continue;
            seen.add(row.message_id);
            // Production registry keys are the suffixed content key `base:pK`;
            // the mirror carries the bare base. The view map joins the domains.
            const tags = (registry.tagNumbersByMessageBase.get(row.message_id) ?? []).map(
                (tagNumber) => ({
                    tag_number: tagNumber,
                    status: registry.statusByTag.get(tagNumber) ?? "",
                }),
            );
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
    };

    const live: LiveRow[] = [];
    const dead: { tagNumber: number }[] = [];
    joinRows(rows, live, dead);

    if (live.length === 1) {
        // Unique skeleton hit: stamp, byte-verify NEVER runs. The absorbed
        // semantics (case/whitespace/morphology) are the accepted contract;
        // verifying here would make the resolver stricter than the surface
        // the echo teaches (copy-drift would become a ghost not-found).
        return { outcome: classifyRegistryTag(deps, registry, live[0].tagNumber) };
    }
    if (live.length > 1) {
        // S-2: the skeleton can't discriminate — byte truth decides over the
        // MATCH shortlist only (the index hands the scope; no table scan on
        // any path). Substring predicate: head/tail trim passes free (models
        // deliberately trim), interior punctuation is faithful.
        const shortlist = statements.verify.all(
            sessionId,
            query,
            SAMPLE_MATCH_LIMIT,
        ) as unknown as { message_id: string; content: string }[];
        const survivorRows: SampleRow[] = shortlist
            .filter((row) => isByteSurvivor(row.content, text))
            .map((row) => ({
                message_id: row.message_id,
                excerpt: row.content.slice(0, SAMPLE_EXCERPT_CHARS),
            }));
        const survivors: LiveRow[] = [];
        const deadSurvivors: { tagNumber: number }[] = [];
        joinRows(survivorRows, survivors, deadSurvivors);
        if (survivors.length === 1) {
            return { outcome: classifyRegistryTag(deps, registry, survivors[0].tagNumber) };
        }
        if (survivors.length === 0) {
            // Ghosts (skeleton twins without the bytes) are not named.
            return { outcome: { kind: "error", reason: "not-found", input: text } };
        }
        return {
            outcome: {
                kind: "error",
                reason: "ambiguous",
                input: text,
                candidates: survivors
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

const RANGE_SEPARATOR = "..";

function splitRangeEntry(entry: string): { from: string; to: string } | undefined {
    const index = entry.indexOf(RANGE_SEPARATOR);
    if (index <= 0) return undefined;
    const from = entry.slice(0, index).trim();
    const to = entry.slice(index + RANGE_SEPARATOR.length).trim();
    if (from.length === 0 || to.length === 0) return undefined;
    return { from, to };
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
    // S-2 byte-verify lane: the same MATCH (indexed seek = scope) over FULL
    // content — the survivor test runs JS-side (the excerpt column would
    // truncate targets past 120 chars into manufactured ghosts).
    const verify = db.prepare(
        `SELECT message_id, content
           FROM message_history_fts
          WHERE session_id = ? AND message_history_fts MATCH ?
          ORDER BY bm25(message_history_fts), CAST(message_ordinal AS INTEGER) ASC
          LIMIT ?`,
    );
    const statements = { match, verify };
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
        ordinalForRegistryKey(deps.mint, messageId);

    /** Range endpoint: id hit, then phrase — the two pointing lanes,
     *  no classification (geometry, not a claim). */
    const resolveEndpoint = (
        registry: RegistryView,
        statements: ReduceStatements,
        text: string,
    ):
        | { tagNumber: number; messageId: string }
        | { error: Extract<ReduceInputOutcome, { kind: "error" }> } => {
        const direct = deps.callIdResolver.resolve([text]).get(text);
        if (direct) return { tagNumber: direct.tag_number, messageId: direct.message_id };
        const phrase = resolvePhrase(deps, registry, statements, text).outcome;
        if (phrase.kind === "error") return { error: phrase };
        if (phrase.kind === "range")
            return { error: { kind: "error", reason: "not-found", input: text } };
        return { tagNumber: phrase.tagNumber, messageId: phrase.messageId };
    };

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
            collect(
                phrase.zeroToken
                    ? { kind: "error", reason: "not-found", input: entry, zeroToken: true }
                    : { kind: "error", reason: "not-found", input: entry },
            );
            continue;
        }
        if (!deps.mint) {
            return {
                outcomes,
                queueTagNumbers: [...queue],
                internalError: "Error: message positions are unavailable for range entries.",
            };
        }
        const start = resolveEndpoint(registry, statements, range.from);
        if ("error" in start) {
            collect({ ...start.error, range: { entry, which: "start" } });
            continue;
        }
        const end = resolveEndpoint(registry, statements, range.to);
        if ("error" in end) {
            collect({ ...end.error, range: { entry, which: "end" } });
            continue;
        }
        // Registration span (D18, as ruled): the endpoints' tag numbers bind
        // the stretch, inclusive; direction is irrelevant (min..max). The
        // per-item classes apply inside (a range cannot smuggle a protected
        // item past the report discipline).
        const items: ReduceInputOutcome[] = [];
        const spanRows = db
            .prepare(
                `SELECT tag_number
                   FROM tags
                  WHERE session_id = ? AND tag_number BETWEEN ? AND ?
                  ORDER BY tag_number`,
            )
            .all(
                sessionId,
                Math.min(start.tagNumber, end.tagNumber),
                Math.max(start.tagNumber, end.tagNumber),
            ) as unknown as Array<{ tag_number: number }>;
        for (const row of spanRows) {
            const item = classifyRegistryTag(deps, registry, row.tag_number);
            items.push(item);
            if (item.kind === "released" || item.kind === "deferred") {
                queue.add(item.tagNumber);
            }
        }
        outcomes.push({
            kind: "range",
            fromOrdinal: ordinalOf(start.messageId),
            toOrdinal: ordinalOf(end.messageId),
            items,
        });
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
 * conversation's reference anchors, and their surgical release is what the
 * pointing grammar is for. Protected items are NOT queued here (nothing was
 * pointed at them; the model's explicit call is what defers them).
 */
/**
 * The no-arg bulk lane: every active tool-class item the model has already
 * responded past — position strictly below the newest user message — above
 * the token floor. Geometry runs on the registry view + mint (canonical,
 * live-store positions): the FTS mirror join is deliberately NOT used, its
 * stored ordinals are index-time values and its keys are the bare message
 * ids while tool rows key on wire call ids. Items whose position cannot be
 * established are never bulk-released (no positional claim is made about
 * them); without a newest user message nothing has been responded past.
 */
export function resolveBulkDefault(
    deps: ReduceResolverDeps & {
        sessionId: string;
        mint?: OrdinalMint;
    },
): {
    releasedItems: HandleItemRef[];
    inertItems: HandleItemRef[];
    protectedItems: HandleItemRef[];
} {
    const { db, sessionId } = deps;
    const registry = readRegistryView(db, sessionId);
    const releasedItems: HandleItemRef[] = [];
    const inertItems: HandleItemRef[] = [];
    const protectedItems: HandleItemRef[] = [];
    const boundary = deps.mint?.latestUserOrdinal;
    if (typeof boundary !== "number") return { releasedItems, inertItems, protectedItems };
    const tagNumbers = [...registry.statusByTag.keys()].sort((a, b) => a - b);
    for (const tagNumber of tagNumbers) {
        if (registry.typeByTag.get(tagNumber) !== "tool") continue;
        if (registry.statusByTag.get(tagNumber) !== "active") continue;
        if (registry.pendingTags.has(tagNumber)) continue;
        const tokens = registry.tokensByTag.get(tagNumber);
        if (typeof tokens === "number" && tokens < AGE_RECLAIM_MIN_TOKENS) continue;
        const ordinal = ordinalForRegistryKey(
            deps.mint,
            registry.messageIdByTag.get(tagNumber) ?? "",
        );
        if (typeof ordinal !== "number" || ordinal >= boundary) continue;
        const item = { tagNumber, messageId: registry.messageIdByTag.get(tagNumber) ?? "" };
        if (deps.inertTagNumbers?.has(tagNumber)) {
            inertItems.push(item);
            continue;
        }
        if (deps.protectedTagNumbers.has(tagNumber)) {
            protectedItems.push(item);
            continue;
        }
        releasedItems.push(item);
    }
    return { releasedItems, inertItems, protectedItems };
}
