// Region renderers — the pure byte-producers for the frozen system-region
// (design §25.1, assembly-v2 Unit 1 Step 2). Moved verbatim from
// inject-compartments.ts: the compartment/memory/user-profile renderers, their
// trims and budgets, the render-side m[0]/m[1] primitives, and the shared
// marker/state types they consume. The region grammar lives in ONE place here
// (renderRegionBody); the transform never invents wire bytes, it only asks
// this module to render them.

import { Buffer } from "node:buffer";
import { MEMORY_MURAL_BLOCK } from "../../agents/magic-context-prompt";
import {
    buildCompartmentBlock,
    type Compartment,
    type CompartmentDateRanges,
    escapeXmlAttr,
    escapeXmlContent,
    getCompartments,
    getLastCompartmentEndMessageId,
    isPartialCompartmentEnd,
    type SessionFact,
} from "../../features/magic-context/compartment-storage";
import {
    CATEGORY_PRIORITY,
    V2_MEMORY_CATEGORIES,
} from "../../features/magic-context/memory/constants";
import { compareMemorySelectionPriority } from "../../features/magic-context/memory/memory-selection";
import {
    getMaxMemoryIdForProjects,
    getMemoriesByProject,
    getMemoriesByProjects,
} from "../../features/magic-context/memory/storage-memory";
import type { Memory } from "../../features/magic-context/memory/types";
import { resolveMuralWire } from "../../features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "../../features/magic-context/mural/resolve-mural";
import { isNoContentCompartment } from "../../features/magic-context/no-content-compartment";
import {
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getMaxM0MutationId,
    getMaxMemoryMutationId,
    getMaxMemoryMutationIdForProjects,
    getMemoryMutationsForRender,
    getMemoryMutationsForRenderByProjects,
    getProjectState,
    MEMORY_VISIBILITY_MUTATION_CATEGORY,
    readProjectDocsCanonical,
} from "../../features/magic-context/storage";
import {
    executeSystemRegionRotation,
    isSystemRegionBytes,
    type RegionMarkers,
    readSystemRegion,
    sanitizeReceiptOperand,
} from "../../features/magic-context/system-region";
import {
    getActiveUserMemories,
    type UserMemory,
} from "../../features/magic-context/user-memory/storage-user-memory";
import {
    computeWorkspaceEpochFingerprint,
    expandWorkspaceIdentitySetWithAliases,
    resolveStoredPathWorkspaceIdentity,
    resolveWorkspaceIdentitySet,
    resolveWorkspaceShareCategories,
    sourceNameForMemory,
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
import { extractM0Block, renderCompartmentAtTier, renderDecayedCompartments } from "./decay-render";
import { historyLocalBudget } from "./decision-calibration";
import { isHostRenderedSystemMessage } from "./host-served-rows";
import { compareRawSessionMessageOrder, resolveHostServedBoundaryId } from "./read-session-chunk";
import { getMessageTimesFromOpenCodeDb } from "./read-session-db";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";
import { formatDate } from "./temporal-awareness";
import { renderUserProfileContent, USER_PROFILE_DESCRIPTION } from "./user-profile-render";

export interface M0SnapshotMarkers {
    projectMemoryEpoch: number;
    workspaceFingerprint: string | null;
    projectUserProfileVersion: number;
    maxCompartmentSeq: number;
    maxMemoryId: number;
    maxMutationId: number;
    maxMemoryMutationId: number;
    projectDocsHash: string;
    materializedAt: number;
    sessionFactsVersion: number;
    upgradeState: string | null;
    compartmentRenderEpoch: string | null;
    /** Records the renderer used by cached bytes; written on a natural HARD but never triggers one. */
    memoryRenderEpoch: string | null;
    /** Render template of the `<user-profile>` block: compared loud — a template
     *  change must fold cached m[0] / rotate stored regions exactly once. */
    profileRenderEpoch: string;
    // HARD-bust markers are captured from runtime signals at the injectM0M1
    // call site (NOT a pure DB read), so readCurrentM0SnapshotMarkers takes
    // them as inputs. The tool-set hash is retained for attribution only: its
    // process-global scope makes it deliberately ineligible to trigger a fold.
    systemHash: string;
    toolSetHash: string;
    modelKey: string;
    projectIdentity?: string | null;
    /** Hash of the image identity folded into this m0 baseline. */
    muralHash?: string | null;
    muralEnabled: boolean | null;
    renderBudgetIdentity: string | null;
    /** Numeric allowances used by the cached render; absent on older baselines. */
    renderedBudgets?: string | null;
}

/**
 * Runtime cache-eviction signals threaded into the materialization decision.
 * These are NOT derived from durable DB state like the content markers — they
 * come from the current flight (system-prompt hash, tool-set fingerprint,
 * provider/model key) plus the TTL idle window. Tool-set changes are observed
 * for attribution only; they never request a materialization.
 */
export interface M0HardSignals {
    systemHash: string;
    /** Empty or absent means the provider tool set is not observable this pass. */
    toolSetHash?: string;
    modelKey: string;
    /** True when the provider cache TTL has elapsed since lastResponseTime. */
    cacheExpired: boolean;
    /** Epoch ms of the last completed assistant response (end-of-turn). */
    lastResponseTime: number;
    /**
     * A native host compaction heading the live window, read from the messages
     * the host served this pass before anything trimmed them. Absent when the
     * window does not start with one.
     */
    hostCompaction?: HostCompactionWindow;
}

export interface M0M1State {
    sessionId: string;
    isSubagent?: boolean;
    cachedM0Bytes: Buffer | null;
    cachedM1Bytes: Buffer | null;
    cachedM0ProjectMemoryEpoch: number | null;
    cachedM0WorkspaceFingerprint: string | null;
    cachedM0ProjectUserProfileVersion: number | null;
    cachedM0MaxCompartmentSeq: number | null;
    cachedM0MaxMemoryId: number | null;
    cachedM0MaxMutationId: number | null;
    cachedM0MaxMemoryMutationId: number | null;
    cachedM0ProjectDocsHash: string | null;
    cachedM0MaterializedAt: number | null;
    cachedM0SessionFactsVersion: number | null;
    cachedM0UpgradeState: string | null;
    cachedM0SystemHash: string | null;
    cachedM0ToolSetHash: string | null;
    cachedM0ModelKey: string | null;
    cachedM0ProjectIdentity?: string | null;
    snapshotMarkers?: M0SnapshotMarkers | null;
    /** Keep the persisted mural image unchanged for the current cached M0 prompt;
     * replace it only when the next normal hard cache fold rebuilds that prompt. */
    cachedM0MuralDataUrl?: string | null;
    cachedM0MuralHash?: string | null;
}

export interface M0M1RenderOptions {
    db: Database;
    sessionId: string;
    messages?: MessageLike[];
    state: M0M1State;
    projectPath?: string;
    projectDirectory?: string;
    /** Defaults true. When false, m[0] omits the <project-docs> block and stores an empty docs hash. */
    injectDocs?: boolean;
    /** Defaults true. When false, suppress every memory-derived m[0]/m[1] surface. */
    memoryEnabled?: boolean;
    memoryInjectionBudgetTokens?: number;
    historyBudgetTokens?: number;
    historyBudgetPolicyIdentity?: string;
    userProfileBudgetTokens?: number;
    temporalAwareness?: boolean;
    /** Experimental image injection. The caller resolves model capability from
     * the models.dev metadata; unknown capability means no image is injected.
     * Normally left undefined: the mural is now rendered ON DEMAND inside the
     * HARD fold from `muralEnabled` + the fold's model key (see resolveMuralWire),
     * so the injected data-url only swaps on a natural fold. Tests may still pass
     * an explicit `mural` to drive the render deterministically. */
    mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string; contentHash?: string };
    /** Mural feature switch (mural.enabled). When true
     * and the fold's model accepts images, materializeM0 resolves + renders the
     * deterministic mural on demand and folds its image into the m[0] baseline. */
    muralEnabled?: boolean;
    isCacheBustingPass?: boolean;
    /** Force/emergency may serve a fresh recovery prefix even if persistence loses contention. */
    allowFreshContentionFallback?: boolean;
    /** Exact off-wire prefix chosen before reduction gates; do not decide again at delivery. */
    preparedPrefix?: InjectM0M1Result;
    /** Preserve the original host message order so prefix trimming can still identify the boundary after replay or pruning removes rows. */
    prefixTrimSourceOrder?: PrefixTrimSourceOrder;
    /** Persisted pair captured before a fallible preflight. Contention may recover
     * from it, but must not adopt a newer row written while the preflight ran. */
    contentionFallbackPrefix?: InjectM0M1Result;
    /**
     * Compaction-off mode (issue #266): materialize through the
     * zero-compartment path — memory/docs/user-profile render into m[0], but
     * historical compartment rows never reach `<session-history>` (no render,
     * no raw-tail trim, no boundary splice, no marker write), and the
     * isSubagent skip in injectM0M1 is lifted so subagent sessions receive
     * the additive knowledge blocks too.
     */
    compactionOff?: boolean;
    /** Provider-side cache-eviction signals for HARD-bust detection. */
    hardSignals?: M0HardSignals;
    workspaceIdentitySet?: WorkspaceIdentitySet;
    beforePhase3ForTest?: () => void;
    /**
     * Runs inside the transaction that records a HARD fold, just before it
     * commits (and again on each contention retry, whose earlier attempt rolled
     * back). Writes that must land only together with an executed fold, such as
     * converting legacy dropped-tool skeletons, go here. `rendered` carries the
     * bytes this fold is about to persist, so the caller can tell whether the
     * fold changes the served prefix or re-renders it byte-identically.
     */
    onFoldCommit?: (
        db: Database,
        rendered: { m0Bytes: Buffer; m1Bytes: Buffer; muralDataUrl: string | null },
    ) => void;
    /**
     * Frozen system-region residency (§3, frozen-system-region-residency design):
     * when enabled, this materialization boundary assembles the five panels ONCE
     * into the region (`m0Text` + separator + `m1Text`) and installs it as the
     * sentinel-encoded region row instead of the head-lane m[0]/m[1] bytes. The
     * fold reason becomes the rotation receipt reason. Off = head bytes, today.
     */
    systemRegion?: { enabled: boolean; reason: string };
    /** Region rotation promotion: fold as if this HARD reason had fired (the
     *  rotation transaction). Only ever set by the region promotion on a pass
     *  that already holds the boundary permission. */
    forceMaterializeReason?: string;
}

