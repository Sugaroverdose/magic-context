/**
 * Pi-side `<session-history>` injection — mirrors OpenCode's
 * `prepareCompartmentInjection` + `renderCompartmentInjection`
 * (packages/plugin/src/hooks/magic-context/inject-compartments.ts).
 *
 * Pi differences:
 *   - Pi messages have `content: string | (TextContent | ImageContent)[]`,
 *     not OpenCode's `parts: unknown[]`. We project Pi messages into a
 *     minimal MessageLike-shaped view so the shared
 *     `prepareCompartmentInjection` can do its DB read + cache lookup +
 *     boundary trim. The actual render writes back to Pi shape.
 *   - Pi messages don't have a stable per-message id at the AgentMessage
 *     layer. We synthesize one using the same `pi-msg-${index}-${ts}-${role}`
 *     scheme `transcript-pi.ts` uses, so the boundary-trim cutoff comparison
 *     stays consistent across passes.
 *
 * Cache safety:
 *   - `prepareCompartmentInjection` honors its own injection cache. On
 *     defer passes (`isCacheBusting=false`) the cached prepared block is
 *     replayed, the boundary trim is re-applied, and we just re-write the
 *     cached block after the leading system entries. Provider prompt cache stays stable.
 *   - On cache-busting passes (historian/compressor publish, /ctx-flush)
 *     the cache is rebuilt and the new block is written. Caller is
 *     responsible for setting `isCacheBusting` correctly via the shared
 *     historyRefreshSessions signal.
 */

import { MEMORY_MURAL_BLOCK } from "@magic-context/core/agents/magic-context-prompt";
import { isPartialCompartmentEnd } from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getMaxMemoryIdForProjects,
	getMemoriesByProject,
	getMemoriesByProjects,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import type { Memory } from "@magic-context/core/features/magic-context/memory/types";
import { resolveMuralWire } from "@magic-context/core/features/magic-context/mural/render-trigger";
import type { MuralWireOptions } from "@magic-context/core/features/magic-context/mural/resolve-mural";
import { isNoContentCompartment } from "@magic-context/core/features/magic-context/no-content-compartment";
import {
	type ContextDatabase,
	clearCachedM0M1,
	escapeXmlAttr,
	escapeXmlContent,
	GLOBAL_USER_PROFILE_PROJECT_PATH,
	getCompartments,
	getMaxM0MutationId,
	getMaxMemoryMutationId,
	getMaxMemoryMutationIdForProjects,
	getMemoryMutationsForRender,
	getMemoryMutationsForRenderByProjects,
	getOrCreateSessionMeta,
	getProjectState,
	persistCachedM0,
	readProjectDocsCanonical,
} from "@magic-context/core/features/magic-context/storage";
import { writeRegionVolatile } from "@magic-context/core/features/magic-context/storage-meta-shared";
import {
	decideSystemRegionRotation,
	decodeSystemRegionRow,
	executeSystemRegionRotation,
	isSystemRegionBytes,
	type RegionMarkers,
	readSystemRegion,
} from "@magic-context/core/features/magic-context/system-region";
import {
	getActiveUserMemories,
	type UserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	computeWorkspaceEpochFingerprint,
	expandWorkspaceIdentitySetWithAliases,
	resolveWorkspaceIdentitySet,
	resolveWorkspaceShareCategories,
	sourceNameForMemory,
} from "@magic-context/core/features/magic-context/workspaces";
import {
	COMPARTMENT_RENDER_EPOCH,
	decodeCachedM0UpgradeIdentity,
	encodeCachedM0UpgradeIdentity,
	MEMORY_RENDER_FORMAT_EPOCH,
	PROFILE_RENDER_EPOCH,
	renderBudgetIdentityChanged,
	renderedBudgetShrinkReason,
	renderedBudgetSnapshot,
} from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import {
	DEFAULT_HISTORY_BUDGET_TOKENS,
	extractM0Block,
	renderCompartmentAtTier,
	renderDecayedCompartments,
} from "@magic-context/core/hooks/magic-context/decay-render";
import { historyLocalBudget } from "@magic-context/core/hooks/magic-context/decision-calibration";
import {
	DEFAULT_MEMORY_BUDGET_TOKENS,
	DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	type MemoryRenderOptions,
	renderMemoryBlockV2,
	trimMemoriesToBudgetV2,
	trimUserMemoriesToBudget,
	trimWorkspaceMemoriesToBudgetV2,
	type WorkspaceRenderContext,
} from "@magic-context/core/hooks/magic-context/inject-compartments";

import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import {
	renderUserProfileContent,
	USER_PROFILE_DESCRIPTION,
} from "@magic-context/core/hooks/magic-context/user-profile-render";
import { piModelRefToCanonical } from "@magic-context/core/shared/harness-provider-map";
import { sessionLog as logSession } from "@magic-context/core/shared/logger";
import { logSlowWriteTransaction } from "@magic-context/core/shared/write-transaction-timing";
import { resolvePiStableId, SYNTH_USER_ID_PREFIX } from "./read-session-pi";
import {
	isPiSystemEntry,
	type PiSystemEntry,
	placePiInitialSystemAtHead,
} from "./system-entry-pi";

/**
 * Pi message shapes — kept structurally compatible with
 * `@earendil-works/pi-coding-agent`'s `AgentMessage` union. Same minimal
 * subset transcript-pi.ts uses.
 */
type PiTextContent = { type: "text"; text: string; textSignature?: string };
type PiImageContent = { type: "image"; data: string; mimeType: string };
type PiUserMessage = {
	role: "user";
	content: string | (PiTextContent | PiImageContent)[];
	timestamp?: number;
};
type PiAssistantMessage = {
	role: "assistant";
	content: unknown[];
	timestamp?: number;
};
type PiToolResultMessage = {
	role: "toolResult";
	content: unknown[];
	timestamp?: number;
};
type PiAgentMessage =
	| PiUserMessage
	| PiAssistantMessage
	| PiToolResultMessage
	| PiSystemEntry;

/** Resolve a live Pi message to the stable ID stored with its compartment boundary. */
function resolveStableId(
	msg: PiAgentMessage,
	index: number,
	entryIds: readonly (string | undefined)[] | undefined,
): string {
	return resolvePiStableId(msg, index, entryIds) ?? "";
}

/**
 * Mutate `piMessages` in place: remove non-system messages whose synthesized
 * id appears at or before the cutoff. Preserve all system entries and the tail.
 *
 * Mirrors the `messages.splice(0, cutoffIndex+1)` behavior the shared
 * `prepareCompartmentInjection` does on its (OpenCode) MessageLike[].
 *
 * # Synthetic-user (folded toolResult) cutoffs
 *
 * A compartment's `endMessageId` comes from `convertEntriesToRawMessages`,
 * which folds a run of `toolResult` entries into a synthetic-user RawMessage
 * with id `${SYNTH_USER_ID_PREFIX}<firstFoldedToolResultEntryId>`. The LIVE Pi
 * message array does NOT contain that synthetic id — folding is a historian-
 * chunking artifact only; the underlying toolResult messages are present as
 * real entries. So a raw `resolveStableId(msg) === cutoffMessageId` comparison
 * can never match a synth-user cutoff, `cutoffIndex` stays -1, and the
 * summarized prefix is never trimmed → duplicate content + overflow in
 * tool-heavy sessions. When the cutoff is synthetic, strip the prefix and match
 * against the underlying real toolResult entry id instead (the suffix is, by
 * construction, the real entry id of the first folded toolResult, which IS a
 * visible message). Trimming through that toolResult covers the whole folded
 * run because the bidirectional orphan sweep below removes the rest of the run.
 *
 * Returns the count of messages removed — used for log parity.
 */
function trimPiMessagesToBoundary(
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
	cutoffMessageId: string,
	trimMutableEntryIds = false,
	sessionId?: string,
	preserveBoundary = false,
): number {
	// Pi tool calls and results occupy separate entries. If only part of the
	// boundary message was summarized, keep the prefix: removing an earlier call
	// could make orphan cleanup also delete its still-needed result.
	if (cutoffMessageId.length === 0 || preserveBoundary) return 0;
	// Resolve a synthetic-user (folded toolResult) cutoff to the real entry id
	// of the underlying toolResult, which is what the live message carries.
	const effectiveCutoffId = cutoffMessageId.startsWith(SYNTH_USER_ID_PREFIX)
		? cutoffMessageId.slice(SYNTH_USER_ID_PREFIX.length)
		: cutoffMessageId;
	if (effectiveCutoffId.length === 0) return 0;
	let cutoffIndex = -1;
	for (let i = 0; i < piMessages.length; i++) {
		const msg = piMessages[i];
		if (msg && resolveStableId(msg, i, entryIds) === effectiveCutoffId) {
			cutoffIndex = i;
			break;
		}
	}
	if (cutoffIndex < 0) return 0;

	// Start with the same prefix trim as the shared OpenCode projection, then
	// repeatedly sweep both directions across Pi's split tool-call shape. The
	// sweep is intentionally scoped by the owning assistant message index, not by
	// bare callId: Pi/OpenCode may reuse callIds across turns, and a global callId
	// match can delete a valid kept-tail pair from a later turn. Pair ownership is
	// inferred from the nearest assistant carrying that callId (backward first,
	// then forward for legacy/test shapes where a result precedes its call). This
	// preserves the non-contiguous same-turn cleanup while avoiding cross-turn
	// over-removal.
	const remove = new Set<number>();
	let preserved = 0;
	for (let i = 0; i <= cutoffIndex; i++) {
		if (isPiSystemEntry(piMessages[i])) preserved++;
		else remove.add(i);
	}
	if (preserved > 0)
		logSession(
			sessionId ?? "unknown",
			`pi system entries preserved across fold: ${preserved}`,
		);

	let changed = true;
	while (changed) {
		changed = false;
		const removedCallKeys = new Set<string>();
		const removedResultKeys = new Set<string>();

		for (const index of remove) {
			const msg = piMessages[index];
			if (!msg) continue;
			if (msg.role === "assistant") {
				for (const callId of getPiToolCallIds(msg)) {
					removedCallKeys.add(toolPairKey(callId, index));
				}
			} else if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(piMessages, index, callId)
					: null;
				if (callId && ownerIndex !== null) {
					removedResultKeys.add(toolPairKey(callId, ownerIndex));
				}
			}
		}

		for (let i = 0; i < piMessages.length; i++) {
			if (remove.has(i)) continue;
			const msg = piMessages[i];
			if (!msg) continue;
			if (msg.role === "toolResult") {
				const callId = getPiToolResultCallId(msg);
				const ownerIndex = callId
					? findToolResultOwnerAssistantIndex(piMessages, i, callId)
					: null;
				if (
					callId &&
					ownerIndex !== null &&
					removedCallKeys.has(toolPairKey(callId, ownerIndex))
				) {
					remove.add(i);
					changed = true;
				}
				continue;
			}
			if (msg.role === "assistant") {
				const callIds = getPiToolCallIds(msg);
				if (
					callIds.some((callId) =>
						removedResultKeys.has(toolPairKey(callId, i)),
					)
				) {
					remove.add(i);
					changed = true;
				}
			}
		}
	}

	const kept = piMessages.filter((_, index) => !remove.has(index));
	const removed = piMessages.length - kept.length;
	piMessages.splice(0, piMessages.length, ...kept);
	if (trimMutableEntryIds && Array.isArray(entryIds)) {
		const keptIds = entryIds.filter((_, index) => !remove.has(index));
		entryIds.splice(0, entryIds.length, ...keptIds);
	}
	return removed;
}

function toolPairKey(callId: string, assistantIndex: number): string {
	return `${callId}\0${assistantIndex}`;
}

