import {
    isStrictGapHealingMessage,
    type RawMessage,
} from "../../hooks/magic-context/read-session-raw";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { clearIndexedMessagesInTransaction, ensureMessagesIndexed } from "./message-index";
import { clearCachedM0M1, ensureSessionMetaRow } from "./storage-meta-shared";
import { foldShrunkPartTags, type ShrunkPartMessage } from "./storage-tags";

/**
 * Which projection of the OpenCode store a session's saved coordinates were
 * derived against. `v1` is the `message`/`part` reader, `v2` is the
 * `session_message` reader.
 */
export type CoordinateGeneration = "v1" | "v2";

export interface StoreGenerationRebaseOutcome {
    /**
     * `unchanged` — the session's recorded projection already matches the running
     * host, so nothing was read or written.
     * `stamped` — the projection was recorded for the first time (or changed) but
     * no saved coordinate actually moved, so only the stamp was written.
     * `rebased` — coordinates moved and were re-derived.
     */
    status: "unchanged" | "stamped" | "rebased";
    generation: CoordinateGeneration;
    previousGeneration: CoordinateGeneration | null;
    compartmentsRebased: number;
    compartmentsUnresolved: number;
    compartmentsResolvedAgain: number;
    recompCompartmentsRebased: number;
    recompCompartmentsUnresolved: number;
    notesRebased: number;
    notesCleared: number;
    priorBoundaryRebased: boolean;
    recompPartialRangeRebased: boolean;
    compressionDepthRowsDropped: number;
    chunkEmbeddingsDeleted: number;
    indexRebuilt: boolean;
    /** Documents written back into the search index after the rebuild. */
    indexRowsRebuilt: number;
    partTagsFolded: number;
    partTagsRekeyed: number;
    queuedReductionsDiscarded: number;
    lkgSlotsDropped: number;
    frozenPartEntriesDropped: number;
    healedGaps: number;
    narrativeGaps: number;
}

/**
 * Durable summary of the last rebase, written so `/ctx-status` and the log can
 * tell the user what the projection change cost them. Only the facts a user can
 * act on are kept.
 */
export interface CoordinateRebaseNotice {
    generation: CoordinateGeneration;
    previousGeneration: CoordinateGeneration | null;
    at: number;
    unresolvedCompartments: number;
    discardedReductions: number;
    droppedDepthRows: number;
    healedGaps: number;
    narrativeGaps: number;
}

function emptyOutcome(
    status: StoreGenerationRebaseOutcome["status"],
    generation: CoordinateGeneration,
    previousGeneration: CoordinateGeneration | null,
): StoreGenerationRebaseOutcome {
    return {
        status,
        generation,
        previousGeneration,
        compartmentsRebased: 0,
        compartmentsUnresolved: 0,
        compartmentsResolvedAgain: 0,
        recompCompartmentsRebased: 0,
        recompCompartmentsUnresolved: 0,
        notesRebased: 0,
        notesCleared: 0,
        priorBoundaryRebased: false,
        recompPartialRangeRebased: false,
        compressionDepthRowsDropped: 0,
        chunkEmbeddingsDeleted: 0,
        indexRebuilt: false,
        indexRowsRebuilt: 0,
        partTagsFolded: 0,
        partTagsRekeyed: 0,
        queuedReductionsDiscarded: 0,
        lkgSlotsDropped: 0,
        frozenPartEntriesDropped: 0,
        healedGaps: 0,
        narrativeGaps: 0,
    };
}

/**
 * A refusal fence, not the rebase trigger.
 *
 * Only the OpenCode hosts have two store projections to move between. Pi reads
 * its own transcript files and supplies its own raw-message source, so its rows
 * can never be renumbered by an OpenCode store conversion and must never be
 * rewritten by this code even if a caller passes a generation. The decision to
 * REBASE is still taken from the recorded projection, never from this label.
 */