export interface PrefixTrimSourceOrder {
    /** Stable IDs in the exact order supplied by the host before this transform mutates the array. */
    messageIds: readonly string[];
    /** ID-less synthetic users are valid only as one contiguous leading block. */
    syntheticHeadCount: number;
    invalidReason: string | null;
}

export interface InjectM0M1Result {
    injected: boolean;
    prependedMessageCount: number;
    m0RematerializedThisPass: boolean;
    materializationContentionRetryExhausted: boolean;
    decision: MaterializeDecision;
    m0Bytes: Buffer | null;
    m1Text: string | null;
    preparedMessages?: MessageLike[];
    preparedTrimBoundaryId?: string | null;
    prefixTrimStatus?: PrefixTrimStatus;
}

export class RenderM1InvalidMarkersError extends Error {
    constructor(sessionId: string) {
        super(`Cannot render m[1] for ${sessionId}: missing cached m[0] snapshot markers`);
        this.name = "RenderM1InvalidMarkersError";
    }
}

// Compartment already carries p1..p4, importance, episodeType, legacy (v2 model B).
// Boundary dates are render-only values resolved from OpenCode's message database.
export type M0Compartment = Compartment & {
    startDate?: string | null;
    endDate?: string | null;
};

/**
 * The boundary (OpenCode message id) covered by a compartment set rendered into
 * m[0]+m[1] — the end message id of the newest compartment that has one, or
 * null when none does. Newer compartments without an end id (legacy rows, or
 * rows carried into a forked session) cannot be placed, so the rows after the
 * boundary stay raw rather than the whole window. The input is ordered
 * `sequence ASC`.
 */