function findToolResultOwnerAssistantIndex(
	messages: readonly PiAgentMessage[],
	resultIndex: number,
	callId: string,
): number | null {
	for (let i = resultIndex - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	for (let i = resultIndex + 1; i < messages.length; i++) {
		const msg = messages[i];
		if (msg?.role === "assistant" && getPiToolCallIds(msg).includes(callId)) {
			return i;
		}
	}
	return null;
}

function getPiToolCallIds(message: PiAssistantMessage): string[] {
	if (!Array.isArray(message.content)) return [];
	const ids: string[] = [];
	for (const part of message.content) {
		if (
			part &&
			typeof part === "object" &&
			(part as Record<string, unknown>).type === "toolCall" &&
			typeof (part as Record<string, unknown>).id === "string"
		) {
			ids.push((part as Record<string, unknown>).id as string);
		}
	}
	return ids;
}

function getPiToolResultCallId(message: PiToolResultMessage): string | null {
	const callId = (message as Record<string, unknown>).toolCallId;
	return typeof callId === "string" && callId.length > 0 ? callId : null;
}

export const __test = {
	trimPiMessagesToBoundary,
	setProjectDocsReadObserverForTests(
		observer: (() => void) | undefined,
	): () => void {
		const previous = projectDocsReadObserverForTests;
		projectDocsReadObserverForTests = observer;
		return () => {
			projectDocsReadObserverForTests = previous;
		};
	},
};

const PI_M1_PLACEHOLDER =
	"<session-history-since>(no new content since last materialization)</session-history-since>";
const MAX_FORCED_MEMORIES_PER_DELTA = 10;
// Pi prefixes its dynamic legacy/ready marker with this stable renderer identity.
// readCurrentMarkers adds the compartment-derived suffix so a session upgrade
// invalidates m[0] exactly once.
const PI_M0_UPGRADE_STATE = "pi-m0m1-v2";
const EMPTY_MAX_COMPARTMENT_SEQ = -1;

export type PiCompartment = ReturnType<typeof getCompartments>[number];

type PiProjectDocsRender = ReturnType<typeof readProjectDocsCanonical>;

interface FrozenM0Inputs {
	docs: PiProjectDocsRender;
	markers: PiM0SnapshotMarkers;
	compartments: PiCompartment[];
	memories: Memory[];
	userProfile: UserMemory[];
	workspace: WorkspaceRenderContext;
}

/**
 * Real-tokenizer size of ONLY the <session-history> slice of a rendered m[0]
 * (parity with OpenCode's historySliceTokens). The over-budget tightening loop
 * must measure the history block against the history budget, not the whole m[0]
 * — m[0] also carries <project-docs>/<user-profile>/<project-memory>, each with
 * its own budget. Charging those against the history budget over-tightens decay
 * and starves session-history. Returns 0 when there's no history slice.
 */
function historySliceTokensPi(m0Text: string): number {
	const slice = extractM0Block(m0Text, "session-history");
	return slice ? estimateTokens(slice) : 0;
}

/**
 * Fail-open wrapper around getActiveUserMemories (parity with OpenCode's
 * safeGetActiveUserMemories). On a DB that predates the user_memories table
 * (unmigrated / partially-initialized), the raw call throws "no such table:
 * user_memories"; OpenCode degrades to an empty profile, so Pi must too —
 * otherwise m[0] materialization crashes the whole transform on such DBs.
 */
function safeGetActiveUserMemoriesPi(db: ContextDatabase): UserMemory[] {
	try {
		return getActiveUserMemories(db);
	} catch (error) {
		if (String(error).includes("no such table: user_memories")) return [];
		throw error;
	}
}

export interface PiM0M1State {
	sessionId: string;
	projectIdentity: string;
	projectDirectory: string;
	/** When false, every memory-derived surface is omitted from m[0]/m[1]
	 *  (config `memory.enabled=false`): project memory, user profile, deltas, and
	 *  the memory mural. Docs are controlled independently by injectDocs.
	 *  Unset/true keeps memory on. */
	memoryEnabled?: boolean;
	/** Defaults true. When false, m[0] omits the <project-docs> block and docs hash. */
	injectDocs?: boolean;
	/** Memory-block trim budget (~4K). Bounds the <project-memory> block. */
	injectionBudgetTokens?: number;
	/** v2 decay-render history budget (~60K). Drives compartment tier demotion.
	 *  Distinct from injectionBudgetTokens — using the memory budget here would
	 *  over-demote every compartment. */
	historyBudgetTokens?: number;
	historyBudgetPolicyIdentity?: string;
	/** User-profile block budget (~4K). The m[1] new-user-profile delta is
	 *  trimmed to 25% of this (matches OpenCode renderM1). Defaults when unset. */
	userProfileBudgetTokens?: number;
	/** Provider-side cache-eviction signals for HARD-bust detection. */
	hardSignals?: PiM0HardSignals;
	/** Mural feature switch (`mural.enabled`). When
	 *  true and the fold's model accepts images, HARD materialization resolves
	 *  + renders the deterministic mural on demand and folds its image into the
	 *  cached baseline. Defer passes replay the baked-in bytes without re-render. */
	muralEnabled?: boolean;
	/** Explicit mural wire options for tests. When set, skips on-demand resolve
	 * during HARD materialization (mirrors OpenCode `M0M1RenderOptions.mural`). */
	mural?: MuralWireOptions;
	/** Keeps memory/docs injection while suppressing compartment history rendering and trimming. */
	compactionOff?: boolean;
}

const EMPTY_PI_PROJECT_DOCS: PiProjectDocsRender = {
	renderedBlock: "",
	canonicalHash: "",
};

function getRenderableCompartmentsPi(
	db: ContextDatabase,
	state: PiM0M1State,
): PiCompartment[] {
	return state.compactionOff ? [] : getCompartments(db, state.sessionId);
}

let projectDocsReadObserverForTests: (() => void) | undefined;

function readProjectDocsFromDirectory(
	projectDirectory: string,
): PiProjectDocsRender {
	projectDocsReadObserverForTests?.();
	return readProjectDocsCanonical(projectDirectory);
}

function readProjectDocsForPiM0(state: PiM0M1State): PiProjectDocsRender {
	return state.injectDocs !== false
		? readProjectDocsFromDirectory(state.projectDirectory)
		: EMPTY_PI_PROJECT_DOCS;
}

/**
 * The project path used for MEMORY reads only. Returns undefined when
 * `memory.enabled=false`, so every memory read short-circuits to its empty
 * value (mirrors OpenCode passing `projectPath: undefined`). Project docs use
 * the independent injectDocs flag.
 */
function memoryProjectPath(state: PiM0M1State): string | undefined {
	return state.memoryEnabled === false ? undefined : state.projectIdentity;
}

function resolveWorkspaceRenderContextPi(
	state: PiM0M1State,
	db: ContextDatabase,
): WorkspaceRenderContext {
	const memPath = memoryProjectPath(state);
	if (!memPath) {
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
	const identitySet = resolveWorkspaceIdentitySet(db, memPath);
	const isWorkspaced = identitySet.identities.length > 1;
	const expanded = expandWorkspaceIdentitySetWithAliases(
		db,
		identitySet.identities,
	);
	const expandedIdentities = isWorkspaced
		? expanded.expandedIdentities
		: identitySet.identities;
	const canonicalIdentityByStoredPath = isWorkspaced
		? expanded.canonicalIdentityByStoredPath
		: new Map(identitySet.identities.map((identity) => [identity, identity]));
	let ownIdentities = expandedIdentities.filter(
		(identity) => canonicalIdentityByStoredPath.get(identity) === memPath,
	);
	if (ownIdentities.length === 0 && expandedIdentities.includes(memPath)) {
		ownIdentities = [memPath];
	}
	return {
		identities: identitySet.identities,
		expandedIdentities,
		ownIdentities,
		shareCategories: isWorkspaced
			? resolveWorkspaceShareCategories(db, memPath)
			: null,
		namesByIdentity: identitySet.namesByIdentity,
		canonicalIdentityByStoredPath,
		isWorkspaced,
	};
}

function sourceNamesForPiMemories(args: {
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

export interface PiM0SnapshotMarkers {
	maxCompartmentSeq: number;
	maxMemoryId: number;
	maxMutationId: number;
	maxMemoryMutationId: number;
	projectMemoryEpoch: number;
	workspaceFingerprint: string | null;
	projectUserProfileVersion: number;
	projectDocsHash: string;
	sessionFactsVersion: number;
	materializedAt: number;
	upgradeState: string;
	compartmentRenderEpoch: string | null;
	/** Records the renderer used by cached bytes; written on a natural HARD but never triggers one. */
	memoryRenderEpoch: string | null;
	/** `<user-profile>` render template edition: emptied ("" on legacy rows) — a
	 *  template change folds cached m[0] exactly once, mirroring OpenCode. */
	profileRenderEpoch: string;
	lastBaselineEndMessageId: string | null;
	// HARD-bust markers (parity with OpenCode M0SnapshotMarkers) are captured
	// from PiM0HardSignals. Pi has no tool-set hash because it has no equivalent
	// tool-definition hook.
	systemHash: string;
	modelKey: string;
	// Pi sessions can switch projects in-process (`/cd`). NULL on legacy cached
	// rows means unknown/lazy-adopted and must not force a HARD fold by itself.
	projectIdentity: string | null;
	muralEnabled: boolean;
	renderBudgetIdentity: string;
	/** Numeric allowances used by the cached render; absent on older baselines. */
	renderedBudgets?: string | null;
}

/**
 * Runtime cache-eviction signals threaded into Pi's materialization decision
 * (parity with OpenCode M0HardSignals). systemHash + cacheExpired derive from
 * session_meta; modelKey comes from the volatile liveModelBySession map in
 * context-handler. toolSetHash is always "" on Pi (no tool.definition hook).
 */
export interface PiM0HardSignals {
	systemHash: string;
	modelKey: string;
	cacheExpired: boolean;
	lastResponseTime: number;
}

/** Pi mirror of OpenCode's regionMarkersFromSnapshot (design §23 D7). */
export function regionMarkersFromPiSnapshot(
	markers: PiM0SnapshotMarkers,
): RegionMarkers {
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
 * Trim boundary legitimate for a region row (§23 D6): non-empty bytes the
 * funnel reader can serve AND a non-empty boundary co-resident in the same
 * row. Co-residence can only be produced by the fold rotation transaction
 * (materializeM0Pi's region branch writes bytes + boundary under one BEGIN
 * IMMEDIATE); the funnel's direct writers null the boundary at the write
 * site, so a non-null pair here is structurally fold-owned.
 */
export function derivePiRegionBoundary(
	db: ContextDatabase,
	sessionId: string,
	row?: CachedPiM0M1Row | null,
): string | null {
	const source = row ?? readCachedPiM0M1RowRaw(db, sessionId);
	if (!source?.cached_m0_bytes) return null;
	if (!isSystemRegionBytes(source.cached_m0_bytes)) return null;
	const decoded = decodeSystemRegionRow(source.cached_m0_bytes);
	if (typeof decoded !== "string" || decoded.length === 0) return null;
	const boundary = source.cached_m0_last_baseline_end_message_id;
	return typeof boundary === "string" && boundary.length > 0 ? boundary : null;
}

/**
 * Pi mirror of the OpenCode-1 regionRotationPromotion (§23 D7, L3/L4): the
 * stale-manifest / pressure decision runs on the SHARED
 * decideSystemRegionRotation table — one machine-checked table, both
 * harnesses. The wrapper is harness plumbing (store reads around the
 * table), not a second decision: it declines unless the caller's pass is
 * already busting (boundaryPermission), never originates a bust itself,
 * and leaves installs to the fold lane (mustMaterialize's
 * region_first_install).
 */
export function piRegionRotationPromotion(input: {
	state: PiM0M1State;
	db: ContextDatabase;
	passSnapshot?: PiM0M1PassSnapshot;
	systemRegionLane: boolean;
	foldDue: boolean;
	boundaryPermission: boolean;
	forceBand: boolean;
}): { promote: true; reason: string } | { promote: false; reason: null } {
	const decline = { promote: false, reason: null } as const;
	if (!input.systemRegionLane || input.foldDue || !input.boundaryPermission) {
		return decline;
	}
	const storedRegion = readSystemRegion(input.db, input.state.sessionId);
	if (storedRegion === null || storedRegion.length === 0) return decline;
	const compartments =
		input.passSnapshot?.compartments ??
		getRenderableCompartmentsPi(input.db, input.state);
	const meta =
		input.passSnapshot?.sessionMeta ??
		getOrCreateSessionMeta(input.db, input.state.sessionId);
	// Region rows present as absent to the pass-snapshot reader, so the
	// captured markers read their own persisted columns (live boundary).
	const captured = getCachedMarkers(
		input.db,
		input.state,
		compartments,
		meta,
		undefined,
	);
	const current = readCurrentMarkersFromCompartments(
		input.db,
		input.state,
		compartments,
		// Storm mirror (§25, Fix A): the current side must be the LIVE
		// canonical docs hash (the undefined fallback reads
		// readProjectDocsForPiM0). Passing meta.cachedM0ProjectDocsHash
		// here made current==captured and deadened the
		// project_docs_hash trigger forever.
		undefined,
	);
	const decision = decideSystemRegionRotation({
		storedRegion,
		capturedMarkers: captured ? regionMarkersFromPiSnapshot(captured) : null,
		currentMarkers: regionMarkersFromPiSnapshot(current),
		bustPermission: true,
		forceBand: input.forceBand,
		// No size/pressure arm (§25.3): the wrapper used to pass the
		// absolute stored-region size as if it were an un-folded delta — the
		// deleted pending-growth class. Growth is the marker comparison
		// above.
	});
	return decision.rotate ? { promote: true, reason: decision.reason } : decline;
}

const EMPTY_PI_HARD_SIGNALS: PiM0HardSignals = {
	systemHash: "",
	modelKey: "",
	cacheExpired: false,
	lastResponseTime: 0,
};

function renderBudgetIdentityPi(state: PiM0M1State): string {
	return `m${state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS}-h${state.historyBudgetPolicyIdentity ?? state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS}`;
}

export interface PiMaterializeMismatch {
	signal: string;
	cached: string | number | boolean | null;
	current: string | number | boolean | null;
}

export interface PiMaterializeDecision {
	value: boolean;
	reason: string | null;
	/** The exact compared values for the signal that fired. */
	mismatch?: PiMaterializeMismatch;
}

function piMaterializeMismatch(
	reason: string,
	signal: string,
	cached: PiMaterializeMismatch["cached"],
	current: PiMaterializeMismatch["current"],
): PiMaterializeDecision {
	return { value: true, reason, mismatch: { signal, cached, current } };
}

/** Convert a PNG data URL into Pi's native image content block (raw base64). */
function piImageFromDataUrl(dataUrl: string): PiImageContent | null {
	const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
	if (!match) return null;
	return { type: "image", mimeType: match[1], data: match[2] };
}

/**
 * Resolve mural wire options for a HARD fold. Explicit test `state.mural` wins;
 * otherwise gate on `muralEnabled` + vision capability via resolveMuralWire.
 * Returns undefined when the feature is off so renderM0Pi skips the block.
 */
function resolveMuralForM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	modelKey: string,
	budgetTokens: number,
): MuralWireOptions | undefined {
	if (state.memoryEnabled === false) return undefined;
	if (state.mural) return state.mural;
	if (!state.muralEnabled) return undefined;
	return resolveMuralWire(
		db,
		memoryProjectPath(state),
		modelKey,
		true,
		budgetTokens,
	);
}

export interface PiRenderedCompartmentBoundary {
	endMessageId: string | null;
	ordinal: number | null;
}

export interface PiM0M1InjectionResult extends PiInjectionResult {
	m0Materialized: boolean;
	m0Reason: string | null;
	m0Bytes: number;
	m1Bytes: number;
	/**
	 * True when this pass lost the materialization retry race and used temporary
	 * fallback content instead of a freshly persisted session-history cache. Keep
	 * deferred marker signals armed in that case because the rendered boundary may
	 * not match the latest saved compartment snapshot.
	 */
	contentionExhausted: boolean;
	/** The compartment boundary actually represented by the m[0]/m[1] pair sent. */
	renderedBoundary: PiRenderedCompartmentBoundary;
	/**
	 * Watermark of the compartment coverage rendered into the m[1] delta THIS
	 * pass (max end ordinal / end message id of the compartments included in
	 * the m[1] render), derived from the SAME compartment snapshot the render
	 * used. NULL unless m[1] was freshly recomputed this pass without a
	 * contention fallback: the soft-refresh sibling-fallback serves a sibling's
	 * stale cached m[1] (recomputed=false while contentionExhausted stays
	 * false) and the pure-replay branch serves bytes rendered by an earlier
	 * pass — neither may certify coverage for compartments those bytes never
	 * contained, so the deferred-marker drain keeps its signal armed and
	 * retries on the next fresh render. Per-pass in-memory ONLY (never
	 * persisted): the drain reads it solely on busting passes that freshly
	 * recomputed m[1]; replay passes never evaluate the m[1] coverage arm.
	 */
	m1RenderedCoverage: PiRenderedCompartmentBoundary | null;
	/**
	 * Length of the non-reclaimable leading span: native system entries followed
	 * by the injected m[0] + m[1] pair. Anchor-GC skips this span because the
	 * injected users and native compaction snapshot have no message-entry id.
	 * LKG ownership still retains real ids for native system entries.
	 */
	syntheticLeadingCount: number;
}

function decodeCachedM0(value: Buffer | Uint8Array | null): string | null {
	if (!value) return null;
	// Cross-lane discrimination: a frozen-system-region row belongs to the
	// OpenCode-1-TS region store; Pi never serves those bytes as head text.
	if (isSystemRegionBytes(value)) return null;
	return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
		"utf8",
	);
}

// v2: session_facts is retired as a render source (facts = promoted memories).
// The m[0] snapshot still carries a sessionFactsVersion field for shape
// stability, but it is pinned to 0 so it never drives re-materialization —
// fact changes no longer affect rendered bytes.
function getSessionFactsVersion(
	_db: ContextDatabase,
	_sessionId: string,
): number {
	return 0;
}

function normalizeCachedMaxCompartmentSeq(
	stored: number,
	compartments: readonly PiCompartment[],
): number {
	// Backward compatibility for legacy empty snapshots persisted with 0: only
	// reinterpret 0 as empty against the exact compartment snapshot used for the
	// cache-validity decision. If a seq-0 compartment exists, 0 is a real
	// watermark and must remain publishable; only a truly empty session upgrades
	// the legacy sentinel to EMPTY_MAX_COMPARTMENT_SEQ.
	if (stored === 0 && compartments.length === 0) {
		return EMPTY_MAX_COMPARTMENT_SEQ;
	}
	return stored;
}

function getCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
): string | null {
	const row = db
		.prepare(
			"SELECT cached_m0_last_baseline_end_message_id AS boundary FROM session_meta WHERE session_id = ?",
		)
		.get(sessionId) as { boundary?: unknown } | undefined;
	return typeof row?.boundary === "string" && row.boundary.length > 0
		? row.boundary
		: null;
}

export function trimPiMessagesToCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
	piMessages: PiAgentMessage[],
	entryIds: (string | undefined)[] | undefined,
	passSnapshot?: PiM0M1PassSnapshot,
): number {
	// Region lane (§23 D6, closes #2674): a boundary co-resident with a
	// servable frozen system region can only come from the fold rotation
	// transaction — the funnel's direct writers null the boundary at the
	// write site — so it is legitimate without m[1]. The reader-level
	// refusal keeps its force: an unservable (corrupt) region or a
	// funnel-written row yields no boundary here and falls through to the
	// head-lane guard, which declines both.
	let boundary: string | null =
		passSnapshot !== undefined
			? passSnapshot.regionBoundary
			: derivePiRegionBoundary(db, sessionId);
	if (boundary === null) {
		const row = passSnapshot?.cachedRow;
		const m0 = passSnapshot
			? passSnapshot.sessionMeta.cachedM0Bytes
			: undefined;
		const m1 = passSnapshot
			? passSnapshot.sessionMeta.cachedM1Bytes
			: undefined;
		const stored = passSnapshot
			? {
					m0,
					m1,
					boundary: row?.cached_m0_last_baseline_end_message_id,
				}
			: (db
					.prepare(
						`SELECT cached_m0_bytes AS m0, cached_m1_bytes AS m1,
						        cached_m0_last_baseline_end_message_id AS boundary
						 FROM session_meta WHERE session_id = ?`,
					)
					.get(sessionId) as
					| { m0?: unknown; m1?: unknown; boundary?: unknown }
					| undefined);
		if (!stored?.m0 || !stored.m1 || typeof stored.boundary !== "string")
			return 0;
		// H3 reader property (defense in depth below the write-site closure):
		// region bytes never describe head text, so no HEAD-lane boundary
		// decision may be derived from a row whose m0 is a frozen
		// system-region.
		const rawM0 = stored.m0;
		if (
			isSystemRegionBytes(
				typeof rawM0 === "string"
					? Buffer.from(rawM0, "utf8")
					: (rawM0 as Uint8Array),
			)
		)
			return 0;
		boundary = stored.boundary;
		if (boundary.length === 0) return 0;
	}
	const compartments =
		passSnapshot?.compartments ?? getCompartments(db, sessionId);
	const boundaryIsLive = compartments.some(
		(compartment) => compartment.endMessageId === boundary,
	);
	if (!boundaryIsLive) return 0;
	return trimPiMessagesToBoundary(
		piMessages,
		entryIds,
		boundary,
		true,
		sessionId,
		compartments.some(
			(c) => c.endMessageId === boundary && c.endBlockIndex != null,
		),
	);
}

function setCachedBoundary(
	db: ContextDatabase,
	sessionId: string,
	boundary: string | null,
): void {
	db.prepare(
		"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
	).run(boundary, sessionId);
}

function getCachedMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
	compartmentsForNormalization?: readonly PiCompartment[],
	metaOverride?: ReturnType<typeof getOrCreateSessionMeta>,
	cachedRowOverride?: CachedPiM0M1Row | null,
): PiM0SnapshotMarkers | null {
	const meta = metaOverride ?? getOrCreateSessionMeta(db, state.sessionId);
	if (!meta.cachedM0Bytes) return null;
	if (
		meta.cachedM0MaxCompartmentSeq === null ||
		meta.cachedM0MaxMemoryId === null ||
		meta.cachedM0MaxMutationId === null ||
		meta.cachedM0MaxMemoryMutationId === null ||
		meta.cachedM0ProjectMemoryEpoch === null ||
		meta.cachedM0ProjectUserProfileVersion === null ||
		meta.cachedM0ProjectDocsHash === null ||
		meta.cachedM0SessionFactsVersion === null ||
		meta.cachedM0MaterializedAt === null ||
		meta.cachedM0UpgradeState === null
	) {
		return null;
	}
	const compartments =
		compartmentsForNormalization ?? getRenderableCompartmentsPi(db, state);
	const cachedUpgradeIdentity = decodeCachedM0UpgradeIdentity(
		meta.cachedM0UpgradeState,
	);
	const maxCompartmentSeq = normalizeCachedMaxCompartmentSeq(
		meta.cachedM0MaxCompartmentSeq,
		compartments,
	);
	const cachedBoundary =
		cachedRowOverride === undefined
			? getCachedBoundary(db, state.sessionId)
			: typeof cachedRowOverride?.cached_m0_last_baseline_end_message_id ===
						"string" &&
					cachedRowOverride.cached_m0_last_baseline_end_message_id.length > 0
				? cachedRowOverride.cached_m0_last_baseline_end_message_id
				: null;
	// Invalidate a null cached boundary ONLY when the live snapshot actually has
	// a usable boundary — i.e. the cache is genuinely stale (a boundary appeared
	// since it was written). An empty `end_message_id` on the latest compartment
	// is a LEGITIMATE state (schema default ''; OpenCode degrades to "inject
	// without visible-prefix trimming"), so a materialize can correctly persist a
	// null boundary. Rejecting that every pass caused a re-materialize loop for
	// legacy / partially-upgraded sessions. When the live snapshot also has no
	// usable boundary, reuse the cache and degrade to no-trim.
	const liveBoundary = lastBaselineEndMessageId(compartments);
	if (
		maxCompartmentSeq >= 0 &&
		cachedBoundary === null &&
		liveBoundary !== null
	) {
		return null;
	}
	return {
		maxCompartmentSeq,
		maxMemoryId: meta.cachedM0MaxMemoryId,
		maxMutationId: meta.cachedM0MaxMutationId,
		maxMemoryMutationId: meta.cachedM0MaxMemoryMutationId,
		projectMemoryEpoch: meta.cachedM0ProjectMemoryEpoch,
		workspaceFingerprint: meta.cachedM0WorkspaceFingerprint,
		projectUserProfileVersion: meta.cachedM0ProjectUserProfileVersion,
		projectDocsHash: meta.cachedM0ProjectDocsHash,
		sessionFactsVersion: meta.cachedM0SessionFactsVersion,
		materializedAt: meta.cachedM0MaterializedAt,
		upgradeState: cachedUpgradeIdentity.upgradeState ?? "",
		compartmentRenderEpoch: cachedUpgradeIdentity.compartmentRenderEpoch,
		memoryRenderEpoch: cachedUpgradeIdentity.memoryRenderEpoch,
		profileRenderEpoch: cachedUpgradeIdentity.profileRenderEpoch ?? "",
		// The boundary that was persisted WITH these cached m[0] bytes (may be
		// null for a legitimately-boundaryless baseline — see the guard above).
		lastBaselineEndMessageId: cachedBoundary,
		systemHash: meta.cachedM0SystemHash ?? "",
		modelKey: meta.cachedM0ModelKey ?? "",
		projectIdentity: meta.cachedM0ProjectIdentity ?? null,
		muralEnabled: cachedUpgradeIdentity.muralEnabled ?? false,
		renderBudgetIdentity: cachedUpgradeIdentity.renderBudgetIdentity ?? "",
		renderedBudgets: cachedUpgradeIdentity.renderedBudgets,
	};
}