function sessionIsOpenCodeOwned(db: Database, sessionId: string): boolean {
    const row = db
        .prepare("SELECT harness FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { harness?: unknown } | null | undefined;
    const harness = row?.harness;
    // No row yet means a session Magic Context is meeting for the first time on
    // this host, which the caller's own generation describes.
    if (harness === undefined || harness === null) return true;
    return harness === "opencode" || harness === "opencode2";
}

/**
 * The projection an unstamped session's coordinates were written against,
 * inferred from the harness that wrote them. A session labelled `opencode`
 * was read through the 1.x tables; `opencode2` through the 2.x ones. Null when
 * the label carries no such evidence (no row, or a harness with one store
 * shape). A session that flipped BEFORE any generation-aware build saw it and
 * was then relabelled by its newer activity is beyond this: its label already
 * names the running projection, so it reads as never having moved.
 */
function generationImpliedByHarness(db: Database, sessionId: string): CoordinateGeneration | null {
    const row = db
        .prepare("SELECT harness FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { harness?: unknown } | null | undefined;
    if (row?.harness === "opencode") return "v1";
    if (row?.harness === "opencode2") return "v2";
    return null;
}

export function readCoordinateGeneration(
    db: Database,
    sessionId: string,
): CoordinateGeneration | null {
    const row = db
        .prepare("SELECT coordinate_generation FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { coordinate_generation?: unknown } | null | undefined;
    const value = row?.coordinate_generation;
    return value === "v1" || value === "v2" ? value : null;
}

export function readCoordinateRebaseNotice(
    db: Database,
    sessionId: string,
): CoordinateRebaseNotice | null {
    const row = db
        .prepare("SELECT coordinate_rebase_notice FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { coordinate_rebase_notice?: unknown } | null | undefined;
    const raw = row?.coordinate_rebase_notice;
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const record = parsed as Record<string, unknown>;
        if (record.generation !== "v1" && record.generation !== "v2") return null;
        const count = (value: unknown): number =>
            typeof value === "number" && Number.isFinite(value) ? value : 0;
        return {
            generation: record.generation,
            previousGeneration:
                record.previousGeneration === "v1" || record.previousGeneration === "v2"
                    ? record.previousGeneration
                    : null,
            at: count(record.at),
            unresolvedCompartments: count(record.unresolvedCompartments),
            discardedReductions: count(record.discardedReductions),
            droppedDepthRows: count(record.droppedDepthRows),
            healedGaps: count(record.healedGaps),
            narrativeGaps: count(record.narrativeGaps),
        };
    } catch {
        return null;
    }
}

/**
 * One user-visible line describing what the last projection change cost, or null
 * when the rebase took nothing away.
 */
export function formatCoordinateRebaseNotice(notice: CoordinateRebaseNotice): string | null {
    const parts: string[] = [];
    if (notice.discardedReductions > 0) {
        parts.push(
            `${notice.discardedReductions} queued reduction${notice.discardedReductions === 1 ? " was" : "s were"} discarded because their targets merged in the host's store conversion`,
        );
    }
    if (notice.unresolvedCompartments > 0) {
        parts.push(
            `${notice.unresolvedCompartments} compartment${notice.unresolvedCompartments === 1 ? "" : "s"} could not be re-anchored and are excluded from range recovery`,
        );
    }
    if (notice.droppedDepthRows > 0) {
        parts.push(`${notice.droppedDepthRows} compression-depth records were rebuilt from zero`);
    }
    if (notice.healedGaps > 0) {
        parts.push(
            `${notice.healedGaps} non-narrative compartment gap${notice.healedGaps === 1 ? " was" : "s were"} healed`,
        );
    }
    if (notice.narrativeGaps > 0) {
        parts.push(
            `${notice.narrativeGaps} narrative compartment gap${notice.narrativeGaps === 1 ? " remains" : "s remain"} for review`,
        );
    }
    return parts.length === 0 ? null : parts.join("; ");
}

interface CompartmentCoordinateRow {
    id: number;
    sequence: number;
    start_message: number;
    end_message: number;
    start_message_id: string | null;
    end_message_id: string | null;
    rebase_status: string | null;
}

function isCompartmentCoordinateRow(row: unknown): row is CompartmentCoordinateRow {
    if (row === null || typeof row !== "object") return false;
    const candidate = row as Record<string, unknown>;
    return (
        typeof candidate.id === "number" &&
        typeof candidate.sequence === "number" &&
        typeof candidate.start_message === "number" &&
        typeof candidate.end_message === "number"
    );
}

interface PlannedCompartment {
    table: "compartments" | "recomp_compartments";
    id: number;
    previousStart: number;
    previousEnd: number;
    start: number;
    end: number;
    status: "ok" | "unresolved";
    previousStatus: "ok" | "unresolved";
}

interface NoteCoordinateRow {
    id: number;
    anchor_ordinal: number | null;
    anchor_block_id: string | null;
}

interface PlannedNote {
    id: number;
    ordinal: number | null;
    previousOrdinal: number | null;
}

interface Projection {
    ordinalById: Map<string, number>;
    partCountById: Map<string, number>;
    nonNarrativeOrdinals: Set<number>;
    messageCount: number;
}

function buildProjection(messages: readonly RawMessage[]): Projection {
    const ordinalById = new Map<string, number>();
    const partCountById = new Map<string, number>();
    const nonNarrativeOrdinals = new Set<number>();
    for (const message of messages) {
        ordinalById.set(message.id, message.ordinal);
        partCountById.set(message.id, Array.isArray(message.parts) ? message.parts.length : 0);
        if (isStrictGapHealingMessage(message)) nonNarrativeOrdinals.add(message.ordinal);
    }
    return {
        ordinalById,
        partCountById,
        nonNarrativeOrdinals,
        messageCount: messages.length,
    };
}

/** The message id an anchor block id (`<messageId>#<block>`) names. */
function messageIdFromAnchorBlockId(anchorBlockId: string): string {
    const hash = anchorBlockId.lastIndexOf("#");
    return hash > 0 ? anchorBlockId.slice(0, hash) : anchorBlockId;
}

function readCompartmentRows(
    db: Database,
    table: "compartments" | "recomp_compartments",
    sessionId: string,
): CompartmentCoordinateRow[] {
    return db
        .prepare(
            `SELECT id, sequence, start_message, end_message, start_message_id, end_message_id, rebase_status
             FROM ${table} WHERE session_id = ? ORDER BY sequence ASC`,
        )
        .all(sessionId)
        .filter(isCompartmentCoordinateRow);
}

function planCompartments(
    rows: readonly CompartmentCoordinateRow[],
    table: "compartments" | "recomp_compartments",
    projection: Projection,
): PlannedCompartment[] {
    return rows.map((row) => {
        const previousStatus = row.rebase_status === "unresolved" ? "unresolved" : "ok";
        const startId = row.start_message_id ?? "";
        const endId = row.end_message_id ?? "";
        const start = startId.length > 0 ? projection.ordinalById.get(startId) : undefined;
        const end = endId.length > 0 ? projection.ordinalById.get(endId) : undefined;
        // Both endpoints must name a message this host actually serves. A legacy
        // row that never stored its endpoint ids has nothing to re-derive from,
        // which is the same situation as an endpoint the host dropped.
        if (start === undefined || end === undefined) {
            return {
                table,
                id: row.id,
                previousStart: row.start_message,
                previousEnd: row.end_message,
                start: row.start_message,
                end: row.end_message,
                status: "unresolved" as const,
                previousStatus,
            };
        }
        return {
            table,
            id: row.id,
            previousStart: row.start_message,
            previousEnd: row.end_message,
            start,
            end,
            status: "ok" as const,
            previousStatus,
        };
    });
}

function healNonNarrativeCompartmentGaps(
    plans: PlannedCompartment[],
    projection: Projection,
): { healed: number; narrative: number } {
    let healed = 0;
    let narrative = 0;
    for (let index = 1; index < plans.length; index += 1) {
        const previous = plans[index - 1];
        const current = plans[index];
        if (!previous || !current || previous.status !== "ok" || current.status !== "ok") continue;
        const gapStart = previous.end + 1;
        const gapEnd = current.start - 1;
        if (gapEnd < gapStart) continue;

        let safeToHeal = true;
        for (let ordinal = gapStart; ordinal <= gapEnd; ordinal += 1) {
            if (!projection.nonNarrativeOrdinals.has(ordinal)) {
                safeToHeal = false;
                break;
            }
        }
        if (safeToHeal) {
            previous.end = gapEnd;
            healed += 1;
        } else {
            narrative += 1;
        }
    }
    return { healed, narrative };
}

function compartmentPlanChanges(plan: PlannedCompartment): boolean {
    return (
        plan.status !== plan.previousStatus ||
        (plan.status === "ok" &&
            (plan.start !== plan.previousStart || plan.end !== plan.previousEnd))
    );
}

function planNotes(db: Database, sessionId: string, projection: Projection): PlannedNote[] {
    const rows = db
        .prepare(
            "SELECT id, anchor_ordinal, anchor_block_id FROM notes WHERE session_id = ? AND anchor_ordinal IS NOT NULL",
        )
        .all(sessionId) as NoteCoordinateRow[];
    return rows.flatMap((row) => {
        if (typeof row.id !== "number") return [];
        const previousOrdinal = typeof row.anchor_ordinal === "number" ? row.anchor_ordinal : null;
        const anchorBlockId = typeof row.anchor_block_id === "string" ? row.anchor_block_id : "";
        if (anchorBlockId.length === 0) {
            // No id anchor at all: the stored ordinal is a position in a list this
            // host no longer serves and cannot be re-derived, so it is cleared
            // rather than left pointing at whichever message now sits there.
            return [{ id: row.id, ordinal: null, previousOrdinal }];
        }
        const ordinal = projection.ordinalById.get(messageIdFromAnchorBlockId(anchorBlockId));
        return [{ id: row.id, ordinal: ordinal ?? null, previousOrdinal }];
    });
}

function countRows(db: Database, sql: string, ...params: unknown[]): number {
    const row = db.prepare(sql).get(...params) as { count?: unknown } | null | undefined;
    return typeof row?.count === "number" ? row.count : 0;
}

function stampGeneration(
    db: Database,
    sessionId: string,
    generation: CoordinateGeneration,
    notice: CoordinateRebaseNotice | null,
): void {
    ensureSessionMetaRow(db, sessionId);
    if (notice === null) {
        db.prepare("UPDATE session_meta SET coordinate_generation = ? WHERE session_id = ?").run(
            generation,
            sessionId,
        );
        return;
    }
    db.prepare(
        "UPDATE session_meta SET coordinate_generation = ?, coordinate_rebase_notice = ? WHERE session_id = ?",
    ).run(generation, JSON.stringify(notice), sessionId);
}

/** Drop `<messageId>:p<index>` entries whose part index the host no longer projects. */
function pruneShrunkPartEntries(
    db: Database,
    sessionId: string,
    column: string,
    shrunk: readonly ShrunkPartMessage[],
): number {
    if (shrunk.length === 0) return 0;
    const row = db
        .prepare(`SELECT ${column} AS value FROM session_meta WHERE session_id = ?`)
        .get(sessionId) as { value?: unknown } | null | undefined;
    const raw = row?.value;
    if (typeof raw !== "string" || raw.length === 0) return 0;
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return 0;
    }
    const isStale = (candidate: string): boolean =>
        shrunk.some(({ messageId, partCount }) => {
            const prefix = `${messageId}:p`;
            if (!candidate.startsWith(prefix)) return false;
            const suffix = candidate.slice(prefix.length);
            return /^\d+$/.test(suffix) && Number.parseInt(suffix, 10) >= partCount;
        });

    let dropped = 0;
    const pruneArray = (values: unknown[]): unknown[] =>
        values.filter((value) => {
            if (typeof value === "string" && isStale(value)) {
                dropped += 1;
                return false;
            }
            return true;
        });

    let next: unknown;
    if (Array.isArray(parsed)) {
        next = pruneArray(parsed);
    } else if (parsed && typeof parsed === "object") {
        const source = parsed as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(source)) {
            if (isStale(key)) {
                dropped += 1;
                continue;
            }
            result[key] = Array.isArray(value) ? pruneArray(value) : value;
        }
        next = result;
    } else {
        return 0;
    }
    if (dropped === 0) return 0;
    db.prepare(`UPDATE session_meta SET ${column} = ? WHERE session_id = ?`).run(
        JSON.stringify(next),
        sessionId,
    );
    return dropped;
}

export interface RebaseSessionCoordinatesArgs {
    db: Database;
    sessionId: string;
    /** Projection the running host serves for this session. */
    generation: CoordinateGeneration;
    /** Reads that projection. Called at most once, and only when a change is possible. */
    readMessages: (sessionId: string) => RawMessage[];
}

/**
 * Re-derive every position-keyed coordinate this session saved, from the message
 * ids that survived, against the projection the running host serves.
 *
 * Message ids are stable across the OpenCode 1.x/2.x store conversion but the
 * positions are not: converting a 1.x store splits some turns into two rows and
 * folds others into one, and the v1 tables are kept, so a user can be served
 * either projection on any given launch. Everything Magic Context saved as "the
 * Nth message" therefore has to be re-derived from the anchor ids whenever the
 * projection this session was last read under is not the one now in front of us.
 *
 * Nothing is guessed. An anchor the running projection does not contain marks
 * its row unresolved instead of being snapped to a neighbouring position, and
 * state with no id anchor at all (the search index, chunk windows, compression
 * depth) is rebuilt from the authoritative source rather than renumbered.
 *
 * The row rewrites, the index clear and the generation stamp commit together, so
 * a crash leaves the session either fully rebased or untouched; an untouched
 * session still has the old stamp, so the next pass runs this again.
 */
export function rebaseSessionCoordinates(
    args: RebaseSessionCoordinatesArgs,
): StoreGenerationRebaseOutcome {
    const { db, sessionId, generation } = args;
    const startedAt = performance.now();
    if (!sessionIsOpenCodeOwned(db, sessionId)) {
        return emptyOutcome("unchanged", generation, null);
    }
    const previousGeneration = readCoordinateGeneration(db, sessionId);
    if (previousGeneration === generation) {
        return emptyOutcome("unchanged", generation, previousGeneration);
    }

    // A session seen for the first time by a generation-aware build carries no
    // stamp, but it does carry evidence: the harness that wrote its coordinates.
    // When that names the projection this host serves, nothing can have moved
    // (compartments whose raw rows the host has since pruned included: their
    // anchors resolve nowhere, yet they are exactly as consistent as they were
    // yesterday, and re-deriving them would mark most of a long session's
    // history unresolved on an ordinary upgrade boot). When it names the other
    // projection, the store was converted before this build's first look — the
    // upgrade shape itself, a 1.x store meeting OpenCode 2 and this plugin in
    // one boot — and the rebase must run from that implied generation.
    const impliedGeneration =
        previousGeneration ?? generationImpliedByHarness(db, sessionId) ?? generation;
    if (impliedGeneration === generation) {
        stampGeneration(db, sessionId, generation, null);
        return emptyOutcome("stamped", generation, previousGeneration);
    }

    const projection = buildProjection(args.readMessages(sessionId));
    // The outcome and its log line name the projection the rebase actually ran
    // from, which for an unstamped session is the harness-implied one.
    const outcome = emptyOutcome("rebased", generation, impliedGeneration);

    const compartmentRows = readCompartmentRows(db, "compartments", sessionId);
    const recompRows = readCompartmentRows(db, "recomp_compartments", sessionId);
    const compartmentPlans = planCompartments(compartmentRows, "compartments", projection);
    const recompPlans = planCompartments(recompRows, "recomp_compartments", projection);
    const compartmentGapResult = healNonNarrativeCompartmentGaps(compartmentPlans, projection);
    const recompGapResult = healNonNarrativeCompartmentGaps(recompPlans, projection);
    const notePlans = planNotes(db, sessionId, projection);

    // Tags carry the message id plus the part index the text sat at. A host that
    // rewrites a multi-part message into one joined text part leaves every tag
    // above the surviving index without a target.
    const shrunkMessages: ShrunkPartMessage[] = [];
    const taggedMessageIds = (
        db
            .prepare(
                "SELECT DISTINCT message_id FROM tags WHERE session_id = ? AND type = 'message'",
            )
            .all(sessionId) as Array<{ message_id?: unknown }>
    ).flatMap((row) => (typeof row.message_id === "string" ? [row.message_id] : []));
    const highestTaggedPartIndex = new Map<string, number>();
    for (const contentId of taggedMessageIds) {
        const marker = contentId.lastIndexOf(":p");
        if (marker <= 0) continue;
        const suffix = contentId.slice(marker + 2);
        if (!/^\d+$/.test(suffix)) continue;
        const messageId = contentId.slice(0, marker);
        const partIndex = Number.parseInt(suffix, 10);
        highestTaggedPartIndex.set(
            messageId,
            Math.max(highestTaggedPartIndex.get(messageId) ?? 0, partIndex),
        );
    }
    for (const [messageId, highestIndex] of highestTaggedPartIndex) {
        const partCount = projection.partCountById.get(messageId);
        if (partCount === undefined || highestIndex < partCount) continue;
        shrunkMessages.push({ messageId, partCount });
    }

    const indexNeedsRebuild = indexDisagreesWithProjection(db, sessionId, projection);
    const chunkEmbeddingCount = countRows(
        db,
        "SELECT COUNT(*) AS count FROM compartment_chunk_embeddings WHERE session_id = ?",
        sessionId,
    );
    const depthRowCount = countRows(
        db,
        "SELECT COUNT(*) AS count FROM compression_depth WHERE session_id = ?",
        sessionId,
    );
    const lkgSlotCount = countRows(
        db,
        "SELECT COUNT(*) AS count FROM lkg_slots WHERE session_id = ?",
        sessionId,
    );

    const boundaryPlan = planPriorBoundary(db, sessionId, compartmentPlans);
    const partialRangePlan = planRecompPartialRange(db, sessionId, recompPlans);

    outcome.healedGaps = compartmentGapResult.healed + recompGapResult.healed;
    outcome.narrativeGaps = compartmentGapResult.narrative + recompGapResult.narrative;
    const movedCompartments = compartmentPlans.filter(compartmentPlanChanges);
    const movedRecomp = recompPlans.filter(compartmentPlanChanges);
    const movedNotes = notePlans.filter((plan) => plan.ordinal !== plan.previousOrdinal);
    const anythingMoved =
        movedCompartments.length > 0 ||
        movedRecomp.length > 0 ||
        movedNotes.length > 0 ||
        shrunkMessages.length > 0 ||
        indexNeedsRebuild ||
        boundaryPlan !== null ||
        partialRangePlan !== null ||
        outcome.healedGaps > 0 ||
        outcome.narrativeGaps > 0;

    if (!anythingMoved) {
        // The projection agrees with every saved coordinate. Recording it is the
        // whole change: a session that did not actually move must not pay a fold
        // or lose its index, because that would alter bytes the model already saw.
        stampGeneration(db, sessionId, generation, null);
        return emptyOutcome("stamped", generation, impliedGeneration);
    }

    db.exec("BEGIN IMMEDIATE");
    let committed = false;
    try {
        for (const plan of [...compartmentPlans, ...recompPlans]) {
            if (!compartmentPlanChanges(plan)) continue;
            db.prepare(
                `UPDATE ${plan.table} SET start_message = ?, end_message = ?, rebase_status = ? WHERE id = ?`,
            ).run(plan.start, plan.end, plan.status, plan.id);
            const rebased = plan.status === "ok" ? 1 : 0;
            const unresolved = plan.status === "unresolved" ? 1 : 0;
            if (plan.table === "compartments") {
                outcome.compartmentsRebased += rebased;
                outcome.compartmentsUnresolved += unresolved;
                if (rebased === 1 && plan.previousStatus === "unresolved")
                    outcome.compartmentsResolvedAgain += 1;
            } else {
                outcome.recompCompartmentsRebased += rebased;
                outcome.recompCompartmentsUnresolved += unresolved;
            }
        }
        for (const plan of movedNotes) {
            db.prepare("UPDATE notes SET anchor_ordinal = ? WHERE id = ? AND session_id = ?").run(
                plan.ordinal,
                plan.id,
                sessionId,
            );
            if (plan.ordinal === null) outcome.notesCleared += 1;
            else outcome.notesRebased += 1;
        }
        if (boundaryPlan !== null) {
            db.prepare(
                "UPDATE session_meta SET prior_boundary_ordinal = ? WHERE session_id = ?",
            ).run(boundaryPlan, sessionId);
            outcome.priorBoundaryRebased = true;
        }
        if (partialRangePlan !== null) {
            db.prepare(
                "UPDATE session_meta SET recomp_partial_range_start = ?, recomp_partial_range_end = ? WHERE session_id = ?",
            ).run(partialRangePlan.start, partialRangePlan.end, sessionId);
            outcome.recompPartialRangeRebased = true;
        }

        // No id anchor exists for these, so they are re-derived rather than moved.
        // clearIndexedMessagesInTransaction also resets the watermark and the
        // dirty floor, which is what makes the rebuild after the commit complete.
        if (indexNeedsRebuild) {
            clearIndexedMessagesInTransaction(db, sessionId);
            outcome.indexRebuilt = true;
            outcome.compressionDepthRowsDropped = depthRowCount;
        }
        if (chunkEmbeddingCount > 0) {
            db.prepare("DELETE FROM compartment_chunk_embeddings WHERE session_id = ?").run(
                sessionId,
            );
            outcome.chunkEmbeddingsDeleted = chunkEmbeddingCount;
        }
        if (lkgSlotCount > 0) {
            // The replay slot keys on content digests of the exact prefix it
            // captured. Text the host re-joined no longer hashes the same, so the
            // slot could only decline; deleting it says so instead of pretending.
            db.prepare("DELETE FROM lkg_slots WHERE session_id = ?").run(sessionId);
            outcome.lkgSlotsDropped = lkgSlotCount;
        }

        const fold = foldShrunkPartTags(db, sessionId, shrunkMessages);
        outcome.partTagsFolded = fold.foldedTagNumbers.length;
        outcome.partTagsRekeyed = fold.rekeyedTagNumbers.length;
        outcome.queuedReductionsDiscarded = fold.discardedDropTagNumbers.length;
        for (const column of [
            "stripped_placeholder_ids",
            "merged_reasoning_stripped_ids",
            "trailing_blank_decisions",
        ]) {
            outcome.frozenPartEntriesDropped += pruneShrunkPartEntries(
                db,
                sessionId,
                column,
                shrunkMessages,
            );
        }

        // The cached prefix bytes embed the ranges this pass just corrected, so
        // the next pass must rebuild them rather than replay the old render.
        clearCachedM0M1(db, sessionId);
        stampGeneration(db, sessionId, generation, {
            generation,
            previousGeneration: impliedGeneration,
            at: Date.now(),
            unresolvedCompartments:
                outcome.compartmentsUnresolved + outcome.recompCompartmentsUnresolved,
            discardedReductions: outcome.queuedReductionsDiscarded,
            droppedDepthRows: outcome.compressionDepthRowsDropped,
            healedGaps: outcome.healedGaps,
            narrativeGaps: outcome.narrativeGaps,
        });
        db.exec("COMMIT");
        committed = true;
    } finally {
        if (!committed) {
            try {
                db.exec("ROLLBACK");
            } catch {
                // Already rolled back by the failure that brought us here.
            }
        }
    }

    // Repopulating the search index is idempotent catch-up from the authoritative
    // source, not part of the atomic state change: the committed transaction left
    // an empty index with a zero watermark, which every later pass heals the same
    // way if this call does not get to run.
    if (outcome.indexRebuilt) {
        ensureMessagesIndexed(db, sessionId, args.readMessages);
        outcome.indexRowsRebuilt = countRows(
            db,
            "SELECT COUNT(*) AS count FROM message_history_source WHERE session_id = ?",
            sessionId,
        );
    }

    // One line per rebased session, written unconditionally to magic-context.log
    // so a migration drill can be read back from the log alone.
    sessionLog(sessionId, formatRebaseLogLine(outcome, performance.now() - startedAt));
    return outcome;
}

/** Single-line summary of one session's rebase, in the order an operator reads it. */
export function formatRebaseLogLine(
    outcome: StoreGenerationRebaseOutcome,
    elapsedMs: number,
): string {
    const rowsRewritten =
        outcome.compartmentsRebased +
        outcome.recompCompartmentsRebased +
        outcome.notesRebased +
        outcome.notesCleared +
        (outcome.priorBoundaryRebased ? 1 : 0) +
        (outcome.recompPartialRangeRebased ? 1 : 0);
    const unresolved = outcome.compartmentsUnresolved + outcome.recompCompartmentsUnresolved;
    return (
        `INFO store-generation-rebase ${outcome.previousGeneration ?? "unrecorded"}->${outcome.generation} ` +
        `rows_rewritten=${rowsRewritten} unresolved=${unresolved} ` +
        `index_rows_rebuilt=${outcome.indexRowsRebuilt} drops_discarded=${outcome.queuedReductionsDiscarded} ` +
        `healed_gaps=${outcome.healedGaps} narrative_gaps=${outcome.narrativeGaps} ` +
        `ms=${Math.round(elapsedMs)} ` +
        `(chunk_windows_deleted=${outcome.chunkEmbeddingsDeleted} depth_rows_dropped=${outcome.compressionDepthRowsDropped} ` +
        `part_tags_folded=${outcome.partTagsFolded} lkg_slots_dropped=${outcome.lkgSlotsDropped} ` +
        `frozen_part_entries_dropped=${outcome.frozenPartEntriesDropped})`
    );
}

/**
 * The protected-tail floor was taken from a compartment boundary, so it moves
 * with the compartment it came from. When no compartment ends where the floor
 * sits, the value has no anchor to follow and is left alone.
 */
function planPriorBoundary(
    db: Database,
    sessionId: string,
    plans: readonly PlannedCompartment[],
): number | null {
    const row = db
        .prepare("SELECT prior_boundary_ordinal FROM session_meta WHERE session_id = ?")
        .get(sessionId) as { prior_boundary_ordinal?: unknown } | null | undefined;
    const current =
        typeof row?.prior_boundary_ordinal === "number" ? row.prior_boundary_ordinal : 1;
    if (current <= 1) return null;
    const source = plans.find(
        (plan) => plan.status === "ok" && plan.previousEnd === current && plan.end !== current,
    );
    return source ? source.end : null;
}

function planRecompPartialRange(
    db: Database,
    sessionId: string,
    plans: readonly PlannedCompartment[],
): { start: number; end: number } | null {
    const row = db
        .prepare(
            "SELECT recomp_partial_range_start AS start, recomp_partial_range_end AS end FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { start?: unknown; end?: unknown } | null | undefined;
    const start = typeof row?.start === "number" ? row.start : 0;
    const end = typeof row?.end === "number" ? row.end : 0;
    if (start <= 0 && end <= 0) return null;
    const startSource = plans.find((plan) => plan.status === "ok" && plan.previousStart === start);
    const endSource = plans.find((plan) => plan.status === "ok" && plan.previousEnd === end);
    if (!startSource || !endSource) return null;
    if (startSource.start === start && endSource.end === end) return null;
    return { start: startSource.start, end: endSource.end };
}

/**
 * Whether the search index still describes the projection in front of us.
 *
 * Each indexed document records the message id it came from beside the ordinal
 * it was filed under, so this is an exact comparison rather than an estimate:
 * an id the projection numbers differently (or does not contain at all) means
 * those documents were filed against a different message list. The FTS rowid
 * map is checked too, because a document can be left behind at an ordinal the
 * source table has already moved away from — that stale pair is how the same
 * message ends up indexed twice.
 */
function indexDisagreesWithProjection(
    db: Database,
    sessionId: string,
    projection: Projection,
): boolean {
    const sourceRows = db
        .prepare(
            "SELECT message_id, message_ordinal FROM message_history_source WHERE session_id = ?",
        )
        .all(sessionId) as Array<{ message_id?: unknown; message_ordinal?: unknown }>;
    if (sourceRows.length === 0) {
        return (
            countRows(
                db,
                "SELECT COUNT(*) AS count FROM message_fts_rowid_map WHERE session_id = ?",
                sessionId,
            ) > 0
        );
    }
    for (const row of sourceRows) {
        if (typeof row.message_id !== "string" || typeof row.message_ordinal !== "number") {
            return true;
        }
        if (projection.ordinalById.get(row.message_id) !== row.message_ordinal) return true;
    }
    const orphanedMapRows = countRows(
        db,
        `SELECT COUNT(*) AS count FROM message_fts_rowid_map AS m
         WHERE m.session_id = ?
           AND NOT EXISTS (
               SELECT 1 FROM message_history_source AS s
               WHERE s.session_id = m.session_id AND s.message_ordinal = m.message_ordinal
           )`,
        sessionId,
    );
    return orphanedMapRows > 0;
}