export function lastCompartmentBoundaryId(compartments: readonly M0Compartment[]): string | null {
    return newestCompartmentEndId(compartments);
}

export function newestCompartmentEndId(compartments: readonly Compartment[]): string | null {
    for (let index = compartments.length - 1; index >= 0; index -= 1) {
        const id = compartments[index]?.endMessageId;
        if (typeof id === "string" && id.length > 0) return id;
    }
    return null;
}

export const DEFAULT_HISTORY_BUDGET_TOKENS = 60_000;

export const DEFAULT_MEMORY_BUDGET_TOKENS = 8_000;

export const DEFAULT_USER_PROFILE_BUDGET_TOKENS = 4_000;

export const MAX_FORCED_MEMORIES_PER_DELTA = 10;

export const M0_EMPTY_BODY = "<session-history></session-history>";

export const M1_EMPTY_PLACEHOLDER =
    "<session-history-since>(no new content since last materialization)</session-history-since>";

export interface WorkspaceRenderContext {
    identities: string[];
    expandedIdentities: string[];
    ownIdentities: string[];
    shareCategories: string[] | null;
    namesByIdentity: Map<string, string>;
    canonicalIdentityByStoredPath: Map<string, string>;
    isWorkspaced: boolean;
}

export interface MemoryRenderOptions {
    sourceNameByMemoryId?: ReadonlyMap<number, string>;
}

export function resolveWorkspaceRenderContext(args: {
    db: Database;
    projectPath?: string;
    workspaceIdentitySet?: WorkspaceIdentitySet;
}): WorkspaceRenderContext {
    if (!args.projectPath) {
        return {
            identities: [],
            expandedIdentities: [],
            ownIdentities: [],
            shareCategories: null,
            namesByIdentity: new Map(),
            canonicalIdentityByStoredPath: new Map(),
            isWorkspaced: false,
        };
    }
    const identitySet =
        args.workspaceIdentitySet ?? resolveWorkspaceIdentitySet(args.db, args.projectPath);
    const isWorkspaced = identitySet.identities.length > 1;
    const expanded = expandWorkspaceIdentitySetWithAliases(args.db, identitySet.identities);
    const expandedIdentities = isWorkspaced ? expanded.expandedIdentities : identitySet.identities;
    const canonicalIdentityByStoredPath = isWorkspaced
        ? expanded.canonicalIdentityByStoredPath
        : new Map(identitySet.identities.map((identity) => [identity, identity]));
    let ownIdentities = expandedIdentities.filter(
        (identity) => canonicalIdentityByStoredPath.get(identity) === args.projectPath,
    );
    if (ownIdentities.length === 0 && expandedIdentities.includes(args.projectPath)) {
        ownIdentities = [args.projectPath];
    }
    return {
        identities: identitySet.identities,
        expandedIdentities,
        ownIdentities,
        shareCategories: isWorkspaced
            ? resolveWorkspaceShareCategories(args.db, args.projectPath)
            : null,
        namesByIdentity: identitySet.namesByIdentity,
        canonicalIdentityByStoredPath,
        isWorkspaced,
    };
}

export function sourceNamesForMemories(args: {
    memories: readonly Memory[];
    projectPath?: string;
    workspace: WorkspaceRenderContext;
}): Map<number, string> | undefined {
    if (!args.projectPath || !args.workspace.isWorkspaced) return undefined;
    const names = new Map<number, string>();
    for (const memory of args.memories) {
        const source = sourceNameForMemory(
            memory.projectPath,
            args.projectPath,
            args.workspace.identities,
            args.workspace.namesByIdentity,
            args.workspace.canonicalIdentityByStoredPath,
        );
        if (source) names.set(memory.id, source);
    }
    return names.size > 0 ? names : undefined;
}

export function memoryCanonicalIdentity(
    memory: Memory,
    workspace: WorkspaceRenderContext,
): string | null {
    return resolveStoredPathWorkspaceIdentity(
        memory.projectPath,
        workspace.identities,
        workspace.canonicalIdentityByStoredPath,
    );
}

export function memoryRenderOrder(left: Memory, right: Memory): number {
    const leftPriority = V2_MEMORY_CATEGORIES.indexOf(
        left.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    const rightPriority = V2_MEMORY_CATEGORIES.indexOf(
        right.category as (typeof V2_MEMORY_CATEGORIES)[number],
    );
    if (leftPriority >= 0 || rightPriority >= 0) {
        if (leftPriority < 0) return 1;
        if (rightPriority < 0) return -1;
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
    } else if (left.category !== right.category) {
        return left.category < right.category ? -1 : 1;
    }
    return left.id - right.id;
}

const m0CompartmentStatements = new WeakMap<Database, PreparedStatement>();

const newCompartmentStatements = new WeakMap<Database, PreparedStatement>();

export function cachedStatement(
    cache: WeakMap<Database, PreparedStatement>,
    db: Database,
    sql: string,
): PreparedStatement {
    let stmt = cache.get(db);
    if (!stmt) {
        stmt = db.prepare(sql);
        cache.set(db, stmt);
    }
    return stmt;
}

export function getGlobalUserProfileVersion(db: Database): number {
    return getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)?.projectUserProfileVersion ?? 0;
}

export interface TrimMemoriesResultV2 {
    selected: Memory[];
    renderOrder: Memory[];
}