function lastBaselineEndMessageId(
	compartments: readonly PiCompartment[],
): string | null {
	const last = compartments.at(-1);
	return last?.endMessageId && last.endMessageId.length > 0
		? last.endMessageId
		: null;
}

function readCurrentMarkers(
	db: ContextDatabase,
	state: PiM0M1State,
	projectDocsHash?: string,
): PiM0SnapshotMarkers {
	return readCurrentMarkersFromCompartments(
		db,
		state,
		getRenderableCompartmentsPi(db, state),
		projectDocsHash,
	);
}

function readCurrentMarkersFromCompartments(
	db: ContextDatabase,
	state: PiM0M1State,
	compartments: readonly PiCompartment[],
	projectDocsHash?: string,
): PiM0SnapshotMarkers {
	const memPath = memoryProjectPath(state);
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const maxMemoryId = memPath
		? workspace.isWorkspaced
			? getMaxMemoryIdForProjects(
					db,
					workspace.expandedIdentities,
					workspace.ownIdentities,
					workspace.shareCategories,
				)
			: getMaxMemoryIdForProjects(db, [memPath])
		: 0;
	const projectState = memPath ? getProjectState(db, memPath) : undefined;
	const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
	return {
		// reduce, not Math.max(...spread): a project with very many
		// compartments/memories (100K+) blows the call-stack arg limit and
		// throws RangeError, breaking m[0]/m[1] rendering for that session.
		// OpenCode uses SQL COALESCE(MAX(id),0) with no such limit.
		maxCompartmentSeq:
			compartments.length > 0
				? compartments.reduce(
						(max, compartment) =>
							compartment.sequence > max ? compartment.sequence : max,
						EMPTY_MAX_COMPARTMENT_SEQ,
					)
				: EMPTY_MAX_COMPARTMENT_SEQ,
		maxMemoryId,
		maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
		maxMemoryMutationId: memPath
			? workspace.isWorkspaced
				? (getMaxMemoryMutationIdForProjects(
						db,
						workspace.expandedIdentities,
					) ?? 0)
				: (getMaxMemoryMutationId(db, memPath) ?? 0)
			: 0,
		projectMemoryEpoch: projectState?.projectMemoryEpoch ?? 0,
		workspaceFingerprint: workspace.isWorkspaced
			? computeWorkspaceEpochFingerprint(db, workspace.identities)
			: null,
		projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
		projectDocsHash:
			projectDocsHash ?? readProjectDocsForPiM0(state).canonicalHash,
		sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
		materializedAt: Date.now(),
		// Dynamic upgrade state (parity with OpenCode getUpgradeState): suffix
		// "legacy" when any legacy=1 compartment remains, else "ready". A recomp
		// that rebuilds legacy rows into tiered ones flips the marker so m[0]
		// re-materializes with the rebuilt content. A static const would leave Pi
		// serving stale legacy-rendered m[0] after the rebuild.
		upgradeState: `${PI_M0_UPGRADE_STATE}:${
			compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
		}`,
		compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
		memoryRenderEpoch: MEMORY_RENDER_FORMAT_EPOCH,
		profileRenderEpoch: PROFILE_RENDER_EPOCH,
		lastBaselineEndMessageId: lastBaselineEndMessageId(compartments),
		systemHash: (state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).systemHash,
		modelKey: piModelRefToCanonical(
			(state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).modelKey,
		),
		projectIdentity: state.projectIdentity,
		muralEnabled: state.muralEnabled === true,
		renderBudgetIdentity: renderBudgetIdentityPi(state),
		renderedBudgets: renderedBudgetSnapshot(
			state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
			state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
		),
	};
}

