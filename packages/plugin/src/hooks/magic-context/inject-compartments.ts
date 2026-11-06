import { Buffer } from "node:buffer";
import {
    buildCompartmentBlock,
    type Compartment,
    type CompartmentDateRanges,
    escapeXmlContent,
    getCompartments,
    isPartialCompartmentEnd,
    type SessionFact,
} from "../../features/magic-context/compartment-storage";
import { CATEGORY_PRIORITY } from "../../features/magic-context/memory/constants";
import {
    getMaxMemoryIdForProjects,
    getMemoriesByProject,
    getMemoriesByProjects,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import {
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getMaxM0MutationId,
    getMaxMemoryMutationId,
    getMaxMemoryMutationIdForProjects,
    getProjectState,
    persistCachedM0,
    readProjectDocsCanonical,
} from "../../features/magic-context/storage";
import { writeRegionVolatile } from "../../features/magic-context/storage-meta-shared";
import {
    decodeSystemRegionRow,
    encodeSystemRegionRow,
    executeSystemRegionRotation,
    isSystemRegionBytes,
    type RegionMarkers,
    readSystemRegion,
    sanitizeReceiptOperand,
} from "../../features/magic-context/system-region";
import type { UserMemory } from "../../features/magic-context/user-memory/storage-user-memory";
import {
    computeWorkspaceEpochFingerprint,
    resolveWorkspaceIdentitySet,
    type WorkspaceIdentitySet,
} from "../../features/magic-context/workspaces";
import { BoundedSessionMap } from "../../shared/bounded-session-map";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import { sessionLog } from "../../shared/logger";
import type { Database, Statement as PreparedStatement } from "../../shared/sqlite";
import { logSlowWriteTransaction } from "../../shared/write-transaction-timing";
import {
    MARKER_SUMMARY_TEXT,
    reconcileForkOrphanedCompactionMarkers,
} from "./compaction-marker-manager";
import {
    COMPARTMENT_RENDER_EPOCH,
    decodeCachedM0UpgradeIdentity,
    encodeCachedM0UpgradeIdentity,
    MEMORY_RENDER_FORMAT_EPOCH,
    PROFILE_RENDER_EPOCH,
    renderBudgetIdentityChanged,
    renderedBudgetShrinkReason,
    renderedBudgetSnapshot,
} from "./compartment-render-epoch";
import { historianWrapperClose, historianWrapperOpen } from "./historian-wrapper-tags";
import { isHostRenderedSystemMessage } from "./host-served-rows";
import { compareRawSessionMessageOrder, resolveHostServedBoundaryId } from "./read-session-chunk";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import { renderRegionVolatile } from "./region-volatile";
import type { MessageLike } from "./tag-messages";
import { formatDate } from "./temporal-awareness";

type ProjectDocsRender = { renderedBlock: string; canonicalHash: string };
const EMPTY_PROJECT_DOCS: ProjectDocsRender = { renderedBlock: "", canonicalHash: "" };

export function readProjectDocsForM0(
    projectDirectory: string,
    injectDocs?: boolean,
): ProjectDocsRender {
    return projectDirectory && injectDocs !== false
        ? readProjectDocsCanonical(projectDirectory)
        : EMPTY_PROJECT_DOCS;
}

import type {
    HostCompactionWindow,
    InjectM0M1Result,
    M0Compartment,
    M0HardSignals,
    M0M1RenderOptions,
    M0M1State,
    M0SnapshotMarkers,
    MaterializeDecision,
    PrefixTrimSourceOrder,
    PrefixTrimStatus,
    WorkspaceRenderContext,
} from "./region-render";
// Moved to region-render.ts (Step 2 severance): re-imported by the remaining
// head-lane/apply code; re-exported so existing consumers keep their import paths.
import {
    cachedStatement,
    DEFAULT_HISTORY_BUDGET_TOKENS,
    DEFAULT_MEMORY_BUDGET_TOKENS,
    getGlobalUserProfileVersion,
    lastCompartmentBoundaryId,
    newestCompartmentEndId,
    RenderM1InvalidMarkersError,
    readM0Compartments,
    renderMemoryBlockV2,
    renderRegionM0,
    resolveWorkspaceRenderContext,
    safeGetActiveUserMemories,
} from "./region-render";

export type {
    HostCompactionWindow,
    InjectM0M1Result,
    M0Compartment,
    M0HardSignals,
    M0M1RenderOptions,
    M0M1State,
    M0SnapshotMarkers,
    MaterializeDecision,
    MemoryRenderOptions,
    PrefixTrimSourceOrder,
    PrefixTrimStatus,
    TrimMemoriesResultV2,
    WorkspaceRenderContext,
} from "./region-render";
export {
    buildRegionMuralMessage,
    DEFAULT_HISTORY_BUDGET_TOKENS,
    DEFAULT_MEMORY_BUDGET_TOKENS,
    DEFAULT_USER_PROFILE_BUDGET_TOKENS,
    renderM0,
    renderMemoryBlockV2,
    renderMemoryLineV2,
    stripMemoryMuralBlock,
    trimMemoriesToBudgetV2,
    trimUserMemoriesToBudget,
    trimWorkspaceMemoriesToBudgetV2,
} from "./region-render";

export interface PreparedCompartmentInjection {
    block: string;
    compartmentEndMessage: number;
    compartmentEndMessageId: string | null;
    compartmentCount: number;
    skippedVisibleMessages: number;
    factCount: number;
    memoryCount: number;
    rebuiltFromDb: boolean;
    /**
     * Set when the injection stayed degraded (boundary not in the visible
     * window) AND no durable compartment boundary is visible either, so no
     * safe re-anchor splice exists. The transform queues a fresh
     * materialization so the baseline is re-cut instead of silently looping
     * (#264 layer-B fallback).
     */
    needsFreshMaterialization?: boolean;
}

/**
 * In-memory cache of the last compartment injection result per session.
 * On non-flush passes, the cached result is replayed so that historian
 * publications between passes do not bust the Anthropic prompt-cache prefix.
 * The cache is invalidated explicitly via clearInjectionCache() after
 * historian/compressor/recomp write new compartments or facts.
 *
 * Bounded LRU: session.deleted clears entries explicitly, but sessions that
 * are never deleted (crashed OpenCode, force-quit, archived sessions) would
 * otherwise leak PreparedCompartmentInjection objects holding tens of KB of
 * XML each. 100 is generously above any realistic working set of active
 * sessions — evicted entries are simply recomputed on the next cache-busting
 * pass from the authoritative SQLite compartment state.
 */
const INJECTION_CACHE_MAX = 100;
type InjectionCacheEntry =
    | { db: Database; kind: "empty"; compartmentEndMessageId: string; renderedBytes: number }
    | { db: Database; kind: "populated"; injection: PreparedCompartmentInjection };

const injectionCache = new BoundedSessionMap<InjectionCacheEntry>(INJECTION_CACHE_MAX);

export function clearInjectionCache(sessionId: string): void {
    injectionCache.delete(sessionId);
    // A cache clear means compartment state changed (historian publish / recomp /
    // flush), so any in-flight degraded-mode bookkeeping for the OLD boundary is
    // stale. Reset it so the re-anchor countdown restarts against the new state.
    resetDegradedReanchorState(sessionId);
}

// ── Degraded-mode re-anchor (#263/#264) ─────────────────────────
//
// When the compartment boundary message is not in the visible window, the
// splice is a no-op and zero drops are queued. If a NEWER compaction marker
// (typically a fork-orphan, #263) cuts the window above our boundary, that
// state repeats on every pass with no recovery path (#264). Two layers fix
// it:
//   - Layer A (root cause): on the first degraded detection we run the
//     fork-orphan marker hygiene pass, which removes the foreign marker that
//     outranks ours so filterCompacted stops at our marker again.
//   - Layer B (resilience): if the boundary stays invisible for
//     REANCHOR_MIN_DEGRADED_PASSES consecutive rebuilds, we re-anchor the
//     splice to the newest durable compartment boundary that IS visible (or,
//     if none is visible, surface a fresh-materialization request) instead of
//     looping. The re-anchor changes bytes, so it only ever applies on a
//     cache-busting pass — never first-applied on a defer pass (invariant 2).

/**
 * Consecutive rebuilds during which the natural compartment boundary was not
 * present in the visible window. Reset to 0 the moment a rebuild finds the
 * boundary again. Defer-pass cache replays deliberately do NOT touch this —
 * they splice at the cached (possibly re-anchored) boundary and say nothing
 * about the natural boundary's visibility.
 */
const degradedRebuildCountBySession = new BoundedSessionMap<number>(INJECTION_CACHE_MAX);
/** Log-once latch so the re-anchor is announced loudly once, not per pass. */
const reAnchorLoggedBySession = new BoundedSessionMap<boolean>(INJECTION_CACHE_MAX);

/**
 * Number of consecutive degraded rebuilds before layer-B re-anchors. A small
 * threshold recovers fast; requiring more than one avoids reacting to a
 * single-pass transient (e.g. a marker-drain lag that heals next pass).
 */
const REANCHOR_MIN_DEGRADED_PASSES = 2;

export function resetDegradedReanchorState(sessionId: string): void {
    degradedRebuildCountBySession.delete(sessionId);
    reAnchorLoggedBySession.delete(sessionId);
}

function noteDegradedRebuild(sessionId: string): number {
    const next = (degradedRebuildCountBySession.get(sessionId) ?? 0) + 1;
    degradedRebuildCountBySession.set(sessionId, next);
    return next;
}

function clearDegradedRebuild(sessionId: string): void {
    degradedRebuildCountBySession.delete(sessionId);
    reAnchorLoggedBySession.delete(sessionId);
}

/** Announce a re-anchor loudly once per degraded episode, not per pass. */
function logReanchorOnce(sessionId: string, message: string): void {
    if (reAnchorLoggedBySession.get(sessionId)) return;
    reAnchorLoggedBySession.set(sessionId, true);
    sessionLog(sessionId, message);
}

/**
 * Find the newest durable compartment whose end message IS present in the
 * visible window, scanning newest→oldest. Returns its index into
 * `compartments` or -1. This is the layer-B re-anchor target: splicing there
 * removes only messages covered by compartments that are actually in view, so
 * no history is lost even though a newer marker cut the window above us.
 */
function findVisibleReanchorIndex(
    compartments: readonly Compartment[],
    visibleMessageIds: ReadonlySet<string>,
): number {
    for (let index = compartments.length - 1; index >= 0; index -= 1) {
        const endMessageId = compartments[index]?.endMessageId;
        if (
            typeof endMessageId === "string" &&
            endMessageId.length > 0 &&
            visibleMessageIds.has(endMessageId)
        ) {
            return index;
        }
    }
    return -1;
}

/**
 * Return the set of memory ids currently rendered in the cached
 * <session-history> block for this session, if any. Used by ctx_search
 * to hard-filter memories the agent already sees in context — retrieving
 * them from search wastes tokens and pushes high-signal raw-history hits
 * further down the ranking.
 *
 * Returns null when no cache exists or the JSON payload is malformed
 * (callers should treat null as "don't filter" — the worst case is a
 * redundant memory result, not a correctness issue).
 */
export function getVisibleMemoryIds(db: Database, sessionId: string): Set<number> | null {
    try {
        const row = db
            .prepare("SELECT memory_block_ids FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { memory_block_ids: string | null } | null;
        if (!row?.memory_block_ids) return null;
        const parsed = JSON.parse(row.memory_block_ids) as unknown;
        if (!Array.isArray(parsed)) return null;
        const ids = new Set<number>();
        for (const value of parsed) {
            if (typeof value === "number" && Number.isFinite(value)) {
                ids.add(value);
            }
        }
        return ids.size > 0 ? ids : null;
    } catch {
        return null;
    }
}

export interface CompartmentInjectionResult {
    injected: boolean;
    prependedMessageCount: number;
    compartmentEndMessage: number;
    compartmentCount: number;
    skippedVisibleMessages: number;
}

export function renderMemoryBlock(memories: Memory[]): string | null {
    return renderMemoryBlockV2(memories) || null;
}

/**
 * Return the memories `renderHistorianMemoryBlock` renders, in the order it
 * renders them (by category priority, then input order). Rendering any prefix
 * of this list reproduces the first lines of the full block, so a caller that
 * must shrink the block to fit a model window can drop the lowest-priority
 * lines by taking a shorter prefix.
 */
export function orderHistorianMemories(memories: Memory[]): Memory[] {
    const ordered: Memory[] = [];
    for (const category of CATEGORY_PRIORITY) {
        for (const memory of memories) {
            if (memory.category === category) ordered.push(memory);
        }
    }
    return ordered;
}

/**
 * The historian's `<project-memory>` block. Canonical form: category-grouped
 * `- <fact>` lines WITHOUT memory ids, ordered by CATEGORY_PRIORITY (v2
 * taxonomy first, then the legacy categories so pre-v2 rows remain visible);
 * categories outside the priority list are not rendered.
 *
 * Why this differs from the agent-facing wire (`renderMemoryBlockV2`, which
 * emits `#id: fact`): the historian system prompt uses this block only for
 * content-based fact dedup ("scan <project_memory> and silently skip any fact
 * that overlaps") and contradiction reporting — it never addresses a memory by
 * id. Ids exist on the m0/m1 wire so the `<memory-updates>` corrections block
 * can point at baseline lines (`<updated id="N">`, `<removed id="N">`); the
 * historian has no such corrections mechanism, so ids would be noise. Both
 * lanes must emit this exact form: the Rust port
 * (crates/mc-module/src/historian_prompt.rs `render_historian_memory_block`)
 * renders the same bytes, and the historian prompt golden
 * (crates/mc-module/testdata/historian-prompt-golden.json) pins byte parity.
 */
export function renderHistorianMemoryBlock(memories: Memory[]): string | null {
    const byCategory = new Map<string, Memory[]>();
    for (const m of memories) {
        const existing = byCategory.get(m.category);
        if (existing) {
            existing.push(m);
        } else {
            byCategory.set(m.category, [m]);
        }
    }

    const sections: string[] = [];
    for (const category of CATEGORY_PRIORITY) {
        const categoryMemories = byCategory.get(category);
        if (!categoryMemories || categoryMemories.length === 0) {
            continue;
        }
        sections.push(
            historianWrapperOpen(category),
            ...categoryMemories.map((m) => `- ${escapeXmlContent(m.content)}`),
            historianWrapperClose(category),
        );
    }

    if (sections.length === 0) {
        return null;
    }

    return `${historianWrapperOpen("project-memory")}\n${sections.join("\n")}\n${historianWrapperClose("project-memory")}`;
}

/** Constraint keywords that signal a memory encodes a rule rather than a description. */
const CONSTRAINT_KEYWORDS = /\b(must|never|always|cannot|should not|must not)\b/i;

/**
 * Assign a utility tier to a memory for injection priority.
 * Lower tier = higher priority (packed first).
 *
 * Tier 0: Agent actually searched for and found this memory.
 * Tier 1: Contains constraint/rule keywords — likely guards against a real bug.
 * Tier 2: Everything else.
 */
function utilityTier(m: Memory): number {
    if (m.retrievalCount > 0) return 0;
    if (CONSTRAINT_KEYWORDS.test(m.content)) return 1;
    return 2;
}

/**
 * Sort memories by priority and trim to budget.
 *
 * Priority order:
 *   1. permanent status first
 *   2. utility tier (retrieved > constraint > other)
 *   3. seen count descending
 *   4. shorter content first (fit more memories in budget)
 *   5. deterministic id tiebreaker for cache stability
 *
 * Uses the real Claude tokenizer (via estimateTokens) so the trim stays
 * consistent with the rest of the plugin's token math — mismatching units
 * (chars/4 here vs real tokens elsewhere) caused either under- or
 * over-injection of memories, depending on memory content shape.
 */
export function trimMemoriesToBudget(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
): Memory[] {
    const sorted = [...memories].sort((a, b) => {
        // Permanent memories first
        if (a.status === "permanent" && b.status !== "permanent") return -1;
        if (b.status === "permanent" && a.status !== "permanent") return 1;
        // Then by utility tier (lower = higher priority)
        const tierDiff = utilityTier(a) - utilityTier(b);
        if (tierDiff !== 0) return tierDiff;
        // Then by seen count descending (more frequently seen = higher priority)
        const seenDiff = b.seenCount - a.seenCount;
        if (seenDiff !== 0) return seenDiff;
        // Prefer shorter memories so more fit in budget
        const lenDiff = a.content.length - b.content.length;
        if (lenDiff !== 0) return lenDiff;
        // Deterministic tiebreaker by id to ensure stable ordering for cache safety
        return a.id - b.id;
    });

    const result: Memory[] = [];

    for (const memory of sorted) {
        // Render the candidate block so legacy callers measure the same grouped
        // bytes they inject, including a category's tags only when it survives.
        const candidate = [...result, memory];
        if (estimateTokens(renderMemoryBlockV2(candidate)) > budgetTokens) {
            break;
        }
        result.push(memory);
    }

    if (result.length < memories.length) {
        sessionLog(
            sessionId,
            `trimmed memories from ${memories.length} to ${result.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return result;
}

/**
 * Return only rows between OpenCode's marker boundary and the in-memory trim
 * boundary. filterCompacted requires a user marker row, so an assistant-ended
 * compartment can temporarily re-expose the assistant suffix after that user.
 */
export function selectHiddenMessagesAtCompactionSeam(
    messagesBeforeTrim: MessageLike[],
    skippedVisibleMessages: number,
): MessageLike[] {
    const trimmed = messagesBeforeTrim.slice(0, skippedVisibleMessages);
    let markerBoundaryIndex = -1;
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
        if (trimmed[index]?.info.role === "user") {
            markerBoundaryIndex = index;
            break;
        }
    }
    return markerBoundaryIndex < 0 ? [] : trimmed.slice(markerBoundaryIndex + 1);
}

export function prepareCompartmentInjection(
    db: Database,
    sessionId: string,
    messages: MessageLike[],
    isCacheBusting: boolean,
    projectPath?: string,
    injectionBudgetTokens?: number,
    temporalAwareness?: boolean,
): PreparedCompartmentInjection | null {
    // On defer (cache-safe) passes, replay the cached injection result so that
    // historian publications between passes do not bust the prompt-cache prefix.
    const cached = injectionCache.get(sessionId);
    if (cached && cached.db !== db) {
        // Session ids are unique in production, but tests and explicit database
        // paths can reuse one across independent stores. Never replay a block
        // rendered from a different database into the current session.
        //
        // clearInjectionCache (not a bare delete) so the degraded-mode re-anchor
        // bookkeeping is dropped with it: that count gates a byte-CHANGING
        // re-anchor, so inheriting another store's episode could re-anchor early
        // — the same cross-store leak, on the path where it costs more.
        clearInjectionCache(sessionId);
    }
    const usableCached = cached?.db === db ? cached : undefined;

    if (!isCacheBusting && usableCached) {
        if (usableCached.kind === "empty") {
            return null;
        }
        const prepared = usableCached.injection;
        if (prepared.compartmentEndMessageId === null) {
            sessionLog(
                sessionId,
                "compartment injection cache in degraded mode (null boundary), forcing rebuild",
            );
        } else {
            // Re-do the splice with the cached boundary (messages are rebuilt fresh each pass)
            if (prepared.compartmentEndMessageId.length > 0) {
                const cutoffIndex = findBoundaryIndex(
                    sessionId,
                    messages,
                    prepared.compartmentEndMessageId,
                );
                if (cutoffIndex >= 0) {
                    const remaining = messages.slice(
                        cutoffIndex +
                            (isPartialCompartmentEnd(
                                db,
                                sessionId,
                                prepared.compartmentEndMessageId,
                            )
                                ? 0
                                : 1),
                    );
                    messages.splice(0, messages.length, ...remaining);
                } else {
                    // Boundary message not in array — covered messages were already
                    // trimmed by OpenCode (compaction, old history not sent). The splice
                    // is effectively a no-op because there's nothing to splice out.
                    // Keep the cached injection so <session-history> stays stable on
                    // defer passes instead of alternating between injected/not-injected.
                    sessionLog(
                        sessionId,
                        `compartment injection: cached boundary ${prepared.compartmentEndMessageId} not in messages (already trimmed), reusing cache`,
                    );
                }
            }
            return { ...prepared, rebuiltFromDb: false };
        }
    }

    // A compartment whose endpoints could not be re-derived after the host
    // changed store projections still renders: its summary IS the history and
    // does not depend on the raw rows (most old compartments outlive their raw
    // rows anyway once the host prunes them). Only its start/end coordinates
    // are stale, and range recovery refuses those by rebase_status, so the
    // agent gets the compartment text and a clear refusal instead of a gap.
    const compartments = getCompartments(db, sessionId);
    // v2 faithful facts: session_facts is retired as a render source. Facts are
    // promoted to project memory and render via <project-memory>. We no longer
    // read or render session_facts here (matching the runner's removed write
    // side); legacy pre-v2 rows are left un-rendered.
    const facts: SessionFact[] = [];

    let memoryBlock: string | undefined;
    let memoryCount = 0;
    if (projectPath) {
        // Use cached memory block to avoid cache busting on background changes (ctx_memory write, promotion).
        // Cache is cleared by replaceSessionFacts/replaceAllCompartmentState after historian/compressor/recomp.
        // Audit note: `as` cast is safe here — session_meta schema is owned by this plugin and the two
        // columns are guaranteed present after initializeDatabase(). A type guard would add overhead on a
        // hot path (every transform) for a table we fully control.
        const cachedMemory = db
            .prepare(
                "SELECT memory_block_cache, memory_block_count FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { memory_block_cache: string; memory_block_count: number } | null;

        if (cachedMemory?.memory_block_cache) {
            memoryBlock = cachedMemory.memory_block_cache;
            memoryCount = cachedMemory.memory_block_count;
        } else {
            let memories = getMemoriesByProject(db, projectPath, ["active", "permanent"]);
            if (injectionBudgetTokens && memories.length > 0) {
                memories = trimMemoriesToBudget(sessionId, memories, injectionBudgetTokens);
            }
            memoryCount = memories.length;
            memoryBlock = renderMemoryBlock(memories) ?? undefined;
            // Capture ids of memories actually rendered in the block. Stored in
            // session_meta.memory_block_ids as JSON so ctx_search can hard-filter
            // them out of search results (the agent already sees them in <session-history>).
            const renderedIds = memories.map((m) => m.id);

            // Snapshot so subsequent turns reuse the same block without cache bust.
            // Swallow SQLITE_BUSY: the cache is a pure optimization (the block itself
            // is already computed and returned below). If another writer holds the DB
            // past busy_timeout=5s — typically a concurrent dreamer/historian child
            // session or a second OpenCode process — we'd rather let the transform
            // proceed with a one-turn cache miss than crash the user's prompt.
            // Issue: https://github.com/cortexkit/magic-context/issues/23
            try {
                db.prepare(
                    "UPDATE session_meta SET memory_block_cache = ?, memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
                ).run(memoryBlock ?? "", memoryCount, JSON.stringify(renderedIds), sessionId);
            } catch (error) {
                const code = (error as { code?: string } | null)?.code;
                if (code === "SQLITE_BUSY") {
                    sessionLog(
                        sessionId,
                        "memory_block_cache UPDATE hit SQLITE_BUSY, skipping snapshot for this turn",
                    );
                } else {
                    throw error;
                }
            }
        }
    }

    // Nothing to inject if we have no compartments, no facts, and no memories
    if (compartments.length === 0 && facts.length === 0 && !memoryBlock) {
        injectionCache.set(sessionId, {
            db,
            kind: "empty",
            compartmentEndMessageId: "",
            renderedBytes: 0,
        });
        return null;
    }

    let dateRanges: CompartmentDateRanges | undefined;
    if (temporalAwareness && compartments.length > 0) {
        // Resolve start/end message times from OpenCode's DB in a single batched query.
        const ids = new Set<string>();
        for (const c of compartments) {
            if (c.startMessageId) ids.add(c.startMessageId);
            if (c.endMessageId) ids.add(c.endMessageId);
        }
        const times = getMessageTimesFromOpenCodeDb(sessionId, Array.from(ids));
        const byId = new Map<number, { start: string; end: string }>();
        for (const c of compartments) {
            const startMs = times.get(c.startMessageId);
            const endMs = times.get(c.endMessageId);
            if (startMs !== undefined && endMs !== undefined) {
                byId.set(c.id, { start: formatDate(startMs), end: formatDate(endMs) });
            }
        }
        if (byId.size > 0) dateRanges = { byId };
    }

    const block = buildCompartmentBlock(compartments, facts, memoryBlock, dateRanges);

    // When there are no compartments yet (new session, or memories seeded before
    // historian first run), inject memories/facts without a boundary cutoff.
    // No messages are spliced because there's nothing to replace — the block is
    // prepended to message[0] the same way system-level context is.
    if (compartments.length === 0) {
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: 0,
            compartmentEndMessageId: "",
            compartmentCount: 0,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
            rebuiltFromDb: true,
        };
        injectionCache.set(sessionId, { db, kind: "populated", injection: result });
        return result;
    }

    const lastCompartment = compartments[compartments.length - 1];
    const lastEnd = lastCompartment.endMessage;
    // A newest compartment without an end id cannot be placed; trim at the
    // newest one that can (see lastCompartmentBoundaryId).
    const lastEndMessageId = newestCompartmentEndId(compartments) ?? "";

    // Modern m0/m1 preparation keeps the persisted baseline boundary. Only final
    // delivery may advance it after prefix preflight, so contention cannot remove
    // raw history that the replayed summary does not cover. Legacy sessions with
    // no m0 baseline retain their existing latest-compartment trim behavior.
    let trimEndMessageId = lastEndMessageId;
    const baseline = readCachedBaselineState(db, sessionId);
    if (!isCacheBusting || baseline.hasCachedM0) {
        // A modern prefix is only a candidate for refresh here. Keep its raw
        // boundary frozen until the off-wire renderer has actually chosen bytes.
        if (baseline.hasCachedM0) {
            // v2 cold defer rebuild (in-memory cache lost post-restart). Trim ONLY
            // to what the replayed cached m[1] actually covers.
            if (baseline.boundary) {
                trimEndMessageId = baseline.boundary;
            } else {
                // hasCachedM0 but null boundary: m[0]/m[1] was materialized BEFORE
                // any compartment boundary existed (the common new-session case — a
                // fresh session materializes m[0] with 0 compartments, then the
                // first historian publish lands, then a restart before the next
                // exec pass). The cached m[1] summarizes NONE of the current
                // compartments, so trimming to the latest boundary would drop a
                // compartment's raw messages that live in neither m[0] nor m[1] →
                // silent history loss. Suppress the trim entirely: keep all raw
                // messages in the tail; the next exec pass folds them into m[1].
                trimEndMessageId = "";
            }
        }
        // else: legacy / never-materialized v1 session (no cached m[0]) → keep the
        // latest-compartment boundary (the original v1 trim behavior).
    }

    if (trimEndMessageId.length === 0) {
        sessionLog(
            sessionId,
            "injecting legacy compartments without visible-prefix trimming because latest stored compartment has no end_message_id",
            {
                compartmentCount: compartments.length,
                compartmentEndMessage: lastEnd,
            },
        );
        const result: PreparedCompartmentInjection = {
            block,
            compartmentEndMessage: lastEnd,
            compartmentEndMessageId: "",
            compartmentCount: compartments.length,
            skippedVisibleMessages: 0,
            factCount: facts.length,
            memoryCount,
            rebuiltFromDb: true,
        };
        injectionCache.set(sessionId, { db, kind: "populated", injection: result });
        return result;
    }

    let skippedVisibleMessages = 0;
    let needsFreshMaterialization = false;
    let resultEndMessage: number = lastEnd;
    let resultEndMessageId: string | null = null;
    const cutoffIndex = findBoundaryIndex(sessionId, messages, trimEndMessageId);
    if (cutoffIndex >= 0) {
        // Natural boundary is visible — normal splice, and any degraded-mode
        // bookkeeping from earlier passes is cleared.
        clearDegradedRebuild(sessionId);
        skippedVisibleMessages =
            cutoffIndex + (isPartialCompartmentEnd(db, sessionId, trimEndMessageId) ? 0 : 1);
        const remaining = messages.slice(skippedVisibleMessages);
        messages.splice(0, messages.length, ...remaining);
        resultEndMessageId = trimEndMessageId;
    } else {
        // Degraded: the natural boundary message is not in the visible window.
        const degradedCount = noteDegradedRebuild(sessionId);
        // Layer A (#263): on the FIRST degraded detection of an episode, run the
        // fork-orphan marker hygiene pass. If a foreign marker outranks ours this
        // removes it, so the next pass's window stops at our marker and we
        // recover. Gated to the degraded trigger so steady state pays nothing.
        if (degradedCount === 1) {
            reconcileForkOrphanedCompactionMarkers(db, sessionId);
        }

        let reAnchored = false;
        if (degradedCount >= REANCHOR_MIN_DEGRADED_PASSES && isCacheBusting) {
            // Layer B (#264): the boundary has stayed invisible for long enough;
            // stop looping and re-anchor. This changes bytes, so it only runs on a
            // cache-busting pass (never first-applied on a defer pass).
            const visibleMessageIds = new Set<string>();
            for (const message of messages) {
                if (typeof message.info.id === "string") visibleMessageIds.add(message.info.id);
            }
            const reAnchorIndex = findVisibleReanchorIndex(compartments, visibleMessageIds);
            if (reAnchorIndex >= 0) {
                const reAnchorCompartment = compartments[reAnchorIndex];
                const reAnchorCutoff = findBoundaryIndex(
                    sessionId,
                    messages,
                    reAnchorCompartment.endMessageId,
                );
                if (reAnchorCutoff >= 0) {
                    skippedVisibleMessages =
                        reAnchorCutoff +
                        (isPartialCompartmentEnd(db, sessionId, reAnchorCompartment.endMessageId)
                            ? 0
                            : 1);
                    const remaining = messages.slice(skippedVisibleMessages);
                    messages.splice(0, messages.length, ...remaining);
                    resultEndMessage = reAnchorCompartment.endMessage;
                    resultEndMessageId = reAnchorCompartment.endMessageId;
                    reAnchored = true;
                    logReanchorOnce(
                        sessionId,
                        `compartment injection re-anchored: natural boundary ${trimEndMessageId} not visible for ${degradedCount} passes; splicing at visible compartment boundary ${resultEndMessageId} (ordinal ${resultEndMessage})`,
                    );
                }
            }
            if (!reAnchored) {
                // No durable compartment boundary is visible either, so there is no
                // safe splice target. Surface the state and request a fresh
                // materialization to re-cut the baseline instead of silently looping.
                needsFreshMaterialization = true;
                logReanchorOnce(
                    sessionId,
                    `compartment injection degraded: boundary ${trimEndMessageId} not visible for ${degradedCount} passes and no compartment boundary is visible; requesting fresh materialization to re-cut the baseline`,
                );
            }
        } else {
            sessionLog(
                sessionId,
                `compartment injection entering degraded mode: boundary ${trimEndMessageId} not in visible messages (consecutive degraded passes: ${degradedCount})`,
            );
        }
    }

    const result: PreparedCompartmentInjection = {
        block,
        compartmentEndMessage: resultEndMessage,
        compartmentEndMessageId: resultEndMessageId,
        compartmentCount: compartments.length,
        skippedVisibleMessages,
        factCount: facts.length,
        memoryCount,
        rebuiltFromDb: true,
    };
    if (needsFreshMaterialization) {
        result.needsFreshMaterialization = true;
    }
    injectionCache.set(sessionId, { db, kind: "populated", injection: result });
    return result;
}

/**
 * Read the persisted m[0]/m[1] baseline state for the cold-rebuild trim decision:
 *   - `hasCachedM0`: a v2 cached m[0] snapshot exists. Distinguishes a
 *     materialized-but-boundaryless session (null boundary is meaningful → the
 *     summary covers NO compartment, so do not trim) from a legacy /
 *     never-materialized v1 session (no cache → fall back to latest boundary).
 *   - `boundary`: the latest compartment end message id the cached m[1] covers,
 *     or null when m[0] was materialized before any compartment boundary existed.
 *
 * `hasCachedM0` is the discriminator, NOT boundary-nullness: null boundary with a
 * present cache is a legitimate state (a fresh session materializes m[0] with 0
 * compartments), and treating it as "fall back to latest" reintroduced the very
 * history-loss the cold-rebuild trim exists to prevent.
 */
function readCachedBaselineState(
    db: Database,
    sessionId: string,
): { hasCachedM0: boolean; boundary: string | null } {
    const row = db
        .prepare(
            "SELECT cached_m0_bytes AS m0, cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
        )
        .get(sessionId) as { m0: unknown; boundary: string | null } | undefined;
    const boundary = row?.boundary;
    return {
        hasCachedM0: row?.m0 != null,
        boundary: boundary && boundary.length > 0 ? boundary : null,
    };
}

export function renderCompartmentInjection(
    sessionId: string,
    messages: MessageLike[],
    prepared: PreparedCompartmentInjection,
): CompartmentInjectionResult {
    const historyBlock = `<session-history>\n${prepared.block}\n</session-history>`;
    const firstMessage = messages[0];
    const textPart = firstMessage ? findFirstTextPart(firstMessage.parts) : null;
    let prependedMessageCount = 0;
    if (!firstMessage || !textPart || isDroppedPlaceholder(textPart.text)) {
        prependedMessageCount = 1;
        // synthetic: true — injected context, not a real user turn. Keeps it out
        // of OpenCode's auto-title gate (issue #129) while still reaching the
        // model (toModelMessagesEffect filters `ignored`, not `synthetic`).
        messages.unshift({
            info: { role: "user", sessionID: sessionId },
            parts: [{ type: "text", text: historyBlock, synthetic: true }],
        });
    } else {
        textPart.text = `${historyBlock}\n\n${textPart.text}`;
    }

    const memoryLabel = prepared.memoryCount > 0 ? ` + ${prepared.memoryCount} memories` : "";
    if (prepared.compartmentCount > 0) {
        sessionLog(
            sessionId,
            `injected ${prepared.compartmentCount} compartments + ${prepared.factCount} facts${memoryLabel} into message[0]`,
        );
    } else {
        sessionLog(
            sessionId,
            `injected ${prepared.factCount} facts${memoryLabel} into message[0] (no compartments yet)`,
        );
    }

    return {
        injected: true,
        prependedMessageCount,
        compartmentEndMessage: prepared.compartmentEndMessage,
        compartmentCount: prepared.compartmentCount,
        skippedVisibleMessages: prepared.skippedVisibleMessages,
    };
}

function findFirstTextPart(parts: unknown[]): { type: string; text: string } | null {
    for (const part of parts) {
        if (part === null || typeof part !== "object") continue;
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string" && !p.ignored) {
            return p as unknown as { type: string; text: string };
        }
    }
    return null;
}

function isDroppedPlaceholder(text: string): boolean {
    // Unit 4 (coordinator split item C): recognize every head shape v2's OWN
    // sentinel mints — the emptied form (sentinel.ts makeSentinel writes
    // text:"") and the whole-message filler (makeWholeMessageSentinel writes
    // "[dropped]" on routes without modelAcceptsEmptyContent), beside the
    // canonical tagged placeholder. The empty match must come first: without
    // it the join path would prepend the block plus "\n\n" onto an emptied
    // head. "[content omitted]" rejoined the gate with the drop-shape doctrine
    // restore (2026-11-06): buildReplacementContent mints it for message-part
    // drops again (base 9c1520810:inject-compartments.ts:860), so a dropped
    // assistant shell must prepend the history block, not join onto it. The
    // `\.\.\.` alternative is base-canonical (9c1520810:inject-compartments.ts:
    // :861) — an imitation defense, not a mintage dependency (DeepSeek merge
    // gate + coordinator ruling 2026-11-06; census dead-strip rows reversed).
    return /^(?:|\[content omitted\]|\.\.\.|\[dropped(?: §\d+§)?\])$/.test(text.trim());
}

const EMPTY_HARD_SIGNALS: M0HardSignals = {
    systemHash: "",
    toolSetHash: "",
    modelKey: "",
    cacheExpired: false,
    lastResponseTime: 0,
};

export interface MaterializeM0Result {
    m0Bytes: Buffer;
    m0Text: string;
    m1Bytes: Buffer;
    m1Text: string;
    snapshotMarkers: M0SnapshotMarkers;
    renderedMemoryIds: number[];
    /** The covered-prefix boundary this fold persisted in-transaction (the
     *  committed newest covered end). The fold busts regardless of whether the
     *  region bytes change, so the trim is allowed to follow this value on the
     *  fold pass; law B6 pins it to the same SQL as readCommittedBaselineEnd. */
    baselineEndMessageId: string | null;
}

export class MaterializeContentionError extends Error {
    readonly retries: number;
    readonly reason: string;

    constructor(args: { retries?: number; reason?: string } = {}) {
        super(args.reason ?? "m[0] materialization contention");
        this.name = "MaterializeContentionError";
        this.retries = args.retries ?? 0;
        this.reason = args.reason ?? "contention";
    }
}

function renderBudgetIdentity(
    memoryBudget?: number,
    historyBudget?: number,
    historyPolicy?: string,
): string {
    return `m${memoryBudget ?? DEFAULT_MEMORY_BUDGET_TOKENS}-h${historyPolicy ?? historyBudget ?? DEFAULT_HISTORY_BUDGET_TOKENS}`;
}

const maxCompartmentSeqStatements = new WeakMap<Database, PreparedStatement>();
const maxMemoryIdStatements = new WeakMap<Database, PreparedStatement>();
const legacyCompartmentCountStatements = new WeakMap<Database, PreparedStatement>();
const markerChangeProbeStatements = new WeakMap<Database, PreparedStatement>();
const markerReadCaches = new WeakMap<Database, BoundedSessionMap<MarkerReadCacheEntry>>();

function numberFromRow(row: unknown, key: string): number {
    if (!row || typeof row !== "object") return 0;
    const value = (row as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function getMaxCompartmentSeq(db: Database, sessionId: string): number {
    const row = cachedStatement(
        maxCompartmentSeqStatements,
        db,
        "SELECT COALESCE(MAX(sequence), -1) AS s FROM compartments WHERE session_id = ?",
    ).get(sessionId);
    // -1 for an empty session, the real max sequence (>= 0) otherwise. The -1
    // sentinel is < 0 so it is distinct from the first real compartment (seq 0):
    // the volatile segment's readNewCompartments filters `sequence > maxSeq`, so
    // an empty baseline (maxCompartmentSeq = -1) includes the first compartment
    // (seq 0) in the delta. New compartments are delta-class, never a
    // mustMaterialize trigger.
    return numberFromRow(row, "s");
}
function getMaxMemoryId(
    db: Database,
    projectPath: string | undefined,
    expiryCutoff: number = Date.now(),
): number {
    if (!projectPath) return 0;
    const row = cachedStatement(
        maxMemoryIdStatements,
        db,
        `SELECT COALESCE(MAX(id), 0) AS max_id
           FROM memories
          WHERE project_path = ?
            AND status IN ('active', 'permanent')
            AND (expires_at IS NULL OR expires_at > ?)`,
    ).get(projectPath, expiryCutoff);
    return numberFromRow(row, "max_id");
}

// v2: session_facts is retired as a render source (facts = promoted memories).
// The m[0] snapshot keeps a sessionFactsVersion field for shape stability, but
// it is pinned to 0 so fact changes never drive m[0] re-materialization —
// rendered bytes no longer depend on session_facts. (Avoids wasted rebuilds.)
// session_facts is a retired table (facts are promoted memories now); this
// branch is kept inert-safe but never fires. Do NOT rewire facts through here.
// See docs/AUDIT-KNOWN-ISSUES.md A14 (vestigial table, drop gated on min TUI).
function getSessionFactsVersion(_db: Database, _sessionId: string): number {
    return 0;
}

function getUpgradeState(db: Database, sessionId: string): string | null {
    const row = cachedStatement(
        legacyCompartmentCountStatements,
        db,
        "SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND legacy = 1",
    ).get(sessionId);
    return numberFromRow(row, "count") > 0 ? "legacy" : "ready";
}

function getProjectMemoryEpoch(db: Database, projectPath: string | undefined): number {
    if (!projectPath) return 0;
    return getProjectState(db, projectPath)?.projectMemoryEpoch ?? 0;
}

export interface M0SnapshotMarkerReadArgs {
    db: Database;
    sessionId: string;
    projectPath?: string;
    projectDirectory?: string;
    injectDocs?: boolean;
    /** False suppresses the profile and mural surfaces alongside project memory. */
    memoryEnabled?: boolean;
    muralEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    historyBudgetPolicyIdentity?: string;
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
}

interface MarkerChangeProbe {
    projectMemoryEpoch: number;
    projectUserProfileVersion: number;
    maxCompartmentSeq: number;
    legacyCompartmentCount: number;
    maxMemoryId: number;
    maxMutationId: number;
    maxMemoryMutationId: number;
    workspaceSignature: string;
    workspaceEpochSignature: string;
    aliasSignature: string;
}

interface MarkerReadCacheEntry {
    markers: M0SnapshotMarkers;
    probe: MarkerChangeProbe;
    workspace: WorkspaceRenderContext;
    workspaceIdentity: string;
}

interface MarkerChangeProbeRow {
    project_memory_epoch: number;
    project_user_profile_version: number;
    max_compartment_seq: number;
    legacy_compartment_count: number;
    max_memory_id: number;
    max_mutation_id: number;
    max_memory_mutation_id: number;
    workspace_signature: string;
    workspace_epoch_signature: string;
    alias_signature: string;
}

const MARKER_CHANGE_PROBE_SQL = `
    WITH
      expanded(project_path) AS (SELECT CAST(value AS TEXT) FROM json_each(?)),
      own(project_path) AS (SELECT CAST(value AS TEXT) FROM json_each(?)),
      shared(category) AS (SELECT CAST(value AS TEXT) FROM json_each(?)),
      canonical(project_path) AS (SELECT CAST(value AS TEXT) FROM json_each(?))
    SELECT
      COALESCE((
        SELECT project_memory_epoch FROM project_state WHERE project_path = ?
      ), 0) AS project_memory_epoch,
      COALESCE((
        SELECT project_user_profile_version FROM project_state WHERE project_path = ?
      ), 0) AS project_user_profile_version,
      COALESCE((
        SELECT MAX(sequence) FROM compartments WHERE session_id = ?
      ), -1) AS max_compartment_seq,
      (
        SELECT COUNT(*) FROM compartments WHERE session_id = ? AND legacy = 1
      ) AS legacy_compartment_count,
      COALESCE((
        SELECT MAX(memory.id)
          FROM memories AS memory
         WHERE memory.project_path IN (SELECT project_path FROM expanded)
           AND memory.status IN ('active', 'permanent')
           AND (memory.expires_at IS NULL OR memory.expires_at > ?)
           AND (
             memory.project_path IN (SELECT project_path FROM own)
             OR (
               memory.shareable = 1
               AND memory.scope IN ('project', 'ecosystem', 'universe')
               AND memory.category IN (SELECT category FROM shared)
             )
           )
      ), 0) AS max_memory_id,
      COALESCE((
        SELECT MAX(id) FROM m0_mutation_log WHERE session_id = ?
      ), 0) AS max_mutation_id,
      COALESCE((
        SELECT MAX(id)
          FROM memory_mutation_log
         WHERE project_path IN (SELECT project_path FROM expanded)
      ), 0) AS max_memory_mutation_id,
      COALESCE((
        SELECT GROUP_CONCAT(signature, char(30))
          FROM (
            SELECT member.workspace_id || char(31) || member.project_path || char(31) ||
                   member.display_name || char(31) || member.display_path || char(31) ||
                   workspace.share_categories AS signature
              FROM workspace_members AS anchor
              JOIN workspace_members AS member ON member.workspace_id = anchor.workspace_id
              JOIN workspaces AS workspace ON workspace.id = member.workspace_id
             WHERE anchor.project_path = ?
             ORDER BY member.workspace_id, member.project_path
          )
      ), '') AS workspace_signature,
      COALESCE((
        SELECT GROUP_CONCAT(signature, char(30))
          FROM (
            SELECT canonical.project_path || char(31) ||
                   COALESCE(state.project_memory_epoch, 0) AS signature
              FROM canonical
              LEFT JOIN project_state AS state ON state.project_path = canonical.project_path
             ORDER BY canonical.project_path
          )
      ), '') AS workspace_epoch_signature,
      COALESCE((
        SELECT GROUP_CONCAT(signature, char(30))
          FROM (
            SELECT alias.old_project_path || char(31) || alias.new_project_path AS signature
              FROM v22_identity_rekey_map AS alias
             WHERE alias.new_project_path IN (SELECT project_path FROM canonical)
             ORDER BY alias.old_project_path, alias.new_project_path
          )
      ), '') AS alias_signature`;

function workspaceIdentity(workspace: WorkspaceRenderContext): string {
    return JSON.stringify({
        identities: workspace.identities,
        expandedIdentities: workspace.expandedIdentities,
        ownIdentities: workspace.ownIdentities,
        shareCategories: workspace.shareCategories,
        names: [...workspace.namesByIdentity].sort(([left], [right]) => left.localeCompare(right)),
    });
}

function markerReadCacheKey(args: M0SnapshotMarkerReadArgs): string {
    const suppliedWorkspace = args.workspaceIdentitySet
        ? JSON.stringify({
              identities: args.workspaceIdentitySet.identities,
              names: [...args.workspaceIdentitySet.namesByIdentity].sort(([left], [right]) =>
                  left.localeCompare(right),
              ),
          })
        : "auto";
    return `${args.sessionId}\u0000${args.projectPath ?? ""}\u0000${suppliedWorkspace}`;
}

function getMarkerReadCache(db: Database): BoundedSessionMap<MarkerReadCacheEntry> {
    let cache = markerReadCaches.get(db);
    if (!cache) {
        cache = new BoundedSessionMap<MarkerReadCacheEntry>(100);
        markerReadCaches.set(db, cache);
    }
    return cache;
}

function readMarkerChangeProbe(
    args: M0SnapshotMarkerReadArgs,
    workspace: WorkspaceRenderContext,
): MarkerChangeProbe {
    const statement = cachedStatement(
        markerChangeProbeStatements,
        args.db,
        MARKER_CHANGE_PROBE_SQL,
    );
    const row = statement.get(
        JSON.stringify(workspace.expandedIdentities),
        JSON.stringify(workspace.ownIdentities),
        JSON.stringify(workspace.shareCategories ?? []),
        JSON.stringify(workspace.identities),
        args.projectPath ?? "",
        GLOBAL_USER_PROFILE_PROJECT_PATH,
        args.sessionId,
        args.sessionId,
        Date.now(),
        args.sessionId,
        args.projectPath ?? "",
    ) as MarkerChangeProbeRow;
    return {
        projectMemoryEpoch: row.project_memory_epoch,
        projectUserProfileVersion: row.project_user_profile_version,
        maxCompartmentSeq: row.max_compartment_seq,
        legacyCompartmentCount: row.legacy_compartment_count,
        maxMemoryId: row.max_memory_id,
        maxMutationId: row.max_mutation_id,
        maxMemoryMutationId: row.max_memory_mutation_id,
        workspaceSignature: row.workspace_signature,
        workspaceEpochSignature: row.workspace_epoch_signature,
        aliasSignature: row.alias_signature,
    };
}

function markerChangeProbeEquals(left: MarkerChangeProbe, right: MarkerChangeProbe): boolean {
    return (
        left.projectMemoryEpoch === right.projectMemoryEpoch &&
        left.projectUserProfileVersion === right.projectUserProfileVersion &&
        left.maxCompartmentSeq === right.maxCompartmentSeq &&
        left.legacyCompartmentCount === right.legacyCompartmentCount &&
        left.maxMemoryId === right.maxMemoryId &&
        left.maxMutationId === right.maxMutationId &&
        left.maxMemoryMutationId === right.maxMemoryMutationId &&
        left.workspaceSignature === right.workspaceSignature &&
        left.workspaceEpochSignature === right.workspaceEpochSignature &&
        left.aliasSignature === right.aliasSignature
    );
}

function readCurrentM0SnapshotMarkersUncached(args: M0SnapshotMarkerReadArgs): {
    markers: M0SnapshotMarkers;
    workspace: WorkspaceRenderContext;
} {
    const hard = args.hardSignals ?? EMPTY_HARD_SIGNALS;
    const materializedAt = Date.now();
    const workspace = resolveWorkspaceRenderContext({
        db: args.db,
        projectPath: args.projectPath,
        workspaceIdentitySet: args.workspaceIdentitySet,
    });
    return {
        workspace,
        markers: {
            projectMemoryEpoch: getProjectMemoryEpoch(args.db, args.projectPath),
            workspaceFingerprint: workspace.isWorkspaced
                ? computeWorkspaceEpochFingerprint(args.db, workspace.identities)
                : null,
            projectUserProfileVersion: getGlobalUserProfileVersion(args.db),
            maxCompartmentSeq: getMaxCompartmentSeq(args.db, args.sessionId),
            maxMemoryId: workspace.isWorkspaced
                ? getMaxMemoryIdForProjects(
                      args.db,
                      workspace.expandedIdentities,
                      workspace.ownIdentities,
                      workspace.shareCategories,
                      materializedAt,
                  )
                : getMaxMemoryId(args.db, args.projectPath, materializedAt),
            maxMutationId: getMaxM0MutationId(args.db, args.sessionId) ?? 0,
            maxMemoryMutationId: workspace.isWorkspaced
                ? (getMaxMemoryMutationIdForProjects(args.db, workspace.expandedIdentities) ?? 0)
                : args.projectPath
                  ? (getMaxMemoryMutationId(args.db, args.projectPath) ?? 0)
                  : 0,
            // Project docs are not a materialization trigger. The HARD renderer
            // replaces this placeholder with the hash of the bytes it actually read.
            projectDocsHash: "",
            materializedAt,
            sessionFactsVersion: getSessionFactsVersion(args.db, args.sessionId),
            upgradeState: getUpgradeState(args.db, args.sessionId),
            compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
            memoryRenderEpoch: MEMORY_RENDER_FORMAT_EPOCH,
            profileRenderEpoch: PROFILE_RENDER_EPOCH,
            systemHash: hard.systemHash,
            toolSetHash: hard.toolSetHash ?? "",
            modelKey: piModelRefToCanonical(hard.modelKey),
            projectIdentity: args.projectPath ?? null,
            muralEnabled: args.memoryEnabled !== false && args.muralEnabled === true,
            renderBudgetIdentity: renderBudgetIdentity(
                args.memoryInjectionBudgetTokens,
                args.historyBudgetTokens,
                args.historyBudgetPolicyIdentity,
            ),
            renderedBudgets: renderedBudgetSnapshot(
                args.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
                args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
            ),
        },
    };
}

function refreshVolatileMarkerInputs(
    markers: M0SnapshotMarkers,
    args: M0SnapshotMarkerReadArgs,
): M0SnapshotMarkers {
    const hard = args.hardSignals ?? EMPTY_HARD_SIGNALS;
    return {
        ...markers,
        materializedAt: Date.now(),
        systemHash: hard.systemHash,
        toolSetHash: hard.toolSetHash ?? "",
        modelKey: hard.modelKey,
        projectIdentity: args.projectPath ?? null,
        muralEnabled: args.memoryEnabled !== false && args.muralEnabled === true,
        renderBudgetIdentity: renderBudgetIdentity(
            args.memoryInjectionBudgetTokens,
            args.historyBudgetTokens,
            args.historyBudgetPolicyIdentity,
        ),
        renderedBudgets: renderedBudgetSnapshot(
            args.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
            args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        ),
    };
}

/**
 * Read the current marker set while keeping the steady-state decision to one query.
 *
 * Completeness is based on the values the full read observes, not writer heuristics:
 * the probe reads project/global state, compartment sequence and legacy count,
 * filtered memory and memory-mutation maxima, and the session m0-mutation maximum.
 * Its workspace signatures include current membership, names, sharing policy,
 * aliases, and every member epoch. Therefore historian publishes, all memory
 * additions/mutations/classification changes, m0 mutations, epoch/profile bumps,
 * membership transitions, alias writes, and legacy upgrades change at least one
 * probe field. `sessionFactsVersion` is intentionally absent because its getter is
 * pinned to zero and no longer renders. Project docs are intentionally absent too:
 * edits join the next natural HARD fold rather than triggering one.
 * A changed field falls through to the authoritative multi-read implementation.
 */
export function readCurrentM0SnapshotMarkers(args: M0SnapshotMarkerReadArgs): M0SnapshotMarkers {
    const cache = getMarkerReadCache(args.db);
    const cacheKey = markerReadCacheKey(args);
    const cached = cache.get(cacheKey);
    if (cached) {
        const probe = readMarkerChangeProbe(args, cached.workspace);
        if (markerChangeProbeEquals(probe, cached.probe)) {
            return refreshVolatileMarkerInputs(cached.markers, args);
        }

        const fresh = readCurrentM0SnapshotMarkersUncached(args);
        const freshWorkspaceIdentity = workspaceIdentity(fresh.workspace);
        const freshProbe =
            freshWorkspaceIdentity === cached.workspaceIdentity
                ? probe
                : readMarkerChangeProbe(args, fresh.workspace);
        cache.set(cacheKey, {
            markers: fresh.markers,
            probe: freshProbe,
            workspace: fresh.workspace,
            workspaceIdentity: freshWorkspaceIdentity,
        });
        return fresh.markers;
    }

    const fresh = readCurrentM0SnapshotMarkersUncached(args);
    cache.set(cacheKey, {
        markers: fresh.markers,
        probe: readMarkerChangeProbe(args, fresh.workspace),
        workspace: fresh.workspace,
        workspaceIdentity: workspaceIdentity(fresh.workspace),
    });
    return fresh.markers;
}

export function snapshotMarkersFromCachedM0(state: M0M1State): M0SnapshotMarkers | null {
    if (!state.cachedM0Bytes) return null;
    const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(state.cachedM0UpgradeState);
    if (state.cachedM0ProjectMemoryEpoch === null) return null;
    if (state.cachedM0ProjectUserProfileVersion === null) return null;
    if (state.cachedM0MaxCompartmentSeq === null) return null;
    if (state.cachedM0MaxMemoryId === null) return null;
    if (state.cachedM0MaxMutationId === null) return null;
    if (state.cachedM0MaxMemoryMutationId === null) return null;
    if (state.cachedM0SessionFactsVersion === null) return null;
    return {
        projectMemoryEpoch: state.cachedM0ProjectMemoryEpoch,
        workspaceFingerprint: state.cachedM0WorkspaceFingerprint,
        projectUserProfileVersion: state.cachedM0ProjectUserProfileVersion,
        maxCompartmentSeq: state.cachedM0MaxCompartmentSeq,
        maxMemoryId: state.cachedM0MaxMemoryId,
        maxMutationId: state.cachedM0MaxMutationId,
        maxMemoryMutationId: state.cachedM0MaxMemoryMutationId,
        projectDocsHash: state.cachedM0ProjectDocsHash ?? "",
        materializedAt: state.cachedM0MaterializedAt ?? 0,
        sessionFactsVersion: state.cachedM0SessionFactsVersion,
        upgradeState: cachedUpgradeIdentity.upgradeState,
        compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
        memoryRenderEpoch: cachedUpgradeIdentity.memoryRenderEpoch,
        profileRenderEpoch: cachedUpgradeIdentity.profileRenderEpoch ?? "",
        systemHash: state.cachedM0SystemHash ?? "",
        toolSetHash: state.cachedM0ToolSetHash ?? "",
        modelKey: state.cachedM0ModelKey ?? "",
        projectIdentity: state.cachedM0ProjectIdentity ?? null,
        muralHash: state.cachedM0MuralHash ?? null,
        muralEnabled: cachedUpgradeIdentity.muralEnabled,
        renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity,
        renderedBudgets: cachedUpgradeIdentity.renderedBudgets,
    };
}

/**
 * The materialization decision, organized around the bust taxonomy:
 *
 *   SOFT+  — defer pass, nothing new: replay m[0] AND m[1] byte-identical.
 *   SOFT   — exec / deferred-consume pass: m[1] re-renders (new compartments,
 *            new memories, new user-profile ride the m[1] delta), m[0] stays.
 *   HARD   — the provider cache is already dead (idle>TTL, model/system/tools
 *            changed) OR a genuine m[0] *content* marker changed: fold m[1] into
 *            m[0], re-run decay, reset m[1].
 *
 * `mustMaterialize` returns true ONLY for HARD. New compartments and additive
 * user-profile/memory changes are deliberately NOT triggers — they are m[1]
 * deltas (see the volatile segment, region-volatile.ts) and must never mutate the m[0] baseline. That is the
 * whole point of the m[0]=frozen-prefix / m[1]=volatile-delta split: a routine
 * historian publish must keep the Anthropic prompt-cache prefix intact.
 */
const MEMORY_DERIVED_BLOCK_PATTERN =
    /<(?:project-memory|user-profile|new-user-profile|memory-updates|memory-mural)(?:>|\s)/;

function cachedMemoryDerivedSurfacePresent(state: M0M1State): boolean {
    return [state.cachedM0Bytes, state.cachedM1Bytes].some(
        (bytes) => bytes !== null && MEMORY_DERIVED_BLOCK_PATTERN.test(bytes.toString("utf8")),
    );
}

export function mustMaterialize(args: {
    db: Database;
    sessionId: string;
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    injectDocs?: boolean;
    /** False suppresses the profile and mural surfaces alongside project memory. */
    memoryEnabled?: boolean;
    muralEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    historyBudgetPolicyIdentity?: string;
    /** Frozen system-region residency: the head-lane m[1] arms do not apply —
     *  a region row legitimately carries no m[1], and a row that is not a
     *  valid sentinel region must fold once to install one. */
    systemRegionMode?: boolean;
}): MaterializeDecision {
    if (!args.state.cachedM0Bytes) return { value: true, reason: "first_render" };
    // Region era (assembly-v2 Unit 1 Step 3): the sentinel region row is the
    // only legitimate baseline state, on every reader. A row the region
    // reader cannot serve (legacy head bytes or a corrupt sentinel) folds
    // once to install a proper region; the reader contract (R11) guarantees
    // those bytes were never served as a region. The head-era cross-lane
    // first_render discrimination and the cached_m1_missing arm are retired
    // with the head carriage: a region row carries no m[1] by design.
    // The row in memory is the last served state; a poison applied after the
    // state read (a sibling forging head bytes) must fold too, or the bust
    // lane would reuse it on the wire.
    if (
        !args.state.cachedM0Bytes ||
        !isSentinelRegionRow(toBuffer(args.state.cachedM0Bytes)) ||
        readSystemRegion(args.db, args.sessionId) === null
    ) {
        return { value: true, reason: "region_first_install" };
    }
    const hard = args.hardSignals ?? EMPTY_HARD_SIGNALS;
    // `current.workspaceFingerprint` is resolved inside readCurrentM0SnapshotMarkers
    // (it resolves its own workspace context); the later workspace-identity HARD
    // gate compares it with the cached fingerprint, so no local context is needed.
    const current = readCurrentM0SnapshotMarkers(args);
    const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(args.state.cachedM0UpgradeState);

    // The system-prompt hook runs after the message transform, so its changed hash
    // reaches this decision one pass late. A memory-off process must not replay one
    // request of the old memory-bearing m[0]/m[1] while waiting for that signal.
    // The rendered bytes make this transition self-consuming without another
    // durable flag: once suppressed, the next pass finds no memory-derived block.
    if (args.memoryEnabled === false && cachedMemoryDerivedSurfacePresent(args.state)) {
        return { value: true, reason: "render_config:memory_disabled" };
    }

    // Renderer-format changes must fold cached m[0] once before sanitized bytes can
    // mix with a stale baseline. Persisting the new component consumes this trigger.
    if (cachedUpgradeIdentity.compartmentRenderEpoch !== current.compartmentRenderEpoch) {
        return { value: true, reason: "compartment_render_epoch" };
    }
    // The user-profile template (self-description, row shape) changes bytes on the
    // wire without touching any store row: like the compartment epoch it adopts
    // LOUD — legacy rows (component absent → null) fold once with the fleet, the
    // one-time bust pre-authorized as a content event.
    if (cachedUpgradeIdentity.profileRenderEpoch !== current.profileRenderEpoch) {
        return { value: true, reason: "profile_render_epoch" };
    }
    // The memory-render epoch is intentionally NOT compared here. Selection changes
    // affect m[0] bytes only when the next natural HARD rebuilds the frozen prefix.
    // Null components are legacy rows encoded before mural/budget joined the
    // identity: adopt silently (the values persist on the next natural HARD)
    // rather than folding the whole fleet once at upgrade. Only a real change
    // against a RECORDED component triggers. The same legacy adoption covers a
    // flag a caller never supplied: in region mode the fold's freeze persists
    // on the stored row, so an absent current flag means "not observed this
    // pass", not "switched off" — firing it would re-fold with the mural
    // stripped on every flag-less pass.
    if (
        cachedUpgradeIdentity.muralEnabled !== null &&
        cachedUpgradeIdentity.muralEnabled !== current.muralEnabled &&
        !(args.systemRegionMode === true && args.muralEnabled === undefined)
    ) {
        return {
            value: true,
            reason: `render_config:mural(${cachedUpgradeIdentity.muralEnabled}→${current.muralEnabled})`,
        };
    }
    if (
        cachedUpgradeIdentity.renderBudgetIdentity !== null &&
        current.renderBudgetIdentity != null &&
        renderBudgetIdentityChanged(
            cachedUpgradeIdentity.renderBudgetIdentity,
            current.renderBudgetIdentity,
        )
    ) {
        return {
            value: true,
            reason: `render_config:budget(${sanitizeReceiptOperand(cachedUpgradeIdentity.renderBudgetIdentity ?? "")}→${sanitizeReceiptOperand(current.renderBudgetIdentity ?? "")})`,
        };
    }

    const budgetShrinkReason = renderedBudgetShrinkReason(
        cachedUpgradeIdentity.renderedBudgets,
        current.renderedBudgets,
    );
    if (budgetShrinkReason) return { value: true, reason: budgetShrinkReason };

    // ── HARD: provider-side cache eviction (the cache was already dead) ──
    // Folding m[1] into m[0] here is "free" — the prefix is being re-cached
    // regardless. A non-empty current signal that differs from the captured
    // baseline marker means a real change; an empty current signal means
    // "unknown this pass" and is never treated as a change (avoids spurious
    // folds before the signal is known).
    const canonicalHardModelKey = piModelRefToCanonical(hard.modelKey);
    const canonicalCachedModelKey = piModelRefToCanonical(args.state.cachedM0ModelKey ?? "");
    if (canonicalHardModelKey !== "" && canonicalHardModelKey !== canonicalCachedModelKey) {
        return {
            value: true,
            reason: "model_change",
            m0ModelKeyPrev: canonicalCachedModelKey,
            m0ModelKeyNew: canonicalHardModelKey,
        };
    }
    const cachedSystemHash = args.state.cachedM0SystemHash ?? "";
    if (hard.systemHash !== "" && hard.systemHash !== cachedSystemHash) {
        return {
            value: true,
            reason: "system_hash",
            systemHashPrev: cachedSystemHash,
            systemHashNew: hard.systemHash,
        };
    }
    // Tool-set changes are deliberately not HARD-fold triggers: this signal is
    // process-global, so folding on it would manufacture unrelated session busts.
    // Preserve the actual operands from this decision site for a later query.
    const liveToolSetHash = hard.toolSetHash ?? "";
    const toolSetHashComparison =
        liveToolSetHash !== ""
            ? {
                  m0ToolSetHashPrev: args.state.cachedM0ToolSetHash,
                  m0ToolSetHashNew: liveToolSetHash,
              }
            : null;
    const withToolSetHashComparison = (decision: MaterializeDecision): MaterializeDecision =>
        toolSetHashComparison ? { ...decision, ...toolSetHashComparison } : decision;
    // Idle > TTL: the provider evicted the cache while the user was away. Guard
    // for idempotence across a multi-pass "came back" turn: cacheExpired stays
    // true on every pass until lastResponseTime updates at end-of-response, so
    // fold only when the last completed response is newer than our last
    // materialization. After the fold, materializedAt = Date.now() exceeds the
    // pre-expiry lastResponseTime, so subsequent passes this turn skip; the next
    // idle-after-response re-arms naturally. Self-consuming, no extra column.
    if (
        hard.cacheExpired &&
        hard.lastResponseTime > 0 &&
        hard.lastResponseTime > (args.state.cachedM0MaterializedAt ?? 0)
    ) {
        return withToolSetHashComparison({ value: true, reason: "ttl_idle" });
    }
    // A native host compaction replaced the window after the last fold. The host
    // summary now stands in for the history before its retained tail, and the
    // stored baseline boundary still points at a row the host no longer serves.
    // The compaction already changed everything after the cached prefix, so the
    // re-anchoring fold rides that change. Self-consuming like the idle expiry:
    // after the fold, materializedAt is newer than the summary.
    const hostCompaction = hard.hostCompaction;
    if (
        hostCompaction !== undefined &&
        hostCompaction.completedAt > (args.state.cachedM0MaterializedAt ?? 0)
    ) {
        return withToolSetHashComparison({ value: true, reason: "host_compaction" });
    }

    // ── HARD: genuine m[0] CONTENT change (the rendered baseline bytes differ) ──
    if (current.projectIdentity !== null) {
        const cachedProjectIdentity = args.state.cachedM0ProjectIdentity ?? null;
        if (cachedProjectIdentity === null) {
            args.state.cachedM0ProjectIdentity = current.projectIdentity;
            args.db
                .prepare(
                    "UPDATE session_meta SET cached_m0_project_identity = ? WHERE session_id = ?",
                )
                .run(current.projectIdentity, args.sessionId);
        } else if (cachedProjectIdentity !== current.projectIdentity) {
            return withToolSetHashComparison({ value: true, reason: "project_change" });
        }
    }

    // Compare the workspace fingerprint whenever EITHER the cached baseline or
    // the current pass is workspaced — keying only on current `isWorkspaced`
    // would miss the workspace→single transition: a cached union m[0] whose
    // session just left its workspace would fall through to the integer-epoch
    // compare and keep rendering the stale union if a membership bump were
    // missed. Mirrors the volatile segment's workspace gate and Pi's mustMaterializePi.
    if (
        current.workspaceFingerprint !== null ||
        (args.state.cachedM0WorkspaceFingerprint ?? null) !== null
    ) {
        if ((args.state.cachedM0WorkspaceFingerprint ?? null) !== current.workspaceFingerprint) {
            return withToolSetHashComparison({ value: true, reason: "project_memory_epoch" });
        }
    } else if (args.state.cachedM0ProjectMemoryEpoch !== current.projectMemoryEpoch) {
        return { value: true, reason: "project_memory_epoch" };
    }
    // NOTE: project_user_profile_version is deliberately NOT a trigger. Additive
    // user-profile promotions surface via the volatile segment's
    // <new-user-profile> delta (version-watermark), exactly like new
    // compartments and memories. A
    // version change must not fold m[0]; the delta reconciles into m[0] on the
    // next HARD fold. Destructive profile edits route through the same delta plus
    // the project_memory_epoch path for external (dashboard) mutations.
    //
    // NOTE: max_compartment_seq is deliberately NOT a trigger. New compartments
    // are the canonical delta class (volatile segment -> readNewCompartments WHERE
    // sequence > cachedM0Seq). Folding m[0] on every historian publish would bust
    // the prompt-cache prefix on a routine background publish — the exact bug the
    // m[0]/m[1] split exists to prevent. They fold into m[0] only on a HARD bust.
    //
    // NOTE: maxMemoryId is NOT a trigger. Additive memory writes surface in m[1]
    // via the maxMemoryId watermark; memory mutations use the m[1] reconcile
    // cursor. max_mutation_id (structural compartment delete/merge/recomp) IS a
    // trigger because it changes the rendered m[0] baseline content.
    //
    // NOTE: projectDocsHash is deliberately NOT a trigger HERE. Project docs
    // are part of m[0], but docs-only edits must not evict the cached
    // prefix; materializeM0 reads fresh docs whenever a natural HARD fold
    // happens and stores that hash with the bytes it actually rendered. On
    // the region lane the docs hash is not a trigger either (Unit 2 Task 3):
    // the docs delta rides the volatile segment and the panel converges at
    // the next legitimate fold (DELTA_TRIGGER_FIELDS is empty; the demotion
    // laws fence a re-add).
    if (args.state.cachedM0MaxMutationId !== current.maxMutationId) {
        return withToolSetHashComparison({ value: true, reason: "max_mutation_id" });
    }
    if (cachedUpgradeIdentity.upgradeState !== current.upgradeState) {
        return withToolSetHashComparison({ value: true, reason: "upgrade_state" });
    }
    return withToolSetHashComparison({ value: false, reason: null });
}

function applyMarkersToState(
    state: M0M1State,
    m0Bytes: Buffer,
    markers: M0SnapshotMarkers,
    m1Bytes?: Buffer,
): void {
    state.cachedM0Bytes = m0Bytes;
    if (m1Bytes) state.cachedM1Bytes = m1Bytes;
    state.cachedM0ProjectMemoryEpoch = markers.projectMemoryEpoch;
    state.cachedM0WorkspaceFingerprint = markers.workspaceFingerprint;
    state.cachedM0ProjectUserProfileVersion = markers.projectUserProfileVersion;
    state.cachedM0MaxCompartmentSeq = markers.maxCompartmentSeq;
    state.cachedM0MaxMemoryId = markers.maxMemoryId;
    state.cachedM0MaxMutationId = markers.maxMutationId;
    state.cachedM0MaxMemoryMutationId = markers.maxMemoryMutationId;
    state.cachedM0ProjectDocsHash = markers.projectDocsHash;
    state.cachedM0MaterializedAt = markers.materializedAt;
    state.cachedM0SessionFactsVersion = markers.sessionFactsVersion;
    state.cachedM0UpgradeState = encodeCachedM0UpgradeIdentity(
        markers.upgradeState,
        markers.compartmentRenderEpoch,
        markers.muralEnabled,
        markers.renderBudgetIdentity,
        markers.memoryRenderEpoch,
        markers.renderedBudgets ?? null,
        markers.profileRenderEpoch,
    );
    // Runtime markers must be mirrored into flat state because the next
    // mustMaterialize pass reads cachedM0SystemHash/ToolSetHash/ModelKey directly
    // rather than snapshotMarkers. Omitting them leaves a stale baseline until a
    // DB reload; for HARD triggers that would re-fire the same fold, while the
    // tool-set marker would lose its comparison baseline.
    state.cachedM0SystemHash = markers.systemHash;
    state.cachedM0ToolSetHash = markers.toolSetHash;
    state.cachedM0ModelKey = markers.modelKey;
    state.cachedM0ProjectIdentity = markers.projectIdentity;
    state.cachedM0MuralHash = markers.muralHash ?? null;
    state.snapshotMarkers = markers;
}

/** The rotation manifest captured at install: the fields the region's
 *  content triggers compare against, mapped from a snapshot read. */
export function regionMarkersFromSnapshot(markers: M0SnapshotMarkers): RegionMarkers {
    return {
        projectMemoryEpoch: markers.projectMemoryEpoch,
        maxCompartmentSeq: markers.maxCompartmentSeq,
        maxMemoryId: markers.maxMemoryId,
        maxMutationId: markers.maxMutationId,
        maxMemoryMutationId: markers.maxMemoryMutationId,
        projectDocsHash: markers.projectDocsHash,
        upgradeState: String(markers.upgradeState),
        compartmentRenderEpoch: markers.compartmentRenderEpoch,
        muralEnabled: markers.muralEnabled,
        renderBudgetIdentity: markers.renderBudgetIdentity,
        memoryRenderEpoch: markers.memoryRenderEpoch,
        renderedBudgets: markers.renderedBudgets ?? null,
        profileVersion: markers.projectUserProfileVersion,
        profileRenderEpoch: markers.profileRenderEpoch,
    };
}

/**
 * The promotion comparator's CURRENT side, production composition (storm
 * fix, §25). readCurrentM0SnapshotMarkers legitimately hardcodes
 * projectDocsHash: "" — a head-lane placeholder that materializeM0 replaces
 * with the real docs.canonicalHash before persist. The captured side of
 * the region manifest comparison is the PERSISTED (real) hash, so feeding
 * the placeholder through the DELTA_TRIGGER_FIELDS comparison made the pair
 * never-equal by construction: every boundary-permission pass rotated with
 * reason=project_docs_hash on identical bytes. Hydrate the same field here
 * through the SAME canonical helper the fold persist uses
 * (readProjectDocsForM0 — fingerprint-cached, so this is one cached read
 * per boundary pass), and never reimplement canonicalization. The
 * head-lane placeholder and mustMaterialize's deliberate non-trigger stay
 * exactly as they are.
 */
export function currentRegionMarkersForPromotion(args: M0SnapshotMarkerReadArgs): RegionMarkers {
    const markers = readCurrentM0SnapshotMarkers(args);
    return regionMarkersFromSnapshot({
        ...markers,
        projectDocsHash: readProjectDocsForM0(
            args.projectDirectory ?? args.projectPath ?? "",
            args.injectDocs,
        ).canonicalHash,
    });
}

export function materializeM0(options: M0M1RenderOptions): MaterializeM0Result {
    const projectPath = options.projectPath;
    const projectDirectory = options.projectDirectory ?? projectPath ?? "";
    let snapshotMarkers: M0SnapshotMarkers;
    let compartments: M0Compartment[] = [];
    let facts: SessionFact[] = [];
    let memories: Memory[] = [];
    let userMemories: UserMemory[] = [];
    let workspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });
    let docs: { renderedBlock: string; canonicalHash: string } = {
        renderedBlock: "",
        canonicalHash: "",
    };

    // One timestamp for the whole HARD fold: memory expiry cutoff at read time must
    // match persisted materializedAt (defer replays that value). Live Date.now() at
    // read vs a later Date.now() at persist created a determinism gap inside the fold.
    const foldMaterializedAt = Date.now();

    options.db.exec("BEGIN");
    try {
        workspace = resolveWorkspaceRenderContext({
            db: options.db,
            projectPath,
            workspaceIdentitySet: options.workspaceIdentitySet,
        });
        snapshotMarkers = readCurrentM0SnapshotMarkers({
            db: options.db,
            sessionId: options.sessionId,
            projectPath,
            projectDirectory,
            injectDocs: options.injectDocs,
            memoryEnabled: options.memoryEnabled,
            muralEnabled: options.muralEnabled,
            memoryInjectionBudgetTokens: options.memoryInjectionBudgetTokens,
            historyBudgetTokens: options.historyBudgetTokens,
            historyBudgetPolicyIdentity: options.historyBudgetPolicyIdentity,
            hardSignals: options.hardSignals,
            workspaceIdentitySet: {
                identities: workspace.identities,
                namesByIdentity: workspace.namesByIdentity,
            },
        });
        docs = readProjectDocsForM0(projectDirectory, options.injectDocs);
        snapshotMarkers.projectDocsHash = docs.canonicalHash;
        // Compaction-off: the zero-compartment path — historical compartment
        // rows exist but never render into <session-history>. The snapshot
        // markers still read the real maxCompartmentSeq so the staleness
        // check stays accurate; only the render input is emptied.
        compartments = options.compactionOff
            ? []
            : readM0Compartments(options.db, options.sessionId);
        // v2 faithful facts: session_facts is retired as a render source (facts
        // promote to project memory, rendered below via `memories`). Keep `facts`
        // empty so renderSessionHistoryWithDecay never emits a <session_facts>
        // block and no stale pre-v2 rows leak into m[0].
        facts = [];
        memories = projectPath
            ? workspace.isWorkspaced
                ? getMemoriesByProjects(
                      options.db,
                      workspace.expandedIdentities,
                      ["active", "permanent"],
                      foldMaterializedAt,
                      workspace.ownIdentities,
                      workspace.shareCategories,
                  )
                : getMemoriesByProject(
                      options.db,
                      projectPath,
                      ["active", "permanent"],
                      foldMaterializedAt,
                  )
            : [];
        userMemories = options.memoryEnabled === false ? [] : safeGetActiveUserMemories(options.db);
        options.db.exec("COMMIT");
    } catch (error) {
        try {
            options.db.exec("ROLLBACK");
        } catch {
            // ignore rollback failures from an already-closed transaction
        }
        throw error;
    }

    const region0 = renderRegionM0({
        db: options.db,
        sessionId: options.sessionId,
        projectPath,
        options,
        docs,
        snapshotMarkers,
        foldMaterializedAt,
        compartments,
        facts,
        memories,
        userMemories,
        workspace,
    });
    const m0Text = region0.m0Text;
    let m0Bytes = region0.m0Bytes;
    const frozenMuralDataUrl = region0.frozenMuralDataUrl;
    const frozenMuralHash = region0.frozenMuralHash;
    const renderedMemoryIds = region0.renderedMemoryIds;
    options.beforePhase3ForTest?.();

    // Region era: the fold owns no m[1] bytes. The volatile segment carries
    // the delta class beside the region (Unit 2 Step 2), so the result keeps
    // the field for shape stability and reports it empty.
    const m1Text = "";
    const m1Bytes = Buffer.alloc(0);
    let persistedBaselineEnd: string | null = null;
    try {
        options.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
        if ((error as { code?: string }).code === "SQLITE_BUSY") {
            throw new MaterializeContentionError({
                reason: "lock contention before Phase 3",
            });
        }
        throw error;
    }
    const transactionStartedAt = performance.now();
    try {
        const currentWorkspace = resolveWorkspaceRenderContext({
            db: options.db,
            projectPath,
            workspaceIdentitySet: options.workspaceIdentitySet,
        });
        const current: M0SnapshotMarkers = {
            projectMemoryEpoch: getProjectMemoryEpoch(options.db, projectPath),
            workspaceFingerprint: currentWorkspace.isWorkspaced
                ? computeWorkspaceEpochFingerprint(options.db, currentWorkspace.identities)
                : null,
            projectUserProfileVersion: getGlobalUserProfileVersion(options.db),
            maxCompartmentSeq: getMaxCompartmentSeq(options.db, options.sessionId),
            maxMemoryId: currentWorkspace.isWorkspaced
                ? getMaxMemoryIdForProjects(
                      options.db,
                      currentWorkspace.expandedIdentities,
                      currentWorkspace.ownIdentities,
                      currentWorkspace.shareCategories,
                      foldMaterializedAt,
                  )
                : getMaxMemoryId(options.db, projectPath, foldMaterializedAt),
            maxMutationId: getMaxM0MutationId(options.db, options.sessionId) ?? 0,
            maxMemoryMutationId: currentWorkspace.isWorkspaced
                ? (getMaxMemoryMutationIdForProjects(
                      options.db,
                      currentWorkspace.expandedIdentities,
                  ) ?? 0)
                : projectPath
                  ? (getMaxMemoryMutationId(options.db, projectPath) ?? 0)
                  : 0,
            projectDocsHash: snapshotMarkers.projectDocsHash,
            materializedAt: foldMaterializedAt,
            sessionFactsVersion: getSessionFactsVersion(options.db, options.sessionId),
            upgradeState: getUpgradeState(options.db, options.sessionId),
            compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
            memoryRenderEpoch: MEMORY_RENDER_FORMAT_EPOCH,
            profileRenderEpoch: PROFILE_RENDER_EPOCH,
            // HARD-bust markers are flight-constant (system/tool/model identity of
            // THIS request) — they cannot change mid-materialization-transaction,
            // so carry the captured values and exclude them from the stale check.
            systemHash: snapshotMarkers.systemHash,
            toolSetHash: snapshotMarkers.toolSetHash,
            modelKey: snapshotMarkers.modelKey,
            projectIdentity: projectPath ?? null,
            muralEnabled: snapshotMarkers.muralEnabled,
            renderBudgetIdentity: snapshotMarkers.renderBudgetIdentity,
            renderedBudgets: snapshotMarkers.renderedBudgets,
        };
        // NOTE: maxMemoryId is deliberately EXCLUDED from this stale-check.
        // Additive memory writes (write/promote) do not invalidate the rendered
        // m[0]; they surface in m[1] via the maxMemoryId watermark. The memory
        // mutation cursor IS included here because a materialization pass must
        // reconcile every non-additive memory change up to its persisted cursor.
        const memoryEpochStale =
            current.workspaceFingerprint !== null || snapshotMarkers.workspaceFingerprint !== null
                ? current.workspaceFingerprint !== snapshotMarkers.workspaceFingerprint
                : current.projectMemoryEpoch !== snapshotMarkers.projectMemoryEpoch;
        const stale =
            memoryEpochStale ||
            current.projectUserProfileVersion !== snapshotMarkers.projectUserProfileVersion ||
            current.maxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
            current.maxMutationId !== snapshotMarkers.maxMutationId ||
            current.maxMemoryMutationId !== snapshotMarkers.maxMemoryMutationId ||
            current.sessionFactsVersion !== snapshotMarkers.sessionFactsVersion ||
            current.upgradeState !== snapshotMarkers.upgradeState ||
            (current.projectIdentity ?? null) !== (snapshotMarkers.projectIdentity ?? null);
        if (stale) {
            options.db.exec("ROLLBACK");
            throw new MaterializeContentionError({ reason: "snapshot changed before Phase 3" });
        }

        // Unit 2 Step 2: the region is the four panels only. The delta half
        // that used to be concatenated here (renderRegionM1) is carried by the
        // volatile segment beside the region; the fold owns that segment too,
        // rendered against its own marker capture in the same transaction —
        // the region row, its markers, and the segment never diverge
        // (same-transaction coherence; persistFoldRow clears the stale row,
        // this fold re-renders the fresh one). The accounting is re-derived
        // from the two renders: panel ids ∪ volatile ids (ctx_search's
        // hide-already-visible filter reads session_meta.memory_block_ids).
        const volatileRender = renderRegionVolatile(
            options,
            {
                maxMemoryId: snapshotMarkers.maxMemoryId,
                maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
                maxMemoryMutationId: snapshotMarkers.maxMemoryMutationId,
                projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
                projectDocsHash: snapshotMarkers.projectDocsHash,
                materializedAt: snapshotMarkers.materializedAt,
                renderedMemoryIds,
            },
            docs,
        );
        const visibleMemoryIds = [...new Set([...renderedMemoryIds, ...volatileRender.memoryIds])];

        const foldMarkers = regionMarkersFromSnapshot(snapshotMarkers);
        const persistFoldRow = (m0Payload: Buffer, m1Payload: Buffer | null) => {
            persistCachedM0(options.db, options.sessionId, {
                m0Bytes: m0Payload,
                muralDataUrl: frozenMuralDataUrl,
                muralHash: frozenMuralHash,
                projectMemoryEpoch: snapshotMarkers.projectMemoryEpoch,
                workspaceFingerprint: snapshotMarkers.workspaceFingerprint,
                projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
                maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
                maxMemoryId: snapshotMarkers.maxMemoryId,
                maxMutationId: snapshotMarkers.maxMutationId,
                maxMemoryMutationId: snapshotMarkers.maxMemoryMutationId,
                m1Bytes: m1Payload,
                projectDocsHash: snapshotMarkers.projectDocsHash,
                materializedAt: snapshotMarkers.materializedAt,
                sessionFactsVersion: snapshotMarkers.sessionFactsVersion,
                upgradeState: encodeCachedM0UpgradeIdentity(
                    snapshotMarkers.upgradeState,
                    snapshotMarkers.compartmentRenderEpoch,
                    snapshotMarkers.muralEnabled,
                    snapshotMarkers.renderBudgetIdentity,
                    snapshotMarkers.memoryRenderEpoch,
                    snapshotMarkers.renderedBudgets ?? null,
                    snapshotMarkers.profileRenderEpoch,
                ),
                systemHash: snapshotMarkers.systemHash,
                toolSetHash: snapshotMarkers.toolSetHash,
                modelKey: snapshotMarkers.modelKey,
                projectIdentity: snapshotMarkers.projectIdentity,
            });
        };
        {
            // The boundary assembles the four panels once and installs the
            // sentinel region row atomically with the marker capture. The
            // never-empty floor is the panels' own (renderRegionM0), and the
            // delta side has no placeholder of its own since Unit 2 — the
            // volatile segment is simply empty (cleared with the fold row).
            const regionText = m0Text;
            let installedBlob: Buffer | null = null;
            const rotated = executeSystemRegionRotation(
                options.db,
                options.sessionId,
                options.systemRegion?.reason ?? "hard_fold",
                regionText,
                foldMarkers,
                (regionBlob) => {
                    installedBlob = regionBlob;
                    persistFoldRow(regionBlob, null);
                },
            );
            if (!rotated || !installedBlob) {
                throw new MaterializeContentionError({
                    reason: "system-region rotation refused (empty or forged payload)",
                });
            }
            // The served bytes ARE the region now: replay plumbing and the
            // fold-bust predicate must see what left this transaction, not the
            // head rendering it replaced.
            m0Bytes = installedBlob;
        }
        // The fold's fresh volatile row, after the fold-row clear ran inside
        // persistFoldRow: the segment names this region's materialized_at, so
        // the serve pairing (watermark == cached_m0_materialized_at) holds from
        // the commit onward. Empty text clears the row (the absorbed state).
        writeRegionVolatile(
            options.db,
            options.sessionId,
            volatileRender.text,
            snapshotMarkers.materializedAt,
        );

        // v2 path persists the rendered-memory identity itself. `memory_block_ids`
        // / `memory_block_count` are otherwise written ONLY by the dead legacy v1
        // render path, so without this they stay frozen at whatever the last legacy
        // render wrote — wrong sidebar "Injected" count AND a stale ctx_search
        // hide-already-visible filter after any memory change (e.g. the migration
        // delete+reinserts memories with NEW ids; the old ids linger here).
        // dogfood 2026-05-30: AFT showed "Injected 256" against 124 live memories,
        // all 256 ids deleted. Same transaction as the m[0] snapshot so the cached
        // bytes and their id manifest never diverge.
        options.db
            .prepare(
                "UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
            )
            .run(visibleMemoryIds.length, JSON.stringify(visibleMemoryIds), options.sessionId);

        // Persist the boundary the freshly-rendered m[0]+m[1] cover (the latest
        // compartment's end message id). A cold post-restart pass reads this to
        // trim the live tail to what the cached summary covers — never past it —
        // so a compartment published after this materialize keeps its raw
        // messages in the tail until an exec pass folds it into m[1]. Same
        // transaction as the m[0] snapshot so bytes and boundary never diverge.
        // Same-transaction coherence law: the persisted boundary must name the
        // newest coverage of the region being persisted. The committed read
        // (inside the fold transaction, so serialized against every publisher)
        // is the authority: when the panel render lagged a sibling publish
        // (the compartment read froze before the commit), the boundary carries
        // the newest row so bytes and boundary never diverge; an older value
        // would re-expose summarized rows on the next cold trim.
        // Same-transaction coherence law: the persisted boundary must name the
        // newest coverage in the store at commit time. The read happens inside
        // the fold transaction, so it serializes with every publisher; the
        // panel render above is the Phase-1 snapshot and may lag a sibling
        // publish. Bytes and boundary never diverge.
        const committedEnd = options.compactionOff
            ? null
            : ((
                  options.db
                      .prepare(
                          "SELECT end_message_id FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved' AND end_message_id IS NOT NULL AND end_message_id != '' ORDER BY sequence DESC LIMIT 1",
                      )
                      .get(options.sessionId) as { end_message_id: string | null } | undefined
              )?.end_message_id ?? null);
        let baselineEndMessageId = committedEnd ?? lastCompartmentBoundaryId(compartments);
        if (baselineEndMessageId === null) {
            const stored = options.db
                .prepare(
                    "SELECT cached_m0_last_baseline_end_message_id AS b FROM session_meta WHERE session_id = ?",
                )
                .get(options.sessionId) as { b: string | null } | undefined;
            baselineEndMessageId = stored?.b ?? null;
        }
        persistedBaselineEnd = baselineEndMessageId;
        options.db
            .prepare(
                "UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
            )
            .run(baselineEndMessageId, options.sessionId);

        options.onFoldCommit?.(options.db, {
            m0Bytes,
            // The region era serves no synthetic m[1]: the fold persisted the
            // region row with m1 null. The bust predicate must compare what
            // left this transaction on the wire, not the pre-region-render
            // placeholder it replaced.
            m1Bytes: null,
            muralDataUrl: frozenMuralDataUrl ?? null,
        });

        options.db.exec("COMMIT");
        logSlowWriteTransaction("opencode_materialize_cache", transactionStartedAt);
        options.state.cachedM0MuralDataUrl = frozenMuralDataUrl;
        options.state.cachedM0MuralHash = frozenMuralHash;
    } catch (error) {
        try {
            options.db.exec("ROLLBACK");
        } catch {
            // already rolled back
        }
        throw error;
    }

    return {
        m0Bytes,
        m0Text,
        m1Bytes,
        m1Text,
        snapshotMarkers,
        renderedMemoryIds,
        baselineEndMessageId: persistedBaselineEnd,
    };
}

export function materializeWithRetry(
    options: M0M1RenderOptions,
    maxRetries = 3,
): MaterializeM0Result {
    let lastError: MaterializeContentionError | null = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const r = materializeM0(options);
            return r;
        } catch (error) {
            if (!(error instanceof MaterializeContentionError)) throw error;
            lastError = error;
        }
    }
    throw new MaterializeContentionError({
        retries: maxRetries,
        reason: lastError?.reason ?? "m[0] materialization contention exhausted",
    });
}

interface CachedM0M1Row {
    cached_m0_bytes: Buffer | Uint8Array | null;
    cached_m0_mural_data_url: string | null;
    cached_m0_mural_hash: string | null;
    cached_m1_bytes: Buffer | Uint8Array | null;
    cached_m0_project_memory_epoch: number | null;
    cached_m0_workspace_fingerprint: string | null;
    cached_m0_project_user_profile_version: number | null;
    cached_m0_max_compartment_seq: number | null;
    cached_m0_max_memory_id: number | null;
    cached_m0_max_mutation_id: number | null;
    cached_m0_max_memory_mutation_id: number | null;
    cached_m0_project_docs_hash: string | null;
    cached_m0_materialized_at: number | null;
    cached_m0_session_facts_version: number | null;
    cached_m0_upgrade_state: string | null;
    cached_m0_system_hash: string | null;
    cached_m0_tool_set_hash: string | null;
    cached_m0_model_key: string | null;
    cached_m0_project_identity: string | null;
    cached_m0_last_baseline_end_message_id: string | null;
    memory_block_ids: string | null;
}

function toBuffer(value: Buffer | Uint8Array): Buffer {
    return Buffer.isBuffer(value)
        ? value
        : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function bufferEqualsNullable(
    left: Buffer | Uint8Array | null,
    right: Buffer | Uint8Array | null,
): boolean {
    if (left === null || right === null) return left === right;
    return toBuffer(left).equals(toBuffer(right));
}

/**
 * Callers normally pass getOrCreateSessionMeta(), which already carries the
 * persisted mural payload. A lean process-local state leaves it undefined; fill
 * it from the persisted row, but only when that row holds the exact m[0] bytes
 * the state holds, so a stale row can never pose as the served image.
 */
export function hydrateCachedM0Mural(db: Database, sessionId: string, state: M0M1State): void {
    if (!state.cachedM0Bytes || state.cachedM0MuralDataUrl !== undefined) return;
    const row = readCachedM0M1Row(db, sessionId);
    if (row && bufferEqualsNullable(row.cached_m0_bytes, state.cachedM0Bytes)) {
        state.cachedM0MuralDataUrl = row.cached_m0_mural_data_url ?? null;
        state.cachedM0MuralHash = row.cached_m0_mural_hash ?? null;
    }
}

function readCachedM0M1Row(db: Database, sessionId: string): CachedM0M1Row | null {
    return db
        .prepare(
            `SELECT cached_m0_bytes, cached_m0_mural_data_url,
                    cached_m0_mural_hash, cached_m1_bytes,
                    cached_m0_project_memory_epoch,
                    cached_m0_workspace_fingerprint,
                    cached_m0_project_user_profile_version,
                    cached_m0_max_compartment_seq,
                    cached_m0_max_memory_id,
                    cached_m0_max_mutation_id,
                    cached_m0_max_memory_mutation_id,
                    cached_m0_project_docs_hash,
                    cached_m0_materialized_at,
                    cached_m0_session_facts_version,
                     cached_m0_upgrade_state,
                     cached_m0_system_hash,
                     cached_m0_tool_set_hash,
                     cached_m0_model_key,
                     cached_m0_project_identity,
                     cached_m0_last_baseline_end_message_id,
                     memory_block_ids
               FROM session_meta
              WHERE session_id = ?`,
        )
        .get(sessionId) as CachedM0M1Row | null;
}

/**
 * Render a fresh region from current DB state WITHOUT persisting it or taking
 * the materialize lock. Last-resort fallback for the region replay when
 * materialization loses the lock (contention exhausted) AND there is no
 * cached region to reuse — e.g. the row was cleared this pass by a history
 * refresh and then a sibling process held the lock. Dropping the region would
 * serve zero session context; rendering fresh (un-persisted) keeps the frozen
 * panels present for this pass while the next pass re-materializes and
 * rotates. Uses a plain read (no BEGIN IMMEDIATE) since we are explicitly NOT
 * persisting; the bytes are the same producer as the fold (renderRegionM0 —
 * the four panels), sentinel-encoded so the serving reader accepts them.
 */
function renderFreshRegionNonPersisted(options: M0M1RenderOptions): {
    m0Bytes: Buffer;
    snapshotMarkers: M0SnapshotMarkers;
    renderedMemoryIds: number[];
} {
    const projectPath = options.projectPath;
    const projectDirectory = options.projectDirectory;
    const workspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });
    const snapshotMarkers = readCurrentM0SnapshotMarkers({
        db: options.db,
        sessionId: options.sessionId,
        projectPath,
        projectDirectory,
        injectDocs: options.injectDocs,
        memoryEnabled: options.memoryEnabled,
        muralEnabled: options.muralEnabled,
        memoryInjectionBudgetTokens: options.memoryInjectionBudgetTokens,
        historyBudgetTokens: options.historyBudgetTokens,
        historyBudgetPolicyIdentity: options.historyBudgetPolicyIdentity,
        hardSignals: options.hardSignals,
        workspaceIdentitySet: {
            identities: workspace.identities,
            namesByIdentity: workspace.namesByIdentity,
        },
    });
    const docs = readProjectDocsForM0(projectDirectory ?? "", options.injectDocs);
    snapshotMarkers.projectDocsHash = docs.canonicalHash;
    // CACHE STABILITY: materializedAt feeds the delta render's memory-expiry
    // cutoff. It MUST be stable across consecutive fallback passes, or two
    // defer passes that straddle a memory's expires_at would render different
    // bytes with zero DB mutation. Never use live Date.now() here. Reuse the
    // last persisted materialization timestamp; if none exists (cache fully
    // cleared this pass), use 0 (stable: renders all memories with no expiry
    // filtering, deterministic across passes).
    const materializedAt = options.state.cachedM0MaterializedAt ?? 0;
    snapshotMarkers.materializedAt = materializedAt;
    // Compaction-off renders through the zero-compartment path here too.
    const compartments = options.compactionOff
        ? []
        : readM0Compartments(options.db, options.sessionId);
    // Use the SAME frozen cutoff for the baseline memory read as the delta
    // does, so a memory crossing expires_at between two fallback passes
    // cannot shift the panel bytes either.
    const memories = projectPath
        ? workspace.isWorkspaced
            ? getMemoriesByProjects(
                  options.db,
                  workspace.expandedIdentities,
                  ["active", "permanent"],
                  materializedAt,
                  workspace.ownIdentities,
                  workspace.shareCategories,
              )
            : getMemoriesByProject(options.db, projectPath, ["active", "permanent"], materializedAt)
        : [];
    const userMemories =
        options.memoryEnabled === false ? [] : safeGetActiveUserMemories(options.db);
    const panel = renderRegionM0({
        db: options.db,
        sessionId: options.sessionId,
        projectPath,
        options,
        docs,
        snapshotMarkers,
        foldMaterializedAt: materializedAt,
        compartments,
        facts: [],
        memories,
        userMemories,
        workspace,
    });
    // Unit 2 Step 2: same producer as the fold — four panels only, no delta
    // half. The volatile segment is stored separately and never synthesized
    // here (its bytes are re-derived only on bust-lane recomputation).
    return {
        m0Bytes: encodeSystemRegionRow(panel.m0Text),
        snapshotMarkers,
        renderedMemoryIds: panel.renderedMemoryIds,
    };
}

/**
 * Locate a stored compartment boundary in the live messages. A boundary on a row
 * the host never serves by id (OpenCode 2 instruction updates) is found through
 * the served row it stands for; the direct lookup runs first so every host whose
 * rows are all served by id reads nothing extra.
 */
function findBoundaryIndex(
    sessionId: string,
    messages: readonly MessageLike[],
    boundaryId: string,
): number {
    const direct = messages.findIndex((message) => message.info.id === boundaryId);
    if (direct >= 0) return direct;
    const served = resolveHostServedBoundaryId(sessionId, boundaryId);
    if (served === boundaryId) return -1;
    return messages.findIndex((message) => message.info.id === served);
}

// ── Prefix trim when the boundary row is not in the live array ──────────
//
// The trim cuts through the boundary row by id. When that row is not in the
// live array, nothing is cut and the whole window is served, exactly as before;
// what changes is only how the state is named and logged:
//   - The first persisted live row sorts after the boundary: the host window
//     starts past it (for example a resumed session whose loaded history begins
//     after the boundary). The summary covers nothing that is live, so there is
//     nothing to cut. That is a successful trim, reported once per boundary.
//   - Otherwise (the boundary sorts inside the window but its row is missing,
//     or it cannot be placed at all): a degraded state, counted per episode.
//     It heals without a cut here: every cache-busting pass moves the baseline
//     boundary to the latest compartment end (soft refresh or materialization),
//     and once that boundary is in the window the id trim applies again.
// The served bytes never depend on this classification, so it needs no state
// that must survive a restart.

interface AbsentBoundaryEpisode {
    boundary: string;
    passes: number;
}

const absentBoundaryEpisodeBySession = new BoundedSessionMap<AbsentBoundaryEpisode>(
    INJECTION_CACHE_MAX,
);
/**
 * Last "does the boundary sort before the window" verdict per session, keyed by
 * the boundary and the first persisted live row it was compared with. Both only
 * change when the host window or the baseline changes, so steady passes skip
 * the store lookups.
 */
const precedesVerdictBySession = new BoundedSessionMap<{
    boundary: string;
    firstLiveId: string;
    precedes: boolean;
}>(INJECTION_CACHE_MAX);
/**
 * Boundary already logged as sitting before the live window, so the "nothing to
 * cut" outcome is logged once per boundary rather than on every pass.
 */
const precedesWindowLoggedBySession = new BoundedSessionMap<string>(INJECTION_CACHE_MAX);

export function resetPrefixTrimFallbackState(sessionId: string): void {
    absentBoundaryEpisodeBySession.delete(sessionId);
    precedesVerdictBySession.delete(sessionId);
    precedesWindowLoggedBySession.delete(sessionId);
}

/**
 * Rows a host compaction places at the head of its window although they are
 * newer than the retained rows after them (OpenCode's filterCompacted returns
 * [compaction request, summary, retained tail, rest]). They say nothing about
 * where the window starts in persisted order.
 */
function isHostCompactionHeadRow(message: MessageLike): boolean {
    if ((message.info as { summary?: unknown }).summary === true) return true;
    return message.parts.some((part) => (part as { type?: unknown }).type === "compaction");
}

function firstPersistedLiveId(messages: readonly MessageLike[]): string | null {
    for (const message of messages) {
        const id = message.info.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (isHostRenderedSystemMessage(message) || isHostCompactionHeadRow(message)) continue;
        return id;
    }
    return null;
}

function textOfParts(parts: readonly unknown[]): string {
    return parts
        .map((part) => {
            const text = (part as { text?: unknown }).text;
            return typeof text === "string" ? text : "";
        })
        .join("");
}

/**
 * Read a native host compaction off the head of the messages the host served,
 * before anything in this pass trims them. `readMagicContextSummaryMessageId`
 * returns the summary row of Magic Context's own marker, which has the same
 * shape and is excluded along with any row carrying its placeholder text. It is
 * only called when the head has that shape, so ordinary passes read nothing.
 */
export function findHostCompactionWindow(
    messages: readonly MessageLike[],
    readMagicContextSummaryMessageId: () => string | null,
): HostCompactionWindow | null {
    const persisted: MessageLike[] = [];
    for (const message of messages) {
        if (persisted.length === 2) break;
        const id = message.info.id;
        if (typeof id !== "string" || id.length === 0) continue;
        if (isHostRenderedSystemMessage(message)) continue;
        persisted.push(message);
    }
    const [request, summary] = persisted;
    if (!request || !summary) return null;
    if (
        request.info.role !== "user" ||
        !request.parts.some((part) => (part as { type?: unknown }).type === "compaction")
    ) {
        return null;
    }
    const summaryInfo = summary.info as MessageLike["info"] & {
        parentID?: unknown;
        time?: { created?: unknown; completed?: unknown };
    };
    if (
        summaryInfo.role !== "assistant" ||
        summaryInfo.summary !== true ||
        summaryInfo.parentID !== request.info.id ||
        !summaryInfo.finish ||
        summaryInfo.error
    ) {
        return null;
    }
    const summaryMessageId = summary.info.id as string;
    if (textOfParts(summary.parts).includes(MARKER_SUMMARY_TEXT)) return null;
    if (summaryMessageId === readMagicContextSummaryMessageId()) return null;
    const completedAt =
        typeof summaryInfo.time?.completed === "number"
            ? summaryInfo.time.completed
            : summaryInfo.time?.created;
    if (typeof completedAt !== "number" || !Number.isFinite(completedAt)) return null;
    return {
        compactionMessageId: request.info.id as string,
        summaryMessageId,
        completedAt,
    };
}

function boundaryPrecedesWindow(sessionId: string, boundary: string, firstLiveId: string): boolean {
    const cached = precedesVerdictBySession.get(sessionId);
    if (cached && cached.boundary === boundary && cached.firstLiveId === firstLiveId) {
        return cached.precedes;
    }
    let order: number | null = null;
    try {
        order = compareRawSessionMessageOrder(sessionId, boundary, firstLiveId);
        const served = resolveHostServedBoundaryId(sessionId, boundary);
        if (order === null && served !== boundary) {
            order = compareRawSessionMessageOrder(sessionId, served, firstLiveId);
        }
    } catch (error) {
        sessionLog(sessionId, `prefix trim: placing boundary ${boundary} failed:`, error);
        order = null;
    }
    const precedes = order !== null && order < 0;
    precedesVerdictBySession.set(sessionId, { boundary, firstLiveId, precedes });
    return precedes;
}

/** Classify and log a boundary missing from the live array. Never mutates messages. */
function classifyAbsentBoundary(
    options: M0M1RenderOptions,
    messages: readonly MessageLike[],
    boundary: string,
): PrefixTrimStatus {
    const { sessionId } = options;
    const pass = options.isCacheBustingPass ? "priced" : "defer";
    const firstLiveId = firstPersistedLiveId(messages);
    if (firstLiveId !== null && boundaryPrecedesWindow(sessionId, boundary, firstLiveId)) {
        absentBoundaryEpisodeBySession.delete(sessionId);
        if (precedesWindowLoggedBySession.get(sessionId) !== boundary) {
            precedesWindowLoggedBySession.set(sessionId, boundary);
            // Earlier in the same pass, compartment injection may already have cut
            // the window through the boundary, and reduction may have removed
            // messages after it (a message whose only tool calls were dropped
            // is left empty and removed). A boundary before the first remaining
            // message therefore does not by itself mean the host's window
            // started after it, and the line is worded not to suggest that.
            sessionLog(
                sessionId,
                `prefix trim: boundary ${boundary} precedes the first remaining message ${firstLiveId}; rows between were cut with the summarized history or removed by reduction this pass; pass=${pass}; nothing to cut`,
            );
        }
        return "boundary-precedes-window";
    }
    precedesWindowLoggedBySession.delete(sessionId);

    const current = absentBoundaryEpisodeBySession.get(sessionId);
    const episode = current && current.boundary === boundary ? current : { boundary, passes: 0 };
    episode.passes += 1;
    absentBoundaryEpisodeBySession.set(sessionId, episode);
    // Logged when the episode starts, and on every cache-busting pass: those are
    // the passes expected to heal it by moving the baseline boundary, so one
    // that stays degraded is worth seeing.
    if (episode.passes === 1 || options.isCacheBustingPass) {
        sessionLog(
            sessionId,
            `prefix trim: boundary ${boundary} absent from current messages; pass=${pass}; no in-pass trim applied (degraded pass ${episode.passes}; ${firstLiveId === null ? "no persisted live message to compare with" : `boundary does not sort before the first live message ${firstLiveId}`}; whole window served until a cache-busting pass moves the boundary into the window)`,
        );
    }
    return "refused";
}

/**
 * Freeze the host's source order before tag replay and tool pruning mutate the live array.
 * The IDs are evidence only: delivery trims surviving live objects and never restores old parts.
 */
export function capturePrefixTrimSourceOrder(
    messages: readonly MessageLike[],
): PrefixTrimSourceOrder {
    const messageIds: string[] = [];
    const seen = new Set<string>();
    let invalidReason: string | null = null;

    for (const [index, message] of messages.entries()) {
        const id = message.info.id;
        // OpenCode 2 renders instruction-update rows as id-less system messages
        // anywhere in history. They carry no row identity to order, and the trim
        // places them by their persisted neighbours.
        if (isHostRenderedSystemMessage(message)) continue;
        if (typeof id !== "string" || id.length === 0) {
            // Headless carriage: Magic Context splices no synthetic heads. An
            // id-less row here is a foreign/stray row, not our content — the
            // whole source order is refused and the window is served intact.
            invalidReason = `source message at index ${index} has no stable id`;
            break;
        }
        if (seen.has(id)) {
            invalidReason = `source message id ${id} appears more than once`;
            break;
        }
        seen.add(id);
        messageIds.push(id);
    }

    return Object.freeze({
        messageIds: Object.freeze(messageIds),
        invalidReason,
    });
}

function trimToPreparedPrefix(
    options: M0M1RenderOptions,
    prepared: Pick<
        InjectM0M1Result,
        | "preparedTrimBoundaryId"
        | "m0RematerializedThisPass"
        | "materializationContentionRetryExhausted"
    >,
): PrefixTrimStatus {
    if (options.compactionOff || !options.messages) return "not-attempted";
    const boundary = prepared.preparedTrimBoundaryId;
    let status: PrefixTrimStatus = "not-required";

    if (boundary) {
        const sourceOrder = options.prefixTrimSourceOrder;
        if (sourceOrder) {
            const refuse = (reason: string): PrefixTrimStatus => {
                sessionLog(
                    options.sessionId,
                    `prefix trim: boundary ${boundary}; pass=${options.isCacheBustingPass ? "priced" : "defer"}; no in-pass trim applied (${reason})`,
                );
                return "refused";
            };
            if (sourceOrder.invalidReason) {
                status = refuse(sourceOrder.invalidReason);
            } else {
                const sourcePosition = new Map<string, number>();
                sourceOrder.messageIds.forEach((id, index) => {
                    sourcePosition.set(id, index);
                });
                const boundaryPosition =
                    sourcePosition.get(boundary) ??
                    sourcePosition.get(resolveHostServedBoundaryId(options.sessionId, boundary));
                if (boundaryPosition === undefined) {
                    status = refuse("boundary absent from immutable source order");
                } else {
                    let lastSourcePosition = -1;
                    let liveOrderError: string | null = null;
                    const retained: MessageLike[] = [];
                    for (const [index, message] of options.messages.entries()) {
                        const id = message.info.id;
                        if (isHostRenderedSystemMessage(message)) {
                            // Belongs to the rows around its persisted neighbours:
                            // kept exactly when the row before it is kept or is the
                            // boundary, the same cut the id-lookup trim makes.
                            if (lastSourcePosition >= boundaryPosition) retained.push(message);
                            continue;
                        }
                        if (typeof id !== "string" || id.length === 0) {
                            liveOrderError = `live message at index ${index} has no stable id`;
                            break;
                        }
                        const position = sourcePosition.get(id);
                        if (position === undefined) {
                            liveOrderError = `live message ${id} is absent from immutable source order`;
                            break;
                        }
                        if (position <= lastSourcePosition) {
                            liveOrderError = `live message ${id} violates immutable source order`;
                            break;
                        }
                        lastSourcePosition = position;
                        if (
                            position > boundaryPosition ||
                            (position === boundaryPosition &&
                                isPartialCompartmentEnd(options.db, options.sessionId, boundary))
                        )
                            retained.push(message);
                    }
                    if (liveOrderError) status = refuse(liveOrderError);
                    else {
                        options.messages.splice(0, options.messages.length, ...retained);
                        status = "applied";
                    }
                }
            }
        } else {
            const index = findBoundaryIndex(options.sessionId, options.messages, boundary);
            if (index >= 0) {
                options.messages.splice(
                    0,
                    index +
                        (isPartialCompartmentEnd(options.db, options.sessionId, boundary) ? 0 : 1),
                );
                resetPrefixTrimFallbackState(options.sessionId);
                status = "applied";
            } else {
                status = classifyAbsentBoundary(options, options.messages, boundary);
            }
        }
    }
    if (
        prepared.m0RematerializedThisPass ||
        (options.isCacheBustingPass && !prepared.materializationContentionRetryExhausted)
    )
        clearInjectionCache(options.sessionId);
    return status;
}

/** The newest covered end in the store — the boundary a rotation advances the
 *  baseline to. The same expression the fold persists in-transaction; law B6
 *  pins the two textually. `undefined` (vs null) distinguishes "no rows". */
export function readCommittedBaselineEnd(
    db: Database,
    sessionId: string,
): string | null | undefined {
    const row = db
        .prepare(
            "SELECT end_message_id FROM compartments WHERE session_id = ? AND rebase_status != 'unresolved' AND end_message_id IS NOT NULL AND end_message_id != '' ORDER BY sequence DESC LIMIT 1",
        )
        .get(sessionId) as { end_message_id: string | null } | undefined;
    return row ? (row.end_message_id ?? null) : undefined;
}

/**
 * Capture the persisted region row and its covered-prefix boundary before a
 * fallible preflight. This is the region-era replay entry (it replaces the
 * head-era pair replay): a sentinel-valid region row answers as a cache-hit
 * with zero heads on the wire — the panels serve inside system[0]
 * (system-prompt-hash.ts), the array carries no synthetic messages. An
 * unservable row (legacy head bytes, corrupt sentinel) is `undefined`: the
 * next boundary fold installs a region (reader contract R11 — those bytes
 * were never served as a region).
 *
 * The region row stores no boundary column: the boundary is DERIVED from the
 * committed compartments (the newest covered end), which is what the fold
 * persists inside its transaction. A bust pass that arrives while a sibling
 * publish has already advanced that committed boundary replays with the
 * advanced value: the covered-prefix trim is window bookkeeping, not region
 * bytes — every message it removes was already summarized into the persisted
 * region — so the trim follows the committed coverage without rotating the
 * panels. The panels themselves stay frozen until a rotation-boundary
 * predicate fires (GLM R3: baseline advances ride rotation boundaries).
 * `allowAdvancedBoundary` admits exactly the bust lane (the post-fold
 * re-freeze and the bust-preflight replay); defer passes keep the
 * freeze-time value and replay byte-identical.
 */
export function prepareRegionReplay(
    db: Database,
    sessionId: string,
    allowAdvancedBoundary = false,
): InjectM0M1Result | undefined {
    const row = readCachedM0M1Row(db, sessionId);
    if (!row?.cached_m0_bytes) return undefined;
    const m0Bytes = toBuffer(row.cached_m0_bytes);
    if (!isSentinelRegionRow(m0Bytes) || decodeSystemRegionRow(m0Bytes) === null) {
        return undefined;
    }
    let boundary = row.cached_m0_last_baseline_end_message_id;
    if (allowAdvancedBoundary) {
        const committed = readCommittedBaselineEnd(db, sessionId);
        if (committed !== undefined) boundary = committed;
    }
    return {
        injected: true,
        prependedMessageCount: 0,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: true,
        decision: { value: false, reason: "cache_hit" },
        m0Bytes,
        m1Text: "",
        preparedMessages: [],
        preparedTrimBoundaryId: boundary,
    };
}

/** True when the persisted row is a region the serving reader can decode. */
export function hasServableRegion(db: Database, sessionId: string): boolean {
    return prepareRegionReplay(db, sessionId) !== undefined;
}

function isSentinelRegionRow(bytes: Buffer | Uint8Array): boolean {
    return isSystemRegionBytes(bytes);
}

export function injectM0M1(options: M0M1RenderOptions): InjectM0M1Result {
    const offKnowledgeFold = options.compactionOff === true && options.messages === undefined;
    if (options.compactionOff === true && !offKnowledgeFold) {
        // Headless carriage: the lane splices no synthetic heads. Compaction-off
        // serves the additive knowledge surface through the region row (the
        // off-wire knowledge fold above runs the zero-compartment path in
        // materializeM0); the message array is left untouched.
        return {
            injected: false,
            prependedMessageCount: 0,
            m0RematerializedThisPass: false,
            materializationContentionRetryExhausted: false,
            decision: { value: false, reason: null },
            m0Bytes: null,
            m1Text: "",
            preparedMessages: [],
            preparedTrimBoundaryId: null,
        };
    }
    const prepared = options.preparedPrefix;
    if (prepared) {
        // The freeze is only legitimate while the store still matches it: a
        // sibling that published compartments (or queued a structural
        // mutation) after the freeze must send this pass through the fold,
        // not replay a prefix whose baseline boundary has gone stale.
        const frozenStoreCoherent =
            prepared.m0RematerializedThisPass ||
            prepared.materializationContentionRetryExhausted ||
            ((getMaxCompartmentSeq(options.db, options.sessionId) ?? -1) ===
                (options.state.snapshotMarkers?.maxCompartmentSeq ??
                    options.state.cachedM0MaxCompartmentSeq ??
                    -1) &&
                (getMaxM0MutationId(options.db, options.sessionId) ?? 0) ===
                    (options.state.snapshotMarkers?.maxMutationId ??
                        options.state.cachedM0MaxMutationId ??
                        0));
        if (frozenStoreCoherent) {
            const prefixTrimStatus = options.messages
                ? trimToPreparedPrefix(options, prepared)
                : "not-attempted";
            return {
                ...prepared,
                prependedMessageCount: 0,
                prefixTrimStatus,
            };
        }
    }
    hydrateCachedM0Mural(options.db, options.sessionId, options.state);
    if (!options.workspaceIdentitySet && options.projectPath) {
        options = {
            ...options,
            workspaceIdentitySet: resolveWorkspaceIdentitySet(options.db, options.projectPath),
        };
    }
    const skipped: InjectM0M1Result = {
        injected: false,
        prependedMessageCount: 0,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: false,
        decision: { value: false, reason: "skipped" },
        m0Bytes: options.state.cachedM0Bytes,
        m1Text: null,
    };
    if (options.state.isSubagent && !options.compactionOff) return skipped;

    const decisionFromCompare = mustMaterialize({
        db: options.db,
        sessionId: options.sessionId,
        state: options.state,
        projectPath: options.projectPath,
        projectDirectory: options.projectDirectory,
        hardSignals: options.hardSignals,
        workspaceIdentitySet: options.workspaceIdentitySet,
        injectDocs: options.injectDocs,
        memoryEnabled: options.memoryEnabled,
        muralEnabled: options.muralEnabled,
        memoryInjectionBudgetTokens: options.memoryInjectionBudgetTokens,
        historyBudgetTokens: options.historyBudgetTokens,
        historyBudgetPolicyIdentity: options.historyBudgetPolicyIdentity,
        systemRegionMode: true,
    });
    const decision: MaterializeDecision = options.forceMaterializeReason
        ? { value: true, reason: options.forceMaterializeReason }
        : decisionFromCompare;
    let rematerialized = false;
    let contentionExhausted = false;
    let foldedBoundary: string | null | undefined;

    if (decision.value) {
        try {
            const materialized = materializeWithRetry(options);
            // Region rows carry no m[1]: the delta lives inside the region and
            // reconciles at the next rotation.
            applyMarkersToState(options.state, materialized.m0Bytes, materialized.snapshotMarkers);
            options.state.cachedM1Bytes = null;
            foldedBoundary = materialized.baselineEndMessageId;
            rematerialized = true;
        } catch (error) {
            if (!(error instanceof MaterializeContentionError)) throw error;
            // Preferred fallback: reuse the bytes this process already served
            // (frozen for the pass). A sibling process mutated state
            // mid-rotation; serving the slightly stale region this pass is
            // correct and the next pass retries.
            if (
                options.state.cachedM0Bytes &&
                decodeSystemRegionRow(options.state.cachedM0Bytes) !== null &&
                !options.allowFreshContentionFallback
            ) {
                options.state.snapshotMarkers =
                    options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
                contentionExhausted = true;
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries; reusing cached region`,
                );
            } else {
                // No process-local bytes exist (or force/emergency explicitly
                // permits fresh recovery bytes). Prefer the persisted sentinel
                // row; only when none exists render a fresh non-persisted
                // region — this pass is already a known bust.
                const persisted = prepareRegionReplay(options.db, options.sessionId);
                if (persisted?.m0Bytes && !options.allowFreshContentionFallback) {
                    options.state.cachedM0Bytes = Buffer.from(persisted.m0Bytes);
                    options.state.snapshotMarkers =
                        options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
                } else {
                    const fresh = renderFreshRegionNonPersisted(options);
                    options.state.cachedM0Bytes = fresh.m0Bytes;
                    options.state.snapshotMarkers = fresh.snapshotMarkers;
                }
                contentionExhausted = true;
                sessionLog(
                    options.sessionId,
                    `m[0] materialization contention exhausted after ${error.retries} retries with no cached fallback; rendered fresh non-persisted region`,
                );
            }
        }
    } else {
        options.state.snapshotMarkers =
            options.state.snapshotMarkers ?? snapshotMarkersFromCachedM0(options.state);
        if (!options.state.cachedM0Bytes) {
            const persisted = prepareRegionReplay(options.db, options.sessionId);
            if (persisted?.m0Bytes) options.state.cachedM0Bytes = Buffer.from(persisted.m0Bytes);
        }
    }

    if (
        !options.state.cachedM0Bytes ||
        !options.state.snapshotMarkers ||
        decodeSystemRegionRow(options.state.cachedM0Bytes) === null
    ) {
        // Nothing servable exists (pre-first-fold boot with a lost lock, or a
        // row the reader contract refuses). A pass that reached this point was
        // already priced as a bust; serving the host-only prompt keeps the
        // wire honest — the next pass re-materializes.
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }

    // Coherence law: a fold that ran this pass persists its boundary inside
    // the fold transaction, so the fold's own in-transaction value is
    // authoritative for a folded pass (no post-COMMIT re-read). When no fold
    // ran, the persisted row's boundary governs (the replay path froze the
    // same value at freeze time); a missing value falls back to it too.
    const persistedBoundary = readCachedBaselineState(options.db, options.sessionId).boundary;
    const preparedTrimBoundaryId = options.compactionOff
        ? null
        : rematerialized
          ? (foldedBoundary ?? persistedBoundary)
          : (prepared?.preparedTrimBoundaryId ?? persistedBoundary);
    let prefixTrimStatus: PrefixTrimStatus = "not-attempted";
    if (options.messages) {
        prefixTrimStatus = trimToPreparedPrefix(options, {
            m0RematerializedThisPass: rematerialized,
            materializationContentionRetryExhausted: contentionExhausted,
            preparedTrimBoundaryId,
        });
    }

    return {
        injected: true,
        prependedMessageCount: 0,
        m0RematerializedThisPass: rematerialized,
        materializationContentionRetryExhausted: contentionExhausted,
        decision,
        m0Bytes: options.state.cachedM0Bytes,
        m1Text: "",
        preparedMessages: [],
        preparedTrimBoundaryId,
        prefixTrimStatus,
    };
}