export function trimMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
    renderOptions: MemoryRenderOptions = {},
): TrimMemoriesResultV2 {
    const selectionOrder = [...memories].sort(compareMemorySelectionPriority);
    const selected: Memory[] = [];
    const accounting = createMemoryBlockAccounting(renderOptions);

    for (const memory of selectionOrder) {
        const cost = accounting.candidateCost(memory);
        if (accounting.usedTokens + cost > budgetTokens) continue;
        accounting.admit(memory, cost);
        selected.push(memory);
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    const renderOrder = [...selected].sort(memoryRenderOrder);

    return { selected, renderOrder };
}

export function trimWorkspaceMemoriesToBudgetV2(
    sessionId: string,
    memories: Memory[],
    budgetTokens: number,
    workspace: WorkspaceRenderContext,
    renderOptions: MemoryRenderOptions = {},
): TrimMemoriesResultV2 {
    if (!workspace.isWorkspaced) {
        return trimMemoriesToBudgetV2(sessionId, memories, budgetTokens, renderOptions);
    }

    const selected: Memory[] = [];
    const selectedIds = new Set<number>();
    const accounting = createMemoryBlockAccounting(renderOptions);
    const trySelect = (memory: Memory): boolean => {
        if (selectedIds.has(memory.id)) return false;
        const cost = accounting.candidateCost(memory);
        if (accounting.usedTokens + cost > budgetTokens) return false;
        selected.push(memory);
        selectedIds.add(memory.id);
        accounting.admit(memory, cost);
        return true;
    };

    for (const memory of memories
        .filter((candidate) => candidate.status === "permanent")
        .sort(compareMemorySelectionPriority)) {
        trySelect(memory);
    }

    const remainingAfterPermanent = Math.max(0, budgetTokens - accounting.usedTokens);
    const floorTokens = remainingAfterPermanent / Math.max(1, workspace.identities.length);
    const byIdentity = new Map<string, Memory[]>();
    for (const memory of memories) {
        if (memory.status === "permanent") continue;
        const identity = memoryCanonicalIdentity(memory, workspace);
        if (!identity) continue;
        const list = byIdentity.get(identity) ?? [];
        list.push(memory);
        byIdentity.set(identity, list);
    }

    for (const identity of workspace.identities) {
        let memberTokens = 0;
        const candidates = (byIdentity.get(identity) ?? []).sort(compareMemorySelectionPriority);
        for (const memory of candidates) {
            if (selectedIds.has(memory.id)) continue;
            const cost = accounting.candidateCost(memory);
            if (memberTokens + cost > floorTokens) continue;
            if (accounting.usedTokens + cost > budgetTokens) continue;
            selected.push(memory);
            selectedIds.add(memory.id);
            accounting.admit(memory, cost);
            memberTokens += cost;
        }
    }

    const remaining = memories
        .filter((memory) => !selectedIds.has(memory.id))
        .sort(compareMemorySelectionPriority);
    for (const memory of remaining) {
        trySelect(memory);
    }

    if (selected.length < memories.length) {
        sessionLog(
            sessionId,
            `v2 trimmed memories from ${memories.length} to ${selected.length} to fit injection budget of ${budgetTokens} tokens`,
        );
    }

    return { selected, renderOrder: [...selected].sort(memoryRenderOrder) };
}

export function safeGetActiveUserMemories(db: Database): UserMemory[] {
    try {
        return getActiveUserMemories(db);
    } catch (error) {
        if (String(error).includes("no such table: user_memories")) return [];
        throw error;
    }
}

export function trimUserMemoriesToBudget(
    memories: UserMemory[],
    budgetTokens: number,
): UserMemory[] {
    const selected: UserMemory[] = [];
    let usedTokens = 0;
    for (const memory of memories) {
        const tokens = estimateTokens(`- ${memory.content}`) + 4;
        if (usedTokens + tokens > budgetTokens) continue;
        selected.push(memory);
        usedTokens += tokens;
    }
    return selected;
}

export function readM0Compartments(db: Database, sessionId: string): M0Compartment[] {
    const rows = cachedStatement(
        m0CompartmentStatements,
        db,
        `SELECT id, session_id, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, episode_type,
                created_at, importance, legacy, rebase_status
           FROM compartments
          WHERE session_id = ?
          ORDER BY sequence ASC`,
    ).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map(rowToM0Compartment);
}

export function nullableString(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}

/**
 * Resolve every boundary in one OpenCode DB query for a fresh m[0] or m[1] render.
 * Callers invoke this only on existing materialize/refresh paths; defer passes replay
 * persisted bytes without consulting live timestamps.
 */
export function withCompartmentDates(
    db: Database,
    sessionId: string,
    compartments: M0Compartment[],
    temporalAwareness: boolean | undefined,
): M0Compartment[] {
    if (!temporalAwareness || compartments.length === 0) return compartments;

    const ordinals = new Set<number>();
    for (const compartment of compartments) {
        ordinals.add(compartment.startMessage);
        ordinals.add(compartment.endMessage);
    }
    const indexedRows = db
        .prepare(
            `SELECT message_ordinal AS ordinal, message_time_ms AS time
               FROM message_fts_rowid_map
              WHERE session_id = ?
                AND message_time_ms IS NOT NULL
                AND message_ordinal IN (SELECT value FROM json_each(?))`,
        )
        .all(sessionId, JSON.stringify([...ordinals])) as Array<{ ordinal: number; time: number }>;
    const indexedTimes = new Map(indexedRows.map((row) => [row.ordinal, row.time]));
    const fallbackIds = new Set<string>();
    for (const compartment of compartments) {
        if (!indexedTimes.has(compartment.startMessage) && compartment.startMessageId) {
            fallbackIds.add(compartment.startMessageId);
        }
        if (!indexedTimes.has(compartment.endMessage) && compartment.endMessageId) {
            fallbackIds.add(compartment.endMessageId);
        }
    }
    const fallbackTimes =
        fallbackIds.size > 0
            ? getMessageTimesFromOpenCodeDb(sessionId, Array.from(fallbackIds))
            : new Map<string, number>();
    return compartments.map((compartment) => {
        const startMs =
            indexedTimes.get(compartment.startMessage) ??
            fallbackTimes.get(compartment.startMessageId);
        const endMs =
            indexedTimes.get(compartment.endMessage) ?? fallbackTimes.get(compartment.endMessageId);
        if (startMs === undefined || endMs === undefined) return compartment;
        return {
            ...compartment,
            startDate: formatDate(startMs),
            endDate: formatDate(endMs),
        };
    });
}

export function rowToM0Compartment(row: Record<string, unknown>): M0Compartment {
    return {
        id: Number(row.id ?? 0),
        sessionId: String(row.session_id ?? ""),
        sequence: Number(row.sequence ?? 0),
        startMessage: Number(row.start_message ?? 0),
        endMessage: Number(row.end_message ?? 0),
        startMessageId: String(row.start_message_id ?? ""),
        endMessageId: String(row.end_message_id ?? ""),
        title: String(row.title ?? ""),
        content: String(row.content ?? ""),
        p1: nullableString(row.p1),
        p2: nullableString(row.p2),
        p3: nullableString(row.p3),
        p4: nullableString(row.p4),
        importance: Number(row.importance ?? 50),
        episodeType: nullableString(row.episode_type),
        legacy: Number(row.legacy ?? 0),
        createdAt: Number(row.created_at ?? 0),
        rebaseStatus: row.rebase_status === "unresolved" ? "unresolved" : "ok",
    };
}

export function readNewCompartments(
    db: Database,
    sessionId: string,
    afterSequence: number,
): M0Compartment[] {
    const rows = cachedStatement(
        newCompartmentStatements,
        db,
        `SELECT id, session_id, sequence, start_message, end_message, start_message_id,
                end_message_id, title, content, p1, p2, p3, p4, episode_type,
                created_at, importance, legacy, rebase_status
           FROM compartments
          WHERE session_id = ? AND sequence > ?
          ORDER BY sequence ASC`,
    ).all(sessionId, afterSequence) as Array<Record<string, unknown>>;
    return rows.map(rowToM0Compartment);
}

/**
 * Incremental token accounting for the grouped memory block. Trimming probes
 * hundreds of candidates against the budget; re-rendering and re-tokenizing the
 * whole block per probe is O(n²) in tokenizer passes (~250ms at a 260-memory
 * pool — a hot-path stall on materialize and the sidebar RPC). Instead: measure
 * the wrapper once, each candidate line once, and each category's open/close
 * tags once when that category first appears. BPE merges across the newline
 * joins can only shrink the whole relative to the sum of its parts, so this
 * additive account is a slight UPPER bound on the rendered block — trims stay
 * conservative and the injected block can only land under the budget, never
 * over it.
 */
export function createMemoryBlockAccounting(renderOptions: MemoryRenderOptions) {
    const seenCategories = new Set<string>();
    const categoryCost = new Map<string, number>();
    return {
        usedTokens: estimateTokens("<project-memory>\n</project-memory>"),
        candidateCost(memory: Memory): number {
            const line = renderMemoryLineV2(
                memory,
                renderOptions.sourceNameByMemoryId?.get(memory.id),
            );
            let cost = estimateTokens(`${line}\n`);
            if (!seenCategories.has(memory.category)) {
                let tags = categoryCost.get(memory.category);
                if (tags === undefined) {
                    tags = estimateTokens(
                        `<${escapeXmlAttr(memory.category)}>\n</${escapeXmlAttr(memory.category)}>\n`,
                    );
                    categoryCost.set(memory.category, tags);
                }
                cost += tags;
            }
            return cost;
        },
        admit(memory: Memory, cost: number): void {
            this.usedTokens += cost;
            seenCategories.add(memory.category);
        },
    };
}

/** Render one compact memory fact line. Importance still controls selection, but
 * is deliberately absent from the wire so classification-only updates do not change bytes. */
export function renderMemoryLineV2(memory: Memory, sourceName?: string): string {
    const source = sourceName ? ` [${escapeXmlContent(sourceName)}]` : "";
    return `#${memory.id}${source}: ${escapeXmlContent(memory.content)}`;
}

export function renderMemoryBlockV2(
    memories: Memory[],
    wrapper = "project-memory",
    renderOptions: MemoryRenderOptions = {},
): string {
    if (memories.length === 0) return "";
    const ordered = [...memories].sort(memoryRenderOrder);
    const lines = [`<${wrapper}>`];
    let openCategory: string | undefined;
    for (const memory of ordered) {
        if (memory.category !== openCategory) {
            if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
            openCategory = memory.category;
            lines.push(`<${escapeXmlAttr(openCategory)}>`);
        }
        lines.push(renderMemoryLineV2(memory, renderOptions.sourceNameByMemoryId?.get(memory.id)));
    }
    if (openCategory !== undefined) lines.push(`</${escapeXmlAttr(openCategory)}>`);
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

export function renderUserProfileBlock(memories: UserMemory[], wrapper = "user-profile"): string {
    if (memories.length === 0) return "";
    // The delta variant carries the same full description: one template, no
    // second set of bytes to freeze, and the authority framing matters most
    // exactly where fresh store rows just reached the wire.
    const lines = [`<${wrapper}>`, USER_PROFILE_DESCRIPTION];
    for (const memory of memories) {
        lines.push(`- ${escapeXmlContent(renderUserProfileContent(memory.content))}`);
    }
    lines.push(`</${wrapper}>`);
    return lines.join("\n");
}

/**
 * v2 decayed session-history rendering delegates entirely to the shared
 * `decay-render` module (which uses the validated `decay-curve` formula). This
 * keeps OpenCode and Pi byte-identical and ensures the council-validated decay
 * math is the single source of truth — no local approximation lives here.
 *
 * Facts are NOT a render input (v2 faithful: facts = promoted memories).
 */
export function renderSessionHistoryWithDecay(args: {
    compartments: M0Compartment[];
    historyBudgetTokens: number;
}): string {
    return renderDecayedCompartments({
        compartments: args.compartments,
        historyBudgetTokens: args.historyBudgetTokens,
    });
}

/** Remove a stale mural reference when a legacy cached baseline has no paired image payload. */
export function stripMemoryMuralBlock(m0Text: string): string {
    return m0Text
        .split("\n\n")
        .filter(
            (section) =>
                !(section.startsWith("<memory-mural>\n") && section.endsWith("\n</memory-mural>")),
        )
        .join("\n\n")
        .trim();
}

export function renderM0(args: {
    projectDocs: string;
    userProfileBaseline: UserMemory[];
    compartments: M0Compartment[];
    memories: Memory[];
    facts: SessionFact[];
    mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string };
    memoryRenderOptions?: MemoryRenderOptions;
    historyBudgetTokens?: number;
    userProfileBudgetTokens?: number;
    decayPressureMultiplier?: number;
    modelKey?: string;
}): string {
    const sections: string[] = [];
    if (args.projectDocs.length > 0) sections.push(args.projectDocs);
    const userProfile = renderUserProfileBlock(
        trimUserMemoriesToBudget(
            args.userProfileBaseline,
            args.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
        ),
    );
    if (userProfile) sections.push(userProfile);

    // The +15% drift "pressure multiplier" maps to a proportionally tighter
    // effective budget (lower budget → higher curve pressure → more demotion),
    // keeping decay-curve.ts the single source of pressure math.
    const baseBudget = historyLocalBudget(
        args.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        args.modelKey,
    );
    const effectiveBudget = baseBudget / Math.max(1, args.decayPressureMultiplier ?? 1);
    const sessionHistory = renderSessionHistoryWithDecay({
        compartments: args.compartments,
        historyBudgetTokens: effectiveBudget,
    });
    sections.push(
        sessionHistory.length > 0
            ? `<session-history>\n${sessionHistory}\n</session-history>`
            : M0_EMPTY_BODY,
    );

    const memoriesBlock = renderMemoryBlockV2(
        args.memories,
        "project-memory",
        args.memoryRenderOptions,
    );
    if (memoriesBlock) sections.push(memoriesBlock);
    if (args.mural?.enabled && args.mural.supportsVision && args.mural.dataUrl) {
        sections.push(MEMORY_MURAL_BLOCK);
    }
    return sections.join("\n\n").trim();
}

/**
 * Real-tokenizer size of ONLY the <session-history> slice of a rendered m[0].
 *
 * The over-budget tightening loop must compare the history block against the
 * history budget — NOT the whole m[0]. m[0] also carries <project-docs>,
 * <user-profile>, and <project-memory>, each with its own budget; charging
 * those fixed blocks against the history budget falsely inflates measured cost,
 * over-tightens decay pressure, and starves session-history (e.g. project-docs
 * ~20K eating into a 98K history budget collapsed the effective budget to ~73K,
 * archiving ~157 extra compartments). Returns 0 when no session-history slice is
 * present (empty-history placeholder), so the loop never fires on empty history.
 */
export function historySliceTokens(m0Text: string): number {
    const slice = extractM0Block(m0Text, "session-history");
    return slice ? estimateTokens(slice) : 0;
}

/**
 * Resolve the mural wire options for a HARD fold: no image unless the mural
 * feature is enabled AND this fold's model accepts images. Renders the
 * deterministic mural on demand (cheap change-detection; PNG only on change).
 * Returns undefined when the feature is off so renderM0 skips the block cleanly.
 */
export function resolveMuralForM0(
    options: M0M1RenderOptions,
    projectPath: string | undefined,
    modelKey: string,
    budgetTokens: number,
): MuralWireOptions | undefined {
    if (options.memoryEnabled === false || !options.muralEnabled) return undefined;
    return resolveMuralWire(options.db, projectPath, modelKey, true, budgetTokens);
}

export function renderMemoryUpdatesBlock(args: {
    db: Database;
    projectPath?: string;
    workspace: WorkspaceRenderContext;
    afterId: number;
    renderedMemoryIds: readonly number[];
    eligibleMemoryIds: ReadonlySet<number>;
}): { block: string; count: number; forcedMemoryIds: number[] } {
    if (!args.projectPath) {
        return { block: "", count: 0, forcedMemoryIds: [] };
    }

    const baselineIds = new Set(args.renderedMemoryIds);
    const mutations = args.workspace.isWorkspaced
        ? getMemoryMutationsForRenderByProjects(
              args.db,
              args.workspace.expandedIdentities,
              args.afterId,
              args.renderedMemoryIds,
          )
        : getMemoryMutationsForRender(
              args.db,
              args.projectPath,
              args.afterId,
              args.renderedMemoryIds,
          );
    if (mutations.length === 0) return { block: "", count: 0, forcedMemoryIds: [] };

    const forcedIds = new Set<number>();
    const lines = ["These memories changed since the snapshot below — trust these:"];
    for (const mutation of mutations) {
        if (mutation.mutationType === "superseded") {
            const replacementId = mutation.supersededById;
            if (
                replacementId !== null &&
                !baselineIds.has(replacementId) &&
                args.eligibleMemoryIds.has(replacementId)
            ) {
                forcedIds.add(replacementId);
            }
            if (!baselineIds.has(mutation.targetMemoryId)) continue;
            if (replacementId !== null && args.eligibleMemoryIds.has(replacementId)) {
                lines.push(`  <superseded id="${mutation.targetMemoryId}" by="${replacementId}"/>`);
            } else {
                lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
            }
            continue;
        }

        if (!baselineIds.has(mutation.targetMemoryId)) {
            if (mutation.visibilityChanged && args.eligibleMemoryIds.has(mutation.targetMemoryId)) {
                forcedIds.add(mutation.targetMemoryId);
            }
            continue;
        }
        if (!args.eligibleMemoryIds.has(mutation.targetMemoryId)) {
            lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
            continue;
        }
        if (mutation.visibilityChanged && mutation.newContent === null) continue;
        if (mutation.mutationType === "update") {
            const categoryAttr =
                mutation.category && mutation.category !== MEMORY_VISIBILITY_MUTATION_CATEGORY
                    ? ` category="${escapeXmlAttr(mutation.category)}"`
                    : "";
            lines.push(
                `  <updated id="${mutation.targetMemoryId}"${categoryAttr}>${escapeXmlContent(mutation.newContent ?? "")}</updated>`,
            );
            continue;
        }
        lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
    }

    const forcedMemoryIds = [...forcedIds]
        .sort((left, right) => left - right)
        .slice(0, MAX_FORCED_MEMORIES_PER_DELTA);
    if (lines.length === 1) return { block: "", count: 0, forcedMemoryIds };
    return {
        block: `<memory-updates>\n${lines.join("\n")}\n</memory-updates>`,
        count: lines.length - 1,
        forcedMemoryIds,
    };
}

export interface RenderM1Result {
    text: string;
    memoryUpdateCount: number;
    renderedMemoryIds: number[];
}

export function renderM1WithMetadata(
    options: M0M1RenderOptions,
    markers: M0SnapshotMarkers,
    renderedMemoryIds: readonly number[],
): RenderM1Result {
    if (!markers || markers.maxCompartmentSeq === undefined) {
        throw new RenderM1InvalidMarkersError(options.sessionId);
    }

    const blocks: string[] = [];
    const workspace = resolveWorkspaceRenderContext({
        db: options.db,
        projectPath: options.projectPath,
        workspaceIdentitySet: options.workspaceIdentitySet,
    });

    const eligibleMemories = options.projectPath
        ? workspace.isWorkspaced
            ? getMemoriesByProjects(
                  options.db,
                  workspace.expandedIdentities,
                  ["active", "permanent"],
                  markers.materializedAt,
                  workspace.ownIdentities,
                  workspace.shareCategories,
              )
            : getMemoriesByProject(
                  options.db,
                  options.projectPath,
                  ["active", "permanent"],
                  markers.materializedAt,
              )
        : [];
    const eligibleMemoryIds = new Set(eligibleMemories.map((memory) => memory.id));
    const memoryUpdates = renderMemoryUpdatesBlock({
        db: options.db,
        projectPath: options.projectPath,
        workspace,
        afterId: markers.maxMemoryMutationId,
        renderedMemoryIds,
        eligibleMemoryIds,
    });
    if (memoryUpdates.block) blocks.push(memoryUpdates.block);

    const newCompartments = withCompartmentDates(
        options.db,
        options.sessionId,
        readNewCompartments(options.db, options.sessionId, markers.maxCompartmentSeq).filter(
            (c) => !isNoContentCompartment(c),
        ),
        options.temporalAwareness,
    );
    if (newCompartments.length > 0) {
        blocks.push(
            `<new-compartments>\n${newCompartments
                .map((compartment) => renderCompartmentAtTier(compartment, 1))
                .join("\n\n")}\n</new-compartments>`,
        );
    }

    const forcedMemoryIds = new Set(memoryUpdates.forcedMemoryIds);
    const newMemories = eligibleMemories.filter(
        (memory) => memory.id > markers.maxMemoryId && !forcedMemoryIds.has(memory.id),
    );
    const newMemoryRenderOptions: MemoryRenderOptions = {
        sourceNameByMemoryId: sourceNamesForMemories({
            memories: eligibleMemories,
            projectPath: options.projectPath,
            workspace,
        }),
    };
    const trimmedNewMemories = trimMemoriesToBudgetV2(
        options.sessionId,
        newMemories,
        Math.max(
            1,
            Math.floor(
                (options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS) * 0.25,
            ),
        ),
        newMemoryRenderOptions,
    ).renderOrder;
    const deltaMemories = [
        ...trimmedNewMemories,
        ...eligibleMemories.filter((memory) => forcedMemoryIds.has(memory.id)),
    ];
    const newMemoriesBlock = renderMemoryBlockV2(
        deltaMemories,
        "new-memories",
        newMemoryRenderOptions,
    );
    if (newMemoriesBlock) blocks.push(newMemoriesBlock);

    const currentUserProfileVersion = getGlobalUserProfileVersion(options.db);
    if (
        options.memoryEnabled !== false &&
        currentUserProfileVersion !== markers.projectUserProfileVersion
    ) {
        const profileBlock = renderUserProfileBlock(
            trimUserMemoriesToBudget(
                safeGetActiveUserMemories(options.db),
                Math.max(
                    1,
                    Math.floor(
                        (options.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS) *
                            0.25,
                    ),
                ),
            ),
            "new-user-profile",
        );
        if (profileBlock) blocks.push(profileBlock);
    }

    // v2 faithful facts: session_facts is retired as a render source. Fresh
    // facts reach the agent as promoted memories via the new-memories block
    // above (maxMemoryId watermark), not via a <session_facts> delta here.

    const renderedNewMemoryIds = newMemoriesBlock
        ? trimmedNewMemories.map((memory) => memory.id)
        : [];
    if (blocks.length === 0) {
        return {
            text: M1_EMPTY_PLACEHOLDER,
            memoryUpdateCount: memoryUpdates.count,
            renderedMemoryIds: renderedNewMemoryIds,
        };
    }
    return {
        text: `<session-history-since>\n${blocks.join("\n")}\n</session-history-since>`,
        memoryUpdateCount: memoryUpdates.count,
        renderedMemoryIds: renderedNewMemoryIds,
    };
}

export function renderM1(
    options: M0M1RenderOptions,
    markers: M0SnapshotMarkers,
    renderedMemoryIds: readonly number[] = [],
): string {
    return renderM1WithMetadata(options, markers, renderedMemoryIds).text;
}

/**
 * A native OpenCode compaction (`/compact` or automatic) heading the live window.
 * OpenCode then serves [compaction request, summary, retained tail, newer rows]
 * and stops loading everything older. Magic Context's own marker pair has the
 * same shape and is never reported here.
 */
export interface HostCompactionWindow {
    compactionMessageId: string;
    summaryMessageId: string;
    /** Epoch ms at which the host finished writing the summary. */
    completedAt: number;
}

export interface MaterializeDecision {
    value: boolean;
    reason: string | null;
    /** Present only when the system-hash operands triggered this decision. */
    systemHashPrev?: string;
    systemHashNew?: string;
    /** Present only when the canonical model-key operands triggered this decision. */
    m0ModelKeyPrev?: string;
    m0ModelKeyNew?: string;
    /**
     * Present when the decision site compared the cached and live tool-set
     * fingerprints. These operands are observational: a difference never
     * triggers materialization. A null previous value means the cached baseline
     * had no recorded tool-set fingerprint yet.
     */
    m0ToolSetHashPrev?: string | null;
    m0ToolSetHashNew?: string | null;
}

/**
 * - `applied`: the boundary row was found and everything through it was cut.
 * - `boundary-precedes-window`: the boundary is not in the live array because
 *   the live window starts after it in persisted order (a host window that
 *   starts past the boundary). The summary covers nothing live; nothing is cut.
 * - `refused`: no cut was made this pass and the whole window is served. For a
 *   boundary missing from inside the window this is a counted degraded state
 *   that the next cache-busting pass heals by moving the boundary.
 *
 * Only `applied` proves the trim went through the named boundary; the marker
 * drain relies on that and treats every other status as unproven.
 */
export type PrefixTrimStatus =
    | "not-attempted"
    | "not-required"
    | "applied"
    | "boundary-precedes-window"
    | "refused";

/**
 * The region panel half (m[0] side), extracted verbatim from materializeM0's
 * fold (assembly-v2 Unit 1 Step 2 sever): compartment dating, memory trim,
 * mural resolve, decay render with the pressure re-tier loop, the never-empty
 * floor, and the mural freeze the fold persists. The snapshot markers carry
 * the frozen mural identity, exactly as the fold assigned them.
 */
export interface RegionM0Render {
    m0Text: string;
    m0Bytes: Buffer;
    datedCompartments: M0Compartment[];
    frozenMuralDataUrl: string | null;
    frozenMuralHash: string | null;
    renderedMemoryIds: number[];
}

export function renderRegionM0(args: {
    db: Database;
    sessionId: string;
    projectPath?: string;
    options: M0M1RenderOptions;
    docs: { renderedBlock: string; canonicalHash: string };
    snapshotMarkers: M0SnapshotMarkers;
    foldMaterializedAt: number;
    compartments: M0Compartment[];
    facts: SessionFact[];
    memories: Memory[];
    userMemories: UserMemory[];
    workspace: WorkspaceRenderContext;
}): RegionM0Render {
    const { options } = args;
    const projectPath = args.projectPath;
    const snapshotMarkers = args.snapshotMarkers;
    const foldMaterializedAt = args.foldMaterializedAt;
    const compartments = withCompartmentDates(
        args.db,
        args.sessionId,
        args.compartments,
        options.temporalAwareness,
    );
    const facts = args.facts;
    const userMemories = args.userMemories;
    const docs = args.docs;

    const memoryBudget = options.memoryInjectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
    const memoryRenderOptions: MemoryRenderOptions = {
        sourceNameByMemoryId: sourceNamesForMemories({
            memories: args.memories,
            projectPath,
            workspace: args.workspace,
        }),
    };
    const trimmed = args.workspace.isWorkspaced
        ? trimWorkspaceMemoriesToBudgetV2(
              options.sessionId,
              args.memories,
              memoryBudget,
              args.workspace,
              memoryRenderOptions,
          )
        : trimMemoriesToBudgetV2(options.sessionId, args.memories, memoryBudget);
    // On-demand mural: an explicit test-supplied `mural` wins; otherwise resolve
    // it from the feature flag + this fold's model key. Runs INSIDE the HARD fold
    // (not on defers), so the injected image only swaps on a natural fold — the
    // baked-in cachedM0MuralDataUrl replays on defer passes.
    const mural =
        options.memoryEnabled === false
            ? undefined
            : (options.mural ??
              resolveMuralForM0(options, projectPath, snapshotMarkers.modelKey, memoryBudget));
    let decayPressureMultiplier = 1;
    let m0Text = renderM0({
        projectDocs: docs.renderedBlock,
        userProfileBaseline: userMemories,
        compartments,
        memories: trimmed.renderOrder,
        facts,
        memoryRenderOptions,
        historyBudgetTokens: options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        modelKey: snapshotMarkers.modelKey,
        userProfileBudgetTokens: options.userProfileBudgetTokens,
        decayPressureMultiplier,
        mural,
    });

    let attempts = 0;
    const budget = historyLocalBudget(
        options.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
        snapshotMarkers.modelKey,
    );
    while (budget > 0 && historySliceTokens(m0Text) > budget * 1.05 && attempts < 3) {
        decayPressureMultiplier *= 1.15;
        m0Text = renderM0({
            projectDocs: docs.renderedBlock,
            userProfileBaseline: userMemories,
            compartments,
            memories: trimmed.renderOrder,
            facts,
            memoryRenderOptions,
            historyBudgetTokens: budget,
            userProfileBudgetTokens: options.userProfileBudgetTokens,
            decayPressureMultiplier,
            mural,
        });
        attempts += 1;
    }

    if (m0Text.length === 0) m0Text = M0_EMPTY_BODY;
    const m0Bytes = Buffer.from(m0Text, "utf8");
    const frozenMuralDataUrl =
        mural?.enabled && mural.supportsVision ? (mural.dataUrl ?? null) : null;
    const frozenMuralHash =
        mural?.enabled && mural.supportsVision ? (mural.contentHash ?? null) : null;
    snapshotMarkers.muralHash = frozenMuralHash;
    snapshotMarkers.materializedAt = foldMaterializedAt;
    return {
        m0Text,
        m0Bytes,
        datedCompartments: compartments,
        frozenMuralDataUrl,
        frozenMuralHash,
        renderedMemoryIds: trimmed.renderOrder.map((m) => m.id),
    };
}

/**
 * The region delta half (m[1] side), extracted verbatim from the materializeM0
 * fold transaction: the delta render plus the visible-memory identity the
 * fold persists alongside the bytes.
 */
export function renderRegionM1(args: {
    options: M0M1RenderOptions;
    workspace: WorkspaceRenderContext;
    snapshotMarkers: M0SnapshotMarkers;
    renderedMemoryIds: readonly number[];
}) {
    const m1Render = renderM1WithMetadata(
        {
            ...args.options,
            workspaceIdentitySet: {
                identities: args.workspace.identities,
                namesByIdentity: args.workspace.namesByIdentity,
            },
        },
        args.snapshotMarkers,
        args.renderedMemoryIds,
    );
    const m1Text = m1Render.text;
    const visibleMemoryIds = [
        ...new Set([...args.renderedMemoryIds, ...m1Render.renderedMemoryIds]),
    ];
    return { m1Text, m1Bytes: Buffer.from(m1Text, "utf8"), visibleMemoryIds };
}

/**
 * THE region grammar (design §25.1): the frozen system-region body is the
 * panel text and the delta text joined by a blank line. This is the only
 * place that composes the bytes the rotation installs — the transform and
 * the fold never join region halves themselves.
 */
export function renderRegionBody(m0Text: string, m1Text: string): string {
    return `${m0Text}\n\n${m1Text}`;
}