export function mustMaterializePi(
	state: PiM0M1State,
	db: ContextDatabase,
	currentCompartmentsOverride?: readonly PiCompartment[],
	passSnapshot?: PiM0M1PassSnapshot,
	options?: { systemRegionMode?: boolean },
): PiMaterializeDecision {
	const meta =
		passSnapshot?.sessionMeta ?? getOrCreateSessionMeta(db, state.sessionId);
	const regionMode = options?.systemRegionMode === true;
	if (!meta.cachedM0Bytes) return { value: true, reason: "first_render" };
	if (regionMode) {
		// Region-lane arms (§23 D5, parity with mustMaterialize's
		// systemRegionMode): a region row legitimately carries no m[1] and is
		// not head bytes, so the head-decode arms must not judge it. Anything
		// the funnel reader cannot serve (absent, legacy, corrupt) folds once
		// as an install — the fold lane owns installs, never the promotion.
		if (readSystemRegion(db, state.sessionId) === null) {
			return { value: true, reason: "region_first_install" };
		}
	} else {
		if (!meta.cachedM1Bytes)
			return { value: true, reason: "cached_m1_missing" };
		// Keep invalid cached baselines on the guarded materialize path. The
		// cache_invalid branch below does not have its own contention fallback,
		// so detecting empty decoded bytes here prevents a lease-contention
		// false negative from dropping m[0]/m[1] entirely.
		if (!decodeCachedM0(meta.cachedM0Bytes)) {
			return { value: true, reason: "cache_invalid" };
		}
	}
	// Accept a caller-provided snapshot so the materialize decision and the
	// subsequent cached-marker reload in injectM0M1Pi normalize against the SAME
	// compartment set. Re-reading here (when the caller already read) opened a
	// TOCTOU where a count change between the decision and the reload could flip
	// markers to null and escape to the unguarded re-materialize path.
	const currentCompartments =
		currentCompartmentsOverride ?? getRenderableCompartmentsPi(db, state);
	const current = readCurrentMarkersFromCompartments(
		db,
		state,
		currentCompartments,
		// Project-doc edits are deliberately soft: they ride the next natural HARD
		// fold. Reuse the persisted hash for the cache decision so defer passes do
		// not synchronously read and fingerprint docs they cannot materialize.
		meta.cachedM0ProjectDocsHash ?? undefined,
	);
	const cached = getCachedMarkers(
		db,
		state,
		currentCompartments,
		meta,
		// Region mode: the pass-snapshot row presents as absent for a region
		// (Stage P reader closure), so its null must not be read as "boundary
		// absent" by the cached-marker CAS. Read the boundary live instead.
		regionMode ? undefined : passSnapshot?.cachedRow,
	);
	if (cached === null) {
		return { value: true, reason: "cache_invalid" };
	}
	// Compartment byte-shape changes fold cached m[0] exactly once. Memory
	// selection epochs are ride-only: they persist on the next natural HARD so a
	// defer pass cannot change an existing session's frozen prefix.
	if (cached.compartmentRenderEpoch !== current.compartmentRenderEpoch) {
		return piMaterializeMismatch(
			"compartment_render_epoch",
			"compartmentRenderEpoch",
			cached.compartmentRenderEpoch,
			current.compartmentRenderEpoch,
		);
	}
	// Template bytes adopt loud (parity with OpenCode): a legacy row's "" vs the
	// current epoch folds once, then the persisted component consumes the arm.
	if (cached.profileRenderEpoch !== current.profileRenderEpoch) {
		return piMaterializeMismatch(
			"profile_render_epoch",
			"profileRenderEpoch",
			cached.profileRenderEpoch,
			current.profileRenderEpoch,
		);
	}
	if (cached.muralEnabled !== current.muralEnabled) {
		// Region-lane exemption (plugin inject-compartments guard, U1): in
		// region mode the fold's freeze persists on the stored row, so an
		// absent current flag means "not observed this pass", not "switched
		// off" — firing it would re-fold with the mural stripped on every
		// flag-less pass.
		if (
			!(options?.systemRegionMode === true && state.muralEnabled === undefined)
		) {
			return piMaterializeMismatch(
				`render_config:mural(${cached.muralEnabled}→${current.muralEnabled})`,
				"muralEnabled",
				cached.muralEnabled,
				current.muralEnabled,
			);
		}
	}
	if (
		renderBudgetIdentityChanged(
			cached.renderBudgetIdentity,
			current.renderBudgetIdentity,
		)
	) {
		return piMaterializeMismatch(
			`render_config:budget(${cached.renderBudgetIdentity}→${current.renderBudgetIdentity})`,
			"renderBudgetIdentity",
			cached.renderBudgetIdentity,
			current.renderBudgetIdentity,
		);
	}
	const budgetShrinkReason = renderedBudgetShrinkReason(
		cached.renderedBudgets,
		current.renderedBudgets,
	);
	if (budgetShrinkReason) {
		return piMaterializeMismatch(
			budgetShrinkReason,
			"renderedBudgets",
			cached.renderedBudgets ?? null,
			current.renderedBudgets ?? null,
		);
	}
	// ── HARD: provider-side cache eviction (the cache was already dead) ──
	// Parity with OpenCode mustMaterialize. An empty current signal means
	// "unknown this pass" and is never treated as a change. Pi never produces a
	// toolSetHash (no tool.definition hook), so that branch is effectively inert
	// on Pi — kept for structural parity. See PARITY.md.
	const hard = state.hardSignals ?? EMPTY_PI_HARD_SIGNALS;
	const canonicalHardModelKey = piModelRefToCanonical(hard.modelKey);
	const canonicalCachedModelKey = piModelRefToCanonical(
		meta.cachedM0ModelKey ?? "",
	);
	if (
		canonicalHardModelKey !== "" &&
		canonicalHardModelKey !== canonicalCachedModelKey
	) {
		return piMaterializeMismatch(
			"model_change",
			"modelKey",
			canonicalCachedModelKey,
			canonicalHardModelKey,
		);
	}
	if (
		hard.systemHash !== "" &&
		hard.systemHash !== (meta.cachedM0SystemHash ?? "")
	) {
		return piMaterializeMismatch(
			"system_hash",
			"systemHash",
			meta.cachedM0SystemHash ?? "",
			hard.systemHash,
		);
	}
	// Pi can switch projects within the same session (`/cd`). Legacy cached rows
	// have a NULL marker: treat that as unknown/MATCH for lazy adoption so the
	// first post-upgrade no-switch pass does not HARD-fold existing sessions.
	if (
		meta.cachedM0ProjectIdentity !== null &&
		meta.cachedM0ProjectIdentity !== state.projectIdentity
	) {
		return piMaterializeMismatch(
			"project_change",
			"projectIdentity",
			meta.cachedM0ProjectIdentity,
			state.projectIdentity,
		);
	}
	// Idle > TTL: self-consuming guard via cachedM0MaterializedAt (parity with
	// OpenCode). cacheExpired stays true every pass until lastResponseTime
	// updates, so fold only when the last response is newer than the last
	// materialization; the fold sets materializedAt = now, so the rest of the
	// turn skips. Next idle-after-response re-arms.
	if (
		hard.cacheExpired &&
		hard.lastResponseTime > 0 &&
		hard.lastResponseTime > (meta.cachedM0MaterializedAt ?? 0)
	) {
		return piMaterializeMismatch(
			"ttl_idle",
			"lastResponseTimeAfterMaterialization",
			meta.cachedM0MaterializedAt ?? 0,
			hard.lastResponseTime,
		);
	}

	// ── HARD: genuine m[0] CONTENT change ──
	if (cached.upgradeState !== current.upgradeState) {
		return piMaterializeMismatch(
			"renderer_upgrade",
			"upgradeState",
			cached.upgradeState,
			current.upgradeState,
		);
	}
	if (
		current.workspaceFingerprint !== null ||
		(meta.cachedM0WorkspaceFingerprint ?? null) !== null
	) {
		if (
			current.workspaceFingerprint !==
			(meta.cachedM0WorkspaceFingerprint ?? null)
		) {
			return piMaterializeMismatch(
				"project_memory_change",
				"workspaceFingerprint",
				meta.cachedM0WorkspaceFingerprint ?? null,
				current.workspaceFingerprint,
			);
		}
	} else if (
		current.projectMemoryEpoch !== (meta.cachedM0ProjectMemoryEpoch ?? 0)
	) {
		return piMaterializeMismatch(
			"project_memory_change",
			"projectMemoryEpoch",
			meta.cachedM0ProjectMemoryEpoch ?? 0,
			current.projectMemoryEpoch,
		);
	}
	// Use !== (not >), matching OpenCode mustMaterialize: a max-id that DECREASES
	// (revert / message.removed shrinking the compartment or mutation set) must
	// still invalidate m[0]. A '>' comparison would miss a decrease and serve a
	// stale cached baseline.
	if (current.maxMutationId !== (meta.cachedM0MaxMutationId ?? 0)) {
		return piMaterializeMismatch(
			"pending_mutations",
			"maxMutationId",
			meta.cachedM0MaxMutationId ?? 0,
			current.maxMutationId,
		);
	}
	// new_compartment is NOT a trigger (parity with OpenCode — Bug 1 fix): new
	// compartments are an m[1] delta (renderM1Pi readNewCompartments WHERE
	// sequence > cachedM0Seq, normalized via normalizeCachedMaxCompartmentSeq in
	// the render path), folded into m[0] only on a HARD bust.
	// project_user_profile_version is also NOT a trigger: additive user-profile
	// rides the m[1] <new-user-profile> delta.
	// maxMemoryId is deliberately NOT a materialization trigger (parity with
	// OpenCode): new memories are additive and surface in m[1] via the
	// maxMemoryId watermark, so they must not bust the m[0] cache. Memory
	// mutations use cachedM0MaxMemoryMutationId as an m[1] reconcile cursor,
	// not as a materialization trigger; keep it out of this trigger set.
	// projectDocsHash is also NOT a trigger: docs-only edits ride along
	// until a natural HARD fold, which reads fresh docs and persists the hash
	// matching the bytes it rendered. The shared DELTA_TRIGGER_FIELDS table
	// the promotion comparator reads is empty by owner ruling (Task 3), so a
	// docs edit rotates the region on no pass either — it surfaces through
	// the next fold's fresh docs read (the volatile segment carries no docs
	// class on Pi; see PARITY.md).
	// session_facts is retired as a render source (facts = promoted memories),
	// so its version is pinned to 0 and never triggers either.
	return { value: false, reason: null };
}

function renderUserProfileBlock(
	db: ContextDatabase,
	wrapper = "user-profile",
	memoriesOverride?: UserMemory[],
): string {
	const memories = memoriesOverride ?? safeGetActiveUserMemoriesPi(db);
	if (memories.length === 0) return "";
	// The delta variant carries the same full description: one template, no
	// second set of bytes to freeze (bytes must match OpenCode renderUserProfileBlock).
	return `<${wrapper}>\n${USER_PROFILE_DESCRIPTION}\n${memories
		.map(
			(memory) =>
				`- ${escapeXmlContent(renderUserProfileContent(memory.content))}`,
		)
		.join("\n")}\n</${wrapper}>`;
}

export function renderM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	projectDocs = readProjectDocsForPiM0(state).renderedBlock,
	decayPressureMultiplier = 1,
	// Atomic-snapshot override: when materializeM0Pi reads markers + memories in
	// one transaction, it passes the SAME memory set here so the rendered m[0]
	// can't include a memory whose id is above the persisted maxMemoryId watermark
	// (which would duplicate it across the m[0]/m[1] split). Mirrors OpenCode,
	// where renderM0 takes memories as a parameter rather than re-reading.
	memoriesOverride?: Memory[],
	compartmentsOverride?: PiCompartment[],
	userProfileOverride?: UserMemory[],
	workspaceOverride?: WorkspaceRenderContext,
	/** Optional mural wire options (HARD fold only). When vision-capable, emits
	 *  the `<memory-mural>` marker block; the PNG rides as a separate image part. */
	mural?: { enabled: boolean; supportsVision: boolean; dataUrl?: string },
): string {
	const memPath = memoryProjectPath(state);
	const workspace =
		workspaceOverride ?? resolveWorkspaceRenderContextPi(state, db);
	const allMemories =
		memoriesOverride ??
		(memPath
			? workspace.isWorkspaced
				? getMemoriesByProjects(
						db,
						workspace.expandedIdentities,
						["active", "permanent"],
						Date.now(),
						workspace.ownIdentities,
						workspace.shareCategories,
					)
				: getMemoriesByProject(db, memPath, ["active", "permanent"])
			: []);
	// Use the V2 trim + render helpers (shared with OpenCode) so both harnesses
	// emit the same category-grouped `#id: fact` bytes and use the same
	// permanent-first / importance-DESC selection. A divergent shape here would
	// put different bytes on the wire between OpenCode and Pi.
	// Always trim with the default memory-budget fallback (matching OpenCode),
	// not gated on a truthy injectionBudgetTokens — an unset budget must NOT mean
	// "render every memory untrimmed", which would grow m[0] without bound.
	const memoryRenderOptions: MemoryRenderOptions = {
		sourceNameByMemoryId: sourceNamesForPiMemories({
			memories: allMemories,
			projectPath: memPath,
			workspace,
		}),
	};
	const memories =
		allMemories.length > 0
			? workspace.isWorkspaced
				? trimWorkspaceMemoriesToBudgetV2(
						state.sessionId,
						allMemories,
						state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
						workspace,
						memoryRenderOptions,
					).renderOrder
				: trimMemoriesToBudgetV2(
						state.sessionId,
						allMemories,
						state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
					).renderOrder
			: allMemories;
	const memoryBlock =
		memories.length > 0
			? renderMemoryBlockV2(memories, "project-memory", memoryRenderOptions)
			: undefined;
	// v2: decay-render compartments via the shared module (same validated curve
	// as OpenCode). Facts are NOT rendered (v2 faithful: facts = promoted
	// memories, surfaced via memoryBlock / <project-memory>).
	// The decay-pressure multiplier maps to a proportionally tighter effective
	// budget (lower budget → higher curve pressure → more demotion), keeping the
	// shared decay-curve as the single source of pressure math — same approach as
	// OpenCode renderM0. The materialize loop escalates it when m[0] is over budget.
	const baseHistoryBudget = historyLocalBudget(
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
		piModelRefToCanonical(state.hardSignals?.modelKey ?? ""),
	);
	const decayed = renderDecayedCompartments({
		compartments:
			compartmentsOverride ?? getRenderableCompartmentsPi(db, state),
		// v2: use the HISTORY budget (~60K), not the memory injection budget (~4K).
		// Falling back to the memory budget would over-demote every compartment.
		historyBudgetTokens:
			baseHistoryBudget / Math.max(1, decayPressureMultiplier),
	});
	// Sibling-block layout MUST match OpenCode renderM0 exactly (otherwise the
	// two harnesses put different bytes on the wire for the same state):
	//   <project-docs>   — sibling
	//   <user-profile>   — sibling
	//   <session-history>…decayed COMPARTMENTS ONLY…</session-history>
	//   <project-memory> — sibling
	// The <session-history> wrapper contains ONLY the decayed compartments — it
	// does NOT envelope project-docs / user-profile / project-memory. Sections
	// joined by "\n\n".
	const sections: string[] = [];
	if (projectDocs.length > 0) sections.push(projectDocs);
	// Baseline user-profile MUST be trimmed to budget, matching OpenCode renderM0.
	// Rendering all active user memories untrimmed would put different (larger)
	// bytes on the wire than OpenCode for the same state, and let m[0] grow
	// without bound as the global user-profile accumulates.
	const trimmedProfile = trimUserMemoriesToBudget(
		state.memoryEnabled === false
			? []
			: (userProfileOverride ?? safeGetActiveUserMemoriesPi(db)),
		state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS,
	);
	const userProfile = renderUserProfileBlock(
		db,
		"user-profile",
		trimmedProfile,
	);
	if (userProfile.length > 0) sections.push(userProfile);
	if (!state.compactionOff) {
		sections.push(
			decayed.length > 0
				? `<session-history>\n${decayed}\n</session-history>`
				: "<session-history></session-history>",
		);
	}
	if (memoryBlock) sections.push(memoryBlock);
	// Sibling layout parity with OpenCode renderM0: mural marker after memories.
	if (mural?.enabled && mural.supportsVision && mural.dataUrl) {
		sections.push(MEMORY_MURAL_BLOCK);
	}
	return sections.join("\n\n").trim();
}

function renderedMemoryIdsForPi(
	state: PiM0M1State,
	memories: readonly Memory[],
	workspace?: WorkspaceRenderContext,
	db?: ContextDatabase,
): number[] {
	if (memories.length === 0) return [];
	const resolvedWorkspace =
		workspace ?? (db ? resolveWorkspaceRenderContextPi(state, db) : undefined);
	const renderOptions: MemoryRenderOptions = resolvedWorkspace
		? {
				sourceNameByMemoryId: sourceNamesForPiMemories({
					memories,
					projectPath: memoryProjectPath(state),
					workspace: resolvedWorkspace,
				}),
			}
		: {};
	const trimmed = resolvedWorkspace?.isWorkspaced
		? trimWorkspaceMemoriesToBudgetV2(
				state.sessionId,
				[...memories],
				state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
				resolvedWorkspace,
				renderOptions,
			)
		: trimMemoriesToBudgetV2(
				state.sessionId,
				[...memories],
				state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
			);
	return trimmed.renderOrder.map((memory) => memory.id);
}

/** Raised when the m[0] snapshot changed between the read-markers phase and the
 *  persist phase (a concurrent writer — sibling Pi/OpenCode process sharing the
 *  same SQLite DB, or the historian — mutated state mid-materialization). Caught
 *  by the retry wrapper so we never cache m[0] bytes that no longer match the
 *  markers they were rendered from. */
function isTransientSqliteLockError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const { code, message } = error as { code?: unknown; message?: unknown };
	if (typeof code === "string") {
		if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return true;
	}
	if (typeof message === "string") {
		return (
			/database is locked/i.test(message) ||
			/sqlite_(busy|locked)/i.test(message)
		);
	}
	return false;
}

export class PiMaterializeContentionError extends Error {
	constructor(reason: string) {
		super(`pi m[0] materialization contention: ${reason}`);
		this.name = "PiMaterializeContentionError";
	}
}

function readFrozenM0InputsPi(
	state: PiM0M1State,
	db: ContextDatabase,
	docs = readProjectDocsForPiM0(state),
	memoryCutoff?: number,
	compartmentsOverride?: readonly PiCompartment[],
): FrozenM0Inputs {
	// Read every render source and its corresponding watermark as one short DB
	// transaction. Rendering happens later, but m[0] bytes and m[1] watermarks now
	// share the same frozen compartments/memories/user-profile set; a concurrent
	// writer cannot make m[0] include rows that m[1] still considers "new".
	const memPath = memoryProjectPath(state);
	const read = db.transaction(() => {
		const workspace = resolveWorkspaceRenderContextPi(state, db);
		const compartments = compartmentsOverride
			? [...compartmentsOverride]
			: getRenderableCompartmentsPi(db, state);
		const memories = memPath
			? workspace.isWorkspaced
				? getMemoriesByProjects(
						db,
						workspace.expandedIdentities,
						["active", "permanent"],
						memoryCutoff,
						workspace.ownIdentities,
						workspace.shareCategories,
					)
				: getMemoriesByProject(
						db,
						memPath,
						["active", "permanent"],
						memoryCutoff,
					)
			: [];
		const userProfile =
			state.memoryEnabled === false ? [] : safeGetActiveUserMemoriesPi(db);
		const projectState = memPath ? getProjectState(db, memPath) : undefined;
		const globalState = getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH);
		const markers: PiM0SnapshotMarkers = {
			maxCompartmentSeq: compartments.reduce(
				(max, compartment) =>
					compartment.sequence > max ? compartment.sequence : max,
				EMPTY_MAX_COMPARTMENT_SEQ,
			),
			maxMemoryId: memPath
				? workspace.isWorkspaced
					? getMaxMemoryIdForProjects(
							db,
							workspace.expandedIdentities,
							workspace.ownIdentities,
							workspace.shareCategories,
						)
					: getMaxMemoryIdForProjects(db, [memPath])
				: 0,
			maxMutationId: getMaxM0MutationId(db, state.sessionId) ?? 0,
			maxMemoryMutationId: memPath
				? workspace.isWorkspaced
					? (getMaxMemoryMutationIdForProjects(
							db,
							workspace.expandedIdentities,
						) ?? 0)
					: (getMaxMemoryMutationId(db, memPath) ?? 0)
				: 0,
			projectMemoryEpoch: projectState?.projectMemoryEpoch ?? 0,
			workspaceFingerprint: workspace.isWorkspaced
				? computeWorkspaceEpochFingerprint(db, workspace.identities)
				: null,
			projectUserProfileVersion: globalState?.projectUserProfileVersion ?? 0,
			projectDocsHash: docs.canonicalHash,
			sessionFactsVersion: getSessionFactsVersion(db, state.sessionId),
			materializedAt: memoryCutoff ?? Date.now(),
			upgradeState: `${PI_M0_UPGRADE_STATE}:${
				compartments.some((c) => c.legacy === 1) ? "legacy" : "ready"
			}`,
			compartmentRenderEpoch: COMPARTMENT_RENDER_EPOCH,
			memoryRenderEpoch: MEMORY_RENDER_FORMAT_EPOCH,
			profileRenderEpoch: PROFILE_RENDER_EPOCH,
			lastBaselineEndMessageId: lastBaselineEndMessageId(compartments),
			systemHash: (state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).systemHash,
			modelKey: piModelRefToCanonical(
				(state.hardSignals ?? EMPTY_PI_HARD_SIGNALS).modelKey,
			),
			projectIdentity: state.projectIdentity,
			muralEnabled:
				state.memoryEnabled !== false && state.muralEnabled === true,
			renderBudgetIdentity: renderBudgetIdentityPi(state),
			renderedBudgets: renderedBudgetSnapshot(
				state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS,
				state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
			),
		};
		return { docs, markers, compartments, memories, userProfile, workspace };
	});
	return read.deferred();
}

export function materializeM0Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	passSnapshot?: PiM0M1PassSnapshot,
	regionOptions?: { enabled: boolean; reason: string },
): {
	m0: string;
	m1: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedMemoryIds: number[];
} {
	// Phase 1 (no lock): read markers + render. Rendering can be slow, so we do
	// it OUTSIDE the write lock to keep the BEGIN IMMEDIATE critical section tiny.
	const docs = passSnapshot?.projectDocs ?? readProjectDocsForPiM0(state);
	if (passSnapshot && passSnapshot.projectDocs === undefined) {
		passSnapshot.projectDocs = docs;
	}
	const foldMaterializedAt = Date.now();
	const frozen = readFrozenM0InputsPi(
		state,
		db,
		docs,
		foldMaterializedAt,
		passSnapshot?.compartments,
	);
	const snapshotMarkers = frozen.markers;

	const snapshotMemories = frozen.memories;
	const snapshotCompartments = frozen.compartments;
	const snapshotUserProfile = frozen.userProfile;
	const renderedMemoryIds = renderedMemoryIdsForPi(
		state,
		snapshotMemories,
		frozen.workspace,
		db,
	);
	// On-demand mural: runs INSIDE the HARD fold only (not on defers). Explicit
	// test-supplied `state.mural` wins; otherwise resolve from muralEnabled +
	// this fold's model key.
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	const mural = resolveMuralForM0Pi(
		state,
		db,
		snapshotMarkers.modelKey,
		memoryBudget,
	);
	const frozenMuralDataUrl =
		mural?.enabled && mural.supportsVision ? (mural.dataUrl ?? null) : null;
	const frozenMuralHash =
		mural?.enabled && mural.supportsVision ? (mural.contentHash ?? null) : null;
	// Over-budget tightening loop (matches OpenCode materializeM0): if the
	// rendered m[0] exceeds the history budget, escalate the decay pressure and
	// re-render up to 3x so tight budgets demote more aggressively. Without this,
	// Pi would select different (looser) tiers than OpenCode under budget pressure.
	let decayPressureMultiplier = 1;
	let m0 = renderM0Pi(
		state,
		db,
		docs.renderedBlock,
		decayPressureMultiplier,
		snapshotMemories,
		snapshotCompartments,
		snapshotUserProfile,
		frozen.workspace,
		mural,
	);
	const historyBudget = historyLocalBudget(
		state.historyBudgetTokens ?? DEFAULT_HISTORY_BUDGET_TOKENS,
		piModelRefToCanonical(state.hardSignals?.modelKey ?? ""),
	);
	let attempts = 0;
	while (
		historyBudget > 0 &&
		historySliceTokensPi(m0) > historyBudget * 1.05 &&
		attempts < 3
	) {
		decayPressureMultiplier *= 1.15;
		m0 = renderM0Pi(
			state,
			db,
			docs.renderedBlock,
			decayPressureMultiplier,
			snapshotMemories,
			snapshotCompartments,
			snapshotUserProfile,
			frozen.workspace,
			mural,
		);
		attempts += 1;
	}
	const m0Bytes = Buffer.from(m0, "utf8");
	// What the fold carried as its delta half: the volatile segment text on the
	// region lane (m[1] is vacated there), the persisted m[1] bytes on the head
	// shape (dead at runtime — every production fold is a region fold).
	let foldDelta = "";

	// Phase 2 + 3 (locked): re-read markers under BEGIN IMMEDIATE; if anything
	// changed since Phase 1, the rendered bytes are stale — roll back and let the
	// caller retry. m[1] is rendered and persisted INSIDE the same transaction as
	// m[0] so cached_m0_bytes/cached_m1_bytes/markers/memory_block_ids stay paired.
	try {
		db.exec("BEGIN IMMEDIATE");
	} catch (error) {
		if (isTransientSqliteLockError(error)) {
			throw new PiMaterializeContentionError("begin immediate locked");
		}
		throw error;
	}
	const transactionStartedAt = performance.now();
	try {
		// The lock-time marker check must describe the bytes rendered above. Reusing
		// that HARD-fold document snapshot avoids a second stat/read pair and prevents
		// pairing the first render with a later on-disk hash.
		const current = readCurrentMarkers(db, state, docs.canonicalHash);
		// maxMemoryId deliberately EXCLUDED (parity with OpenCode materializeM0):
		// additive memory writes don't bump projectMemoryEpoch and must NOT bust
		// m[0] — they surface in m[1] via the persisted maxMemoryId watermark. The
		// memory-mutation cursor IS included because a materialization pass must
		// reconcile every non-additive memory change up to its persisted cursor.
		const memoryEpochStale =
			current.workspaceFingerprint !== null ||
			snapshotMarkers.workspaceFingerprint !== null
				? current.workspaceFingerprint !== snapshotMarkers.workspaceFingerprint
				: current.projectMemoryEpoch !== snapshotMarkers.projectMemoryEpoch;
		const stale =
			memoryEpochStale ||
			current.projectUserProfileVersion !==
				snapshotMarkers.projectUserProfileVersion ||
			current.maxCompartmentSeq !== snapshotMarkers.maxCompartmentSeq ||
			current.maxMutationId !== snapshotMarkers.maxMutationId ||
			current.maxMemoryMutationId !== snapshotMarkers.maxMemoryMutationId ||
			current.projectIdentity !== snapshotMarkers.projectIdentity ||
			// Inert today (both harnesses pin sessionFactsVersion to 0 — facts are
			// retired in v2), but kept for structural parity with OpenCode
			// materializeM0 so the two stale checks can't silently drift if either
			// harness ever revives the field.
			current.sessionFactsVersion !== snapshotMarkers.sessionFactsVersion ||
			current.upgradeState !== snapshotMarkers.upgradeState;
		if (stale) {
			db.exec("ROLLBACK");
			throw new PiMaterializeContentionError("snapshot changed before persist");
		}
		snapshotMarkers.materializedAt = foldMaterializedAt;

		const foldPayload = {
			muralDataUrl: frozenMuralDataUrl,
			muralHash: frozenMuralHash,
			projectMemoryEpoch: snapshotMarkers.projectMemoryEpoch,
			workspaceFingerprint: snapshotMarkers.workspaceFingerprint,
			projectUserProfileVersion: snapshotMarkers.projectUserProfileVersion,
			maxCompartmentSeq: snapshotMarkers.maxCompartmentSeq,
			maxMemoryId: snapshotMarkers.maxMemoryId,
			maxMutationId: snapshotMarkers.maxMutationId,
			maxMemoryMutationId: snapshotMarkers.maxMemoryMutationId,
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
			modelKey: snapshotMarkers.modelKey,
			projectIdentity: snapshotMarkers.projectIdentity,
		};
		if (regionOptions?.enabled) {
			// Frozen system-region fold (§23 D4): the assembled m[0] installs
			// as the system channel through the rotation funnel — the second
			// named production caller, after the OpenCode-1 materialize. The
			// persist callback runs inside this same BEGIN IMMEDIATE: region
			// bytes, marker capture, and the trim boundary land atomically,
			// which is what makes the boundary a legitimate trim operand on a
			// region row (D6). A refusal throws — the fold never persists head
			// bytes beside a region that did not land.
			//
			// Unit 7 (plugin Unit 2 mirror): the region is the baseline panels
			// ONLY. The delta half is carried by the volatile segment beside
			// the region — rendered against this fold's own marker capture in
			// the same transaction, so the region row, its markers, and the
			// segment never diverge. persistCachedM0 absorbs any stale segment
			// (the receipted fold-row update nulls it); the fresh row below
			// names this region's materialized_at, so the serve pairing
			// (watermark == cached_m0_materialized_at) holds from the commit
			// onward. Empty text clears the row (the absorbed state).
			const volatileRender = renderM1PiVolatileSegment(
				state,
				db,
				snapshotMarkers,
				renderedMemoryIds,
			);
			// The accounting is re-derived from the two renders: panel ids ∪
			// volatile ids (ctx_search's hide-already-visible filter reads
			// session_meta.memory_block_ids).
			const visibleMemoryIds = [
				...new Set([...renderedMemoryIds, ...volatileRender.memoryIds]),
			];
			const rotated = executeSystemRegionRotation(
				db,
				state.sessionId,
				regionOptions.reason,
				m0,
				regionMarkersFromPiSnapshot(snapshotMarkers),
				(regionBlob) => {
					persistCachedM0(db, state.sessionId, {
						...foldPayload,
						m0Bytes: regionBlob,
						m1Bytes: null,
					});
					db.prepare(
						"UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
					).run(
						visibleMemoryIds.length,
						JSON.stringify(visibleMemoryIds),
						state.sessionId,
					);
				},
			);
			if (!rotated) {
				try {
					db.exec("ROLLBACK");
				} catch {
					// already rolled back
				}
				throw new PiMaterializeContentionError(
					`system-region rotation refused for ${state.sessionId}`,
				);
			}
			// The fold's fresh volatile row, after the fold-row clear ran inside
			// the persist callback — still inside this BEGIN IMMEDIATE, before
			// COMMIT.
			writeRegionVolatile(
				db,
				state.sessionId,
				volatileRender.text,
				snapshotMarkers.materializedAt,
			);
			foldDelta = volatileRender.text;
		} else {
			const m1Render = renderM1PiWithMetadata(
				state,
				db,
				snapshotMarkers,
				renderedMemoryIds,
			);
			persistCachedM0(db, state.sessionId, {
				...foldPayload,
				m0Bytes,
				m1Bytes: Buffer.from(m1Render.text, "utf8"),
			});
			// Persist the rendered-memory identity in the SAME transaction as
			// the m[0] snapshot (parity with OpenCode materializeM0).
			// `memory_block_ids` / `memory_block_count` are otherwise written
			// only by the dead legacy v1 path, so they'd stay frozen at the
			// last legacy value — wrong sidebar "Injected" count AND a stale
			// ctx_search hide-already-visible filter after any memory change
			// (e.g. migration delete+reinserts with new ids).
			db.prepare(
				"UPDATE session_meta SET memory_block_count = ?, memory_block_ids = ? WHERE session_id = ?",
			).run(
				renderedMemoryIds.length,
				JSON.stringify(renderedMemoryIds),
				state.sessionId,
			);
			foldDelta = m1Render.text;
		}

		// Persist the frozen trim boundary INSIDE the materialize transaction,
		// BEFORE COMMIT. If written after COMMIT, a crash in the window leaves a
		// fresh m[0]/maxCompartmentSeq paired with a stale (or null) boundary, so
		// the next pass trims against the wrong point (under/over-trim). Atomic
		// with the m[0] bytes + markers + m[1] bytes is the only correct placement.
		setCachedBoundary(
			db,
			state.sessionId,
			snapshotMarkers.lastBaselineEndMessageId,
		);

		db.exec("COMMIT");
		logSlowWriteTransaction("pi_materialize_cache", transactionStartedAt);
		return {
			m0,
			m1: foldDelta,
			snapshotMarkers,
			renderedMemoryIds,
		};
	} catch (error) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// already rolled back
		}
		throw error;
	}
}

/** Retry materializeM0Pi on contention (parity with OpenCode materializeWithRetry). */
export function materializeM0PiWithRetry(
	state: PiM0M1State,
	db: ContextDatabase,
	maxRetries = 3,
	passSnapshot?: PiM0M1PassSnapshot,
	regionOptions?: { enabled: boolean; reason: string },
): {
	m0: string;
	m1: string;
	snapshotMarkers: PiM0SnapshotMarkers;
	renderedMemoryIds: number[];
} {
	let lastError: PiMaterializeContentionError | null = null;
	let currentSnapshot = passSnapshot;
	for (let attempt = 0; attempt < maxRetries; attempt++) {
		try {
			return materializeM0Pi(state, db, currentSnapshot, regionOptions);
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			lastError = error;
			// The lock-time marker CAS is the publish-sequence invalidation signal.
			// Refresh only after it proves the pass snapshot stale; keep the same docs
			// bytes because the CAS compared their canonical hash under the lock.
			currentSnapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: state.compactionOff === true,
				projectDocs: currentSnapshot?.projectDocs,
			});
		}
	}
	throw (
		lastError ??
		new PiMaterializeContentionError("materialization contention exhausted")
	);
}

function renderMemoryUpdatesBlockPi(args: {
	db: ContextDatabase;
	projectPath: string;
	workspace: WorkspaceRenderContext;
	afterId: number;
	renderedMemoryIds: readonly number[];
	eligibleMemoryIds: ReadonlySet<number>;
}): { block: string; count: number; forcedMemoryIds: number[] } {
	const renderedIds = new Set(args.renderedMemoryIds);
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
	if (mutations.length === 0) {
		return { block: "", count: 0, forcedMemoryIds: [] };
	}

	const forcedIds = new Set<number>();
	const lines = [
		"These memories changed since the snapshot below — trust these:",
	];
	for (const mutation of mutations) {
		if (mutation.mutationType === "superseded") {
			const replacementId = mutation.supersededById;
			if (
				replacementId !== null &&
				!renderedIds.has(replacementId) &&
				args.eligibleMemoryIds.has(replacementId)
			) {
				forcedIds.add(replacementId);
			}
			if (!renderedIds.has(mutation.targetMemoryId)) continue;
			if (replacementId !== null && args.eligibleMemoryIds.has(replacementId)) {
				lines.push(
					`  <superseded id="${mutation.targetMemoryId}" by="${replacementId}"/>`,
				);
			} else {
				lines.push(`  <removed id="${mutation.targetMemoryId}"/>`);
			}
			continue;
		}

		if (!renderedIds.has(mutation.targetMemoryId)) {
			if (
				mutation.visibilityChanged &&
				args.eligibleMemoryIds.has(mutation.targetMemoryId)
			) {
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
				mutation.category && mutation.category !== "__mc_visibility__"
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

interface RenderM1PiResult {
	text: string;
	memoryUpdateCount: number;
	/** Memory ids this render places on the wire (delta class) — the
	 *  session_meta.memory_block_* accounting union (ctx_search hide-filter). */
	memoryIds: number[];
}

/**
 * The marker fields the m[1] delta render actually consumes. The volatile
 * carrier renders against the CACHED row's markers (never current data); the
 * Pick keeps the renderer structurally unable to widen its inputs.
 */
export type PiVolatileWatermark = Pick<
	PiM0SnapshotMarkers,
	| "maxCompartmentSeq"
	| "maxMemoryId"
	| "maxMemoryMutationId"
	| "projectUserProfileVersion"
	| "materializedAt"
>;

function renderM1PiCore(
	state: PiM0M1State,
	db: ContextDatabase,
	watermark: PiVolatileWatermark,
	renderedMemoryIds: readonly number[],
	compartmentsOverride: readonly PiCompartment[] | undefined,
	volatileMode: boolean,
): RenderM1PiResult {
	const sections: string[] = [];
	const workspace = resolveWorkspaceRenderContextPi(state, db);

	const memPath = memoryProjectPath(state);
	const eligibleMemories = memPath
		? workspace.isWorkspaced
			? getMemoriesByProjects(
					db,
					workspace.expandedIdentities,
					["active", "permanent"],
					watermark.materializedAt,
					workspace.ownIdentities,
					workspace.shareCategories,
				)
			: getMemoriesByProject(
					db,
					memPath,
					["active", "permanent"],
					watermark.materializedAt,
				)
		: [];
	const eligibleMemoryIds = new Set(
		eligibleMemories.map((memory) => memory.id),
	);
	const memoryUpdates = memPath
		? renderMemoryUpdatesBlockPi({
				db,
				projectPath: memPath,
				workspace,
				afterId: watermark.maxMemoryMutationId,
				renderedMemoryIds,
				eligibleMemoryIds,
			})
		: { block: undefined as string | undefined, count: 0, forcedMemoryIds: [] };
	if (memoryUpdates.block) sections.push(memoryUpdates.block);

	const newCompartments = (
		compartmentsOverride ?? getRenderableCompartmentsPi(db, state)
	).filter(
		(compartment) =>
			compartment.sequence > watermark.maxCompartmentSeq &&
			!isNoContentCompartment(compartment),
	);
	if (newCompartments.length > 0) {
		// New compartments are newest deltas → always render at P1 (full fidelity).
		const body = newCompartments
			.map((compartment) => renderCompartmentAtTier(compartment, 1))
			.join("\n\n");
		sections.push(`<new-compartments>\n${body}\n</new-compartments>`);
	}

	const forcedMemoryIds = new Set(memoryUpdates.forcedMemoryIds);
	const newMemories = eligibleMemories.filter(
		(memory) =>
			memory.id > watermark.maxMemoryId && !forcedMemoryIds.has(memory.id),
	);
	// Trim ordinary new memories to 25% of the budget, but always include eligible
	// memories referenced by a supersede operation. Such a replacement may have an
	// ID at or below the first marker's maximum while still not appearing in the
	// memories already rendered.
	const memoryBudget =
		state.injectionBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	const memoryRenderOptions: MemoryRenderOptions = {
		sourceNameByMemoryId: sourceNamesForPiMemories({
			memories: eligibleMemories,
			projectPath: memPath,
			workspace,
		}),
	};
	const trimmedNewMemories = trimMemoriesToBudgetV2(
		state.sessionId,
		newMemories,
		Math.max(1, Math.floor(memoryBudget * 0.25)),
		memoryRenderOptions,
	).renderOrder;
	const deltaMemories = [
		...trimmedNewMemories,
		...eligibleMemories.filter((memory) => forcedMemoryIds.has(memory.id)),
	];
	const newMemoriesBlock = renderMemoryBlockV2(
		deltaMemories,
		"new-memories",
		memoryRenderOptions,
	);
	if (newMemoriesBlock) sections.push(newMemoriesBlock);

	// new-user-profile delta: when the global user-profile version advanced since
	// this m[0] baseline was materialized, surface the current profile under a
	// <new-user-profile> wrapper so freshly promoted user memories reach the agent
	// in m[1] before the next m[0] materialization folds them into the baseline.
	// Trimmed to 25% of the user-profile budget (matches OpenCode renderM1).
	const currentUserProfileVersion =
		getProjectState(db, GLOBAL_USER_PROFILE_PROJECT_PATH)
			?.projectUserProfileVersion ?? 0;
	if (
		state.memoryEnabled !== false &&
		currentUserProfileVersion !== watermark.projectUserProfileVersion
	) {
		const profileBudget =
			state.userProfileBudgetTokens ?? DEFAULT_USER_PROFILE_BUDGET_TOKENS;
		const trimmedProfile = trimUserMemoriesToBudget(
			safeGetActiveUserMemoriesPi(db),
			Math.max(1, Math.floor(profileBudget * 0.25)),
		);
		const profileBlock = renderUserProfileBlock(
			db,
			"new-user-profile",
			trimmedProfile,
		);
		if (profileBlock) sections.push(profileBlock);
	}

	const memoryIds = [...new Set(deltaMemories.map((memory) => memory.id))];
	if (sections.length === 0) {
		return volatileMode
			? // The volatile has no placeholder duty (plugin parity): the empty
				// segment is the absorbed state, served as no tail at all.
				{ text: "", memoryUpdateCount: memoryUpdates.count, memoryIds }
			: {
					text: PI_M1_PLACEHOLDER,
					memoryUpdateCount: memoryUpdates.count,
					memoryIds,
				};
	}
	// Join with "\n" (single newline) to match OpenCode renderM1 exactly — the
	// m[1] delta bytes must be identical across harnesses.
	const joined = sections.join("\n");
	return {
		text: volatileMode
			? `<session-history-since>\n${joined}\n</session-history-since>`
			: state.compactionOff
				? `<knowledge-updates>\n${joined}\n</knowledge-updates>`
				: `<session-history-since>\n${joined}\n</session-history-since>`,
		memoryUpdateCount: memoryUpdates.count,
		memoryIds,
	};
}

function renderM1PiWithMetadata(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
	renderedMemoryIds: readonly number[],
	// The compartment set the CALLER will use to advance the persisted trim
	// boundary. When provided, the new-compartments filter renders from this
	// exact set instead of a fresh live read — so a compartment can never be
	// rendered into m[1] while the boundary advances from a different (older)
	// snapshot, which would leave its raw messages in the tail too (duplication).
	// Omitted by callers that don't advance the boundary (e.g. renderM1Pi probe).
	compartmentsOverride?: readonly PiCompartment[],
): RenderM1PiResult {
	return renderM1PiCore(
		state,
		db,
		markers,
		renderedMemoryIds,
		compartmentsOverride,
		false,
	);
}

/**
 * The volatile-segment producer (Unit 7, plugin Unit 2 mirror): the delta
 * classes beyond the CACHED watermark — memory-updates, new-compartments,
 * new-memories, new-user-profile. Callers pass the cached row's markers, never
 * current ones; empty renders "" (no placeholder duty).
 */
export function renderM1PiVolatileSegment(
	state: PiM0M1State,
	db: ContextDatabase,
	watermark: PiVolatileWatermark,
	renderedMemoryIds: readonly number[],
): RenderM1PiResult {
	return renderM1PiCore(
		state,
		db,
		watermark,
		renderedMemoryIds,
		undefined,
		true,
	);
}

export function renderM1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	markers: PiM0SnapshotMarkers,
	renderedMemoryIds: readonly number[] = [],
): string {
	return renderM1PiWithMetadata(state, db, markers, renderedMemoryIds).text;
}

export interface CachedPiM0M1Row {
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
	cached_m0_model_key: string | null;
	cached_m0_project_identity: string | null;
	cached_m0_last_baseline_end_message_id: string | null;
	memory_block_ids: string | null;
}

function readCachedPiM0M1RowRaw(
	db: ContextDatabase,
	sessionId: string,
): CachedPiM0M1Row | null {
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
					cached_m0_model_key,
					cached_m0_project_identity,
					cached_m0_last_baseline_end_message_id,
					memory_block_ids
			   FROM session_meta
			  WHERE session_id = ?`,
		)
		.get(sessionId) as CachedPiM0M1Row | null;
}

export interface PiM0M1PassSnapshot {
	sessionMeta: ReturnType<typeof getOrCreateSessionMeta>;
	compartments: PiCompartment[];
	projectDocs?: ReturnType<typeof readProjectDocsCanonical>;
	cachedRow: CachedPiM0M1Row | null;
	/** Highest publish sequence observed when this context pass began. */
	compartmentSequence: number;
	/**
	 * Fold-owned trim boundary co-resident with a servable frozen system
	 * region (§23 D6), captured with the rest of the pass state so trim never
	 * re-reads the row on a different snapshot than the decision.
	 */
	regionBoundary: string | null;
}

export function createPiM0M1PassSnapshot(args: {
	db: ContextDatabase;
	sessionId: string;
	compactionOff: boolean;
	sessionMeta?: ReturnType<typeof getOrCreateSessionMeta>;
	compartments?: readonly PiCompartment[];
	projectDocs?: ReturnType<typeof readProjectDocsCanonical>;
}): PiM0M1PassSnapshot {
	const compartments = args.compactionOff
		? []
		: args.compartments
			? [...args.compartments]
			: getCompartments(args.db, args.sessionId);
	const rawRow = readCachedPiM0M1RowRaw(args.db, args.sessionId);
	return {
		sessionMeta:
			args.sessionMeta ?? getOrCreateSessionMeta(args.db, args.sessionId),
		compartments,
		projectDocs: args.projectDocs,
		cachedRow:
			rawRow && isSystemRegionBytes(rawRow.cached_m0_bytes) ? null : rawRow,
		compartmentSequence:
			compartments.at(-1)?.sequence ?? EMPTY_MAX_COMPARTMENT_SEQ,
		regionBoundary: derivePiRegionBoundary(args.db, args.sessionId, rawRow),
	};
}

function resolveRenderedCompartmentBoundary(
	compartments: readonly PiCompartment[],
	boundaryId: string | null,
): PiRenderedCompartmentBoundary {
	if (!boundaryId) return { endMessageId: null, ordinal: null };
	const boundary = compartments.find(
		(compartment) => compartment.endMessageId === boundaryId,
	);
	if (boundary?.endBlockIndex != null)
		return { endMessageId: null, ordinal: null };
	return {
		endMessageId: boundaryId,
		ordinal:
			typeof boundary?.endMessage === "number" ? boundary.endMessage : null,
	};
}

/** The persisted mural is present and belongs to a region this process can
 *  serve: the legend ships inside the region bytes, so a vision-unsupported
 *  rotation (no mural rendered) leaves the columns empty and nothing rides.
 *  The row encodes the fold's mural switch inside the upgrade identity; a
 *  legacy row without the identity keeps the carriage (undefined !== false). */
function muralCarriageWantedPi(meta: {
	cachedM0MuralDataUrl: string | null;
	cachedM0UpgradeState: string | null;
}): boolean {
	if (!meta.cachedM0MuralDataUrl) return false;
	return (
		decodeCachedM0UpgradeIdentity(meta.cachedM0UpgradeState).muralEnabled !==
		false
	);
}

/**
 * The mural PNG carriage, region form (plugin Unit 1 ruling mirror; census
 * "Mural carriage group"; Unit 7 adjudication): the frozen region carries the
 * `<memory-mural>` legend inside its bytes, and the image rides beside it as
 * a synthetic user message. The part is a pure function of the persisted
 * mural columns — replay-identical per rotation, never re-derived from
 * mutated content. Pi codec COPY: the envelope is Pi's own; the plugin's
 * region-render mint is never imported (no-import law in the mural tests).
 * The timestamp sits 1ms before the first retained message (the head-era
 * image-part convention) so temporal-marker gaps are unchanged.
 */
function buildRegionMuralMessagePi(args: {
	muralDataUrl?: string | null;
	muralHash?: string | null;
	timestampHint?: number;
}): PiAgentMessage | null {
	const image = args.muralDataUrl
		? piImageFromDataUrl(args.muralDataUrl)
		: null;
	if (!image) return null;
	const baseTimestamp =
		typeof args.timestampHint === "number" ? args.timestampHint : 0;
	return {
		role: "user",
		content: [image],
		timestamp: baseTimestamp - 1,
	};
}

function injectM0M1PiRegion(
	state: PiM0M1State,
	db: ContextDatabase,
	piMessages: PiAgentMessage[],
	entryIds: readonly (string | undefined)[] | undefined,
	passSnapshot: PiM0M1PassSnapshot | undefined,
	forcedReason: string,
): PiM0M1InjectionResult {
	const snapshot =
		passSnapshot ??
		createPiM0M1PassSnapshot({
			db,
			sessionId: state.sessionId,
			compactionOff: state.compactionOff === true,
		});
	const currentCompartments = snapshot.compartments;
	const decision = forcedReason
		? { value: true as const, reason: forcedReason }
		: mustMaterializePi(state, db, currentCompartments, snapshot, {
				systemRegionMode: true,
			});
	if (decision.value) {
		logSession(
			state.sessionId,
			`pi system-region fold firing: reason=${decision.reason ?? "unknown"}`,
		);
	}
	let materialized = false;
	let contentionExhausted = false;
	if (decision.value) {
		try {
			materializeM0PiWithRetry(state, db, 3, snapshot, {
				enabled: true,
				reason: decision.reason ?? "first_render",
			});
			materialized = true;
		} catch (error) {
			if (!(error instanceof PiMaterializeContentionError)) throw error;
			// The stored region keeps serving unchanged this pass (the serve
			// path reads the row at before_agent_start; the fold retries next
			// pass). Never re-render from live state on the losing pass.
			contentionExhausted = true;
			logSession(
				state.sessionId,
				"pi system-region fold contention exhausted; serving stored bytes",
			);
		}
	}
	// Trim boundary: fold-owned (region bytes + boundary co-written in one
	// transaction). After a successful fold the row advanced — re-derive;
	// otherwise use the pass-captured value.
	const boundaryId = materialized
		? derivePiRegionBoundary(db, state.sessionId)
		: snapshot.regionBoundary;
	const skippedVisibleMessages = boundaryId
		? trimPiMessagesToBoundary(
				piMessages,
				entryIds,
				boundaryId,
				false,
				state.sessionId,
				isPartialCompartmentEnd(db, state.sessionId, boundaryId),
			)
		: 0;
	const insertionIndex = placePiInitialSystemAtHead(piMessages);
	const servedRegion = readSystemRegion(db, state.sessionId);
	// Mural carriage (plugin Unit 1 ruling mirror; Unit 7 adjudication): the
	// frozen region carries the <memory-mural> legend; the PNG rides beside
	// it as a synthetic image message, emitted only while a servable region
	// exists so the legend and the image always travel together. No
	// compaction-off carve-out: the legend ships inside the region bytes for
	// an off install too (owner ruling — compaction-off rides the region), so
	// the image must ride as well or the legend strands. The message is a
	// pure function of the persisted mural columns — replay-identical per
	// rotation, never re-derived from mutated content.
	let muralLeadingCount = 0;
	if (servedRegion !== null && muralCarriageWantedPi(snapshot.sessionMeta)) {
		const firstRetained = piMessages[insertionIndex];
		const muralMessage = buildRegionMuralMessagePi({
			muralDataUrl: snapshot.sessionMeta.cachedM0MuralDataUrl,
			muralHash: snapshot.sessionMeta.cachedM0MuralHash,
			timestampHint:
				typeof (firstRetained as { timestamp?: number } | undefined)
					?.timestamp === "number"
					? (firstRetained as { timestamp: number }).timestamp
					: undefined,
		});
		if (muralMessage) {
			piMessages.splice(insertionIndex, 0, muralMessage);
			muralLeadingCount = 1;
		}
	}
	const memPath = memoryProjectPath(state);
	const workspace = resolveWorkspaceRenderContextPi(state, db);
	const memoryCount = memPath
		? workspace.isWorkspaced
			? getMemoriesByProjects(
					db,
					workspace.expandedIdentities,
					["active", "permanent"],
					Date.now(),
					workspace.ownIdentities,
					workspace.shareCategories,
				).length
			: getMemoriesByProject(db, memPath, ["active", "permanent"]).length
		: 0;
	return {
		injected: true,
		compartmentCount: currentCompartments.length,
		factCount: 0,
		memoryCount,
		skippedVisibleMessages,
		m0Materialized: materialized,
		m0Reason: decision.value ? decision.reason : null,
		m0Bytes: servedRegion?.length ?? 0,
		m1Bytes: 0,
		contentionExhausted,
		renderedBoundary: resolveRenderedCompartmentBoundary(
			currentCompartments,
			boundaryId,
		),
		m1RenderedCoverage: null,
		// MC contributes at most one synthetic message (the mural carriage);
		// the rest is Pi's own leading system entries.
		syntheticLeadingCount: insertionIndex + muralLeadingCount,
	};
}

export function injectM0M1Pi(
	state: PiM0M1State,
	db: ContextDatabase,
	piMessages: PiAgentMessage[],
	entryIds?: readonly (string | undefined)[],
	passSnapshot?: PiM0M1PassSnapshot,
	options?: {
		/**
		 * Frozen system-region lane (§23 D8): the history/profile/memory panels
		 * live in the system channel, so this function splices NO synthetic
		 * heads onto the wire — it only folds (through the rotation funnel)
		 * and trims. Set solely from the boot-resolved capability flag.
		 */
		systemRegion?: { enabled: boolean; reason: string };
	},
): PiM0M1InjectionResult {
	// Unit 7 carry-forward A (owner's binary ruling): the head carriage is
	// deleted. The frozen-system-region lane is unconditional — every Pi row
	// the region lane produces routes here, so injection splices no synthetic
	// heads and the panels are served from the system channel. A caller that
	// does not pass the region option is a programmer error.
	if (options?.systemRegion?.enabled !== true) {
		throw new Error(
			"pi injection requires the frozen-system-region lane (head carriage deleted in Unit 7)",
		);
	}
	return injectM0M1PiRegion(
		state,
		db,
		piMessages,
		entryIds,
		passSnapshot,
		options.systemRegion.reason ?? "",
	);
}

export function clearM0M1PiCache(
	db: ContextDatabase,
	sessionId: string,
	reason: string,
): void {
	clearCachedM0M1(db, sessionId, reason);
	setCachedBoundary(db, sessionId, null);
	logSession(sessionId, `cleared cached m[0] (${reason})`);
}

export interface PiInjectionResult {
	injected: boolean;
	compartmentCount: number;
	factCount: number;
	memoryCount: number;
	skippedVisibleMessages: number;
	/** Exact system-hash operands when that comparison caused materialization. */
	systemHashPrev?: string | null;
	systemHashNew?: string | null;
	/** Exact canonical model-key operands when that comparison caused materialization. */
	m0ModelKeyPrev?: string | null;
	m0ModelKeyNew?: string | null;
}
