/**
 * Pi `context` event handler — the per-LLM-call transform pipeline.
 *
 * Pi fires `pi.on("context", ...)` immediately before each LLM
 * invocation, with the full `AgentMessage[]` that's about to be sent.
 * The handler can return `{ messages }` to replace the array.
 *
 * Step 4b.2 wires the smallest meaningful pipeline:
 *   1. Wrap the AgentMessage[] in a Transcript via `createPiTranscript`.
 *   2. Tag eligible parts with the shared `Tagger` and inject `§N§ `
 *      prefixes (unless `ctx_reduce_enabled: false`).
 *   3. Apply queued drops from `pending_ops` via the shared
 *      `applyPendingOperations` flow.
 *   4. Apply persistent dropped/truncated states from the `tags` table
 *      via `applyFlushedStatuses` so cross-session drops survive.
 *   5. Return the rebuilt messages so Pi sees the mutations.
 *
 * What's deliberately NOT in 4b.2:
 *
 * - Historian invocation. Compartment trigger logic and historian
 *   subprocess spawn live in 4b.3.
 * - Nudges (rolling, note-nudge, ctx_reduce reminders). 4b.4.
 * - Auto-search hint injection. 4b.4.
 * - Sentinel stripping for cache stability. Pi's transform model is
 *   single-pass-per-LLM-call, so OpenCode-style cache-bust avoidance
 *   doesn't apply. If a Pi provider exposes prompt cache later we'd
 *   add the relevant subset.
 * - Compaction marker injection. OpenCode-only — Pi doesn't have a
 *   compaction-event surface to inject into.
 *
 * Error handling: any thrown error is caught and logged, then the
 * original messages pass through unmodified. Pi's LLM call should
 * never fail because of a transform bug — same fail-open philosophy
 * as the OpenCode `messages-transform` wrapper.
 */

import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import {
	type ContextDatabase,
	getTagsBySession,
	getTopNBySize,
} from "@magic-context/core/features/magic-context/storage";
import { getOrCreateSessionMeta } from "@magic-context/core/features/magic-context/storage-meta";
import {
	createTagger,
	type Tagger,
} from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { checkCompartmentTrigger } from "@magic-context/core/hooks/magic-context/compartment-trigger";
import { getVisibleMemoryIds } from "@magic-context/core/hooks/magic-context/inject-compartments";
import {
	clearNoteNudgeState,
	getStickyNoteNudge,
	markNoteNudgeDelivered,
	peekNoteNudgeText,
} from "@magic-context/core/hooks/magic-context/note-nudger";
import { createNudger } from "@magic-context/core/hooks/magic-context/nudger";
import { setRawMessageProvider } from "@magic-context/core/hooks/magic-context/read-session-chunk";
import { log, sessionLog } from "@magic-context/core/shared/logger";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	clearAutoSearchForPiSession,
	runAutoSearchHintForPi,
} from "./auto-search-pi";
import { injectPiNudge } from "./nudge-injector";
import { runPiHistorian } from "./pi-historian-runner";
import { readPiSessionMessages } from "./read-session-pi";
import { createPiTranscript } from "./transcript-pi";

/**
 * Pi's full AgentMessage union (user | assistant | toolResult | custom).
 * Sourced from the live ContextEvent payload so the type stays in sync
 * with @mariozechner/pi-coding-agent without us re-declaring it.
 *
 * The nudge / note-nudge / auto-search helpers below operate on this
 * union but only inspect/mutate user and (rarely) assistant messages —
 * `toolResult` and `custom` flow through unchanged. Each helper guards
 * its mutations with role checks so the wider union is safe.
 */
type PiAgentMessage = ContextEvent["messages"][number];

/**
 * Optional historian config. When provided, the context handler checks
 * the compartment trigger after tagging and fires `runPiHistorian`
 * asynchronously (fire-and-forget) when the trigger says shouldFire.
 * When omitted, no historian invocation happens — useful for testing
 * the transform pipeline in isolation or running Pi without a
 * configured historian model.
 */
export interface PiHistorianOptions {
	/** SubagentRunner instance (PiSubagentRunner). */
	runner: SubagentRunner;
	/** Historian provider/model id (e.g. `anthropic/claude-haiku-4-5`). */
	model: string;
	/** Optional ordered fallback chain. */
	fallbackModels?: readonly string[];
	/** Historian context window — used to derive chunk token budget. */
	historianChunkTokens: number;
	/** Optional per-call timeout (default 120s). */
	timeoutMs?: number;
	/** Cross-session memory feature gate (`memory.enabled`). */
	memoryEnabled?: boolean;
	/** Automatic-promotion gate (`memory.auto_promote`). */
	autoPromote?: boolean;
	/**
	 * Execute-threshold percentage used by the trigger logic to compute
	 * pressure-driven trigger points. Mirrors OpenCode's
	 * `execute_threshold_percentage` config; defaults to 65 when omitted.
	 */
	executeThresholdPercentage?: number;
	/**
	 * Trigger budget (tokens) used by the commit-cluster and tail-size
	 * triggers. Mirrors `compartment_token_budget` derived value in
	 * OpenCode; defaults to 8000 when omitted.
	 */
	triggerBudget?: number;
}

/**
 * Optional rolling/iteration nudge config (Step 4b.4). When omitted,
 * Pi runs without any rolling reminder text appended to the LLM input —
 * existing tagging + drop behavior is unchanged. When provided, the
 * shared `createNudger` is used to evaluate band-based reminders after
 * each tagging pass and injects them as a synthetic assistant message
 * via `injectPiNudge`.
 */
export interface PiNudgeOptions {
	/** Number of most-recent tags treated as protected (mirrors OpenCode `protected_tags`). */
	protectedTags: number;
	/** Base interval between rolling reminders, in tokens (mirrors OpenCode `nudge_interval_tokens`). */
	nudgeIntervalTokens: number;
	/** Tool-iteration threshold — N+ tool calls without user input fires the iteration nudge. */
	iterationNudgeThreshold: number;
	/** Same execute threshold the historian trigger uses (default 65). */
	executeThresholdPercentage: number;
}

/**
 * Optional auto-search hint config (Step 4b.4). When enabled, runs
 * `unifiedSearch` against new user prompts and appends a compact
 * vague-recall hint to the user message. Cross-harness coherent: hints
 * are computed against the same shared cortexkit DB OpenCode uses.
 */
export interface PiAutoSearchHandlerOptions {
	enabled: boolean;
	scoreThreshold: number;
	minPromptChars: number;
	memoryEnabled: boolean;
	embeddingEnabled: boolean;
	gitCommitsEnabled: boolean;
}

export interface PiContextHandlerOptions {
	db: ContextDatabase;
	/**
	 * Whether the agent-facing `ctx_reduce` tool is exposed. When false,
	 * tag prefixes are still assigned in the DB (so drops still work
	 * via /ctx-flush or future automatic triggers) but the visible
	 * `§N§ ` markers are NOT injected — agents shouldn't see markers
	 * they can't act on. Mirrors OpenCode behavior.
	 *
	 * Step 4b.2 hardcodes this to `true` since Pi's `ctx_reduce` tool
	 * is registered. Step 5b's config loader will make it configurable.
	 */
	ctxReduceEnabled: boolean;
	/**
	 * Number of most-recent tags treated as protected (mirrors OpenCode
	 * `protected_tags`). Drops with tag IDs in the protected window are
	 * deferred — `applyPendingOperations` requeues them as deferred so
	 * they re-evaluate next pass instead of being lost. Critical for
	 * keeping the agent's recent working context intact.
	 *
	 * Defaults from the schema to 20; can be 1-100. Optional so existing
	 * test fixtures don't need updating; callers in production (`index.ts`)
	 * always thread the loaded config value. A previous bug used a
	 * hardcoded `0` here — the council audit caught that recent turns
	 * were getting dropped mid-task.
	 */
	protectedTags?: number;
	/**
	 * Optional historian wiring (Step 4b.3b). When omitted, the trigger
	 * check is skipped — context events still tag + drop normally, and
	 * historian state stays untouched. When provided, the trigger fires
	 * async after each tagging pass.
	 */
	historian?: PiHistorianOptions;
	/**
	 * Optional rolling/iteration nudge wiring (Step 4b.4). When omitted,
	 * no nudges are injected. When provided, evaluated AFTER each tagging
	 * pass and injected via `injectPiNudge`.
	 */
	nudge?: PiNudgeOptions;
	/**
	 * Optional auto-search hint wiring (Step 4b.4). When omitted or
	 * disabled, no hint computation runs. Notes that auto-search shares
	 * the cortexkit DB with OpenCode, so memories ARE cross-harness.
	 */
	autoSearch?: PiAutoSearchHandlerOptions;
}

/**
 * Resolve the active Pi session id for the given context. Pi's
 * ReadonlySessionManager exposes `getSessionId()` (the UUID written
 * into the session file's `SessionHeader`); that's stable across the
 * session's lifetime even when branches are navigated, and matches
 * what Pi itself uses internally to address the session. We prefer
 * the UUID over the file path because:
 *
 *   - It's invariant under file moves (forks create new files but
 *     keep the original session id semantics intact).
 *   - It's the same id Pi uses in its `session_switch` event, so
 *     downstream code can correlate events to magic-context state
 *     without re-deriving from paths.
 *
 * Returns undefined when no session is active — context events should
 * never fire in that state, but defending against it keeps the
 * transform fail-open if Pi's lifecycle changes in future versions.
 */
function resolveSessionId(ctx: ExtensionContext): string | undefined {
	const sm = ctx.sessionManager;
	if (sm === undefined) return undefined;
	const getSessionId = (sm as { getSessionId?: () => string | undefined })
		.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const id = getSessionId.call(sm);
		if (typeof id !== "string" || id.length === 0) return undefined;
		return id;
	} catch {
		return undefined;
	}
}

/**
 * Register the Pi `context` event handler.
 *
 * The Tagger is created once per session boot — same lifecycle as the
 * OpenCode plugin's tagger. It maintains in-memory state (the
 * monotonic counter, assignment map) across `context` events so tag
 * numbers stay stable for the duration of the Pi session.
 */
export function registerPiContextHandler(
	pi: ExtensionAPI,
	options: PiContextHandlerOptions,
): void {
	const tagger = createTagger();
	const projectIdentity = resolveProjectIdentity(process.cwd());

	// Map: sessionId -> last ctx_reduce timestamp (used by the shared nudger
	// to suppress reminders right after the agent reduces). Pi never persists
	// this — restart resets cooldown, which is the OpenCode behavior too.
	const recentReduceBySession = new Map<string, number>();

	// Build the rolling/iteration nudger lazily — it's stateless across
	// invocations apart from the `recentReduceBySession` map and the per-
	// session meta it reads from the DB. Skipped when no `options.nudge` is
	// configured (returns null below at the call site).
	const nudgerFn = options.nudge
		? createNudger({
				protected_tags: options.nudge.protectedTags,
				nudge_interval_tokens: options.nudge.nudgeIntervalTokens,
				iteration_nudge_threshold: options.nudge.iterationNudgeThreshold,
				execute_threshold_percentage: options.nudge.executeThresholdPercentage,
				recentReduceBySession,
			})
		: null;

	pi.on("context", async (event, ctx) => {
		try {
			const sessionId = resolveSessionId(ctx);
			if (sessionId === undefined) {
				// No active session — fall through with no mutation.
				log(
					"[magic-context][pi] context event fired with no session id (falling through unmodified)",
				);
				return;
			}

			// Lazy-initialize tagger state from DB. Idempotent: re-init
			// during the same session is a no-op because the in-memory
			// counter is already populated. Required because the tag
			// counter persists across plugin restarts via the
			// `session_meta.counter` column.
			tagger.initFromDb(sessionId, options.db);

			const result = await runPipeline({
				db: options.db,
				tagger,
				sessionId,
				projectIdentity,
				messages: event.messages,
				ctxReduceEnabled: options.ctxReduceEnabled,
				// Default to 20 (matches schema default) when caller doesn't
				// thread an explicit value — tests rely on this fallback.
				protectedTags: options.protectedTags ?? 20,
			});

			// After tagging+drops have committed, check whether historian
			// should fire. Historian config is optional — tagging-only
			// behavior is the Step 4b.2 contract, and historian is
			// fire-and-forget so we never block the LLM call on it.
			if (options.historian) {
				maybeFireHistorian({
					ctx,
					sessionId,
					db: options.db,
					historian: options.historian,
				});
			}

			// Step 4b.4: nudge + note-nudge + auto-search hint. All three
			// run AFTER tagging/drops finish so they see the post-mutation
			// message shape. Each is independently optional and fail-open —
			// any thrown error is logged and the pipeline returns the
			// already-mutated messages unchanged.
			let outputMessages = result.messages as PiAgentMessage[];

			if (nudgerFn && options.nudge) {
				try {
					outputMessages = applyRollingNudge({
						sessionId,
						db: options.db,
						messages: outputMessages,
						ctx,
						nudgerFn,
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`pi rolling nudge failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			try {
				outputMessages = applyNoteNudges({
					sessionId,
					db: options.db,
					messages: outputMessages,
					projectIdentity,
				});
			} catch (err) {
				sessionLog(
					sessionId,
					`pi note nudges failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}

			if (options.autoSearch?.enabled) {
				try {
					outputMessages = await runAutoSearchHintForPi({
						sessionId,
						db: options.db,
						messages: outputMessages,
						options: {
							enabled: true,
							scoreThreshold: options.autoSearch.scoreThreshold,
							minPromptChars: options.autoSearch.minPromptChars,
							projectPath: projectIdentity,
							memoryEnabled: options.autoSearch.memoryEnabled,
							embeddingEnabled: options.autoSearch.embeddingEnabled,
							gitCommitsEnabled: options.autoSearch.gitCommitsEnabled,
							visibleMemoryIds:
								getVisibleMemoryIds(options.db, sessionId) ?? null,
						},
					});
				} catch (err) {
					sessionLog(
						sessionId,
						`pi auto-search failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}

			// Cast the rebuilt array back to the AgentMessage[] shape Pi's
			// ContextEventResult expects. The nudge/note/auto-search paths
			// preserve message identity for unchanged messages and only
			// rebuild the mutated ones, so this cast is safe at runtime.
			return { messages: outputMessages } as {
				messages: typeof event.messages;
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			log(
				`[magic-context][pi] context handler failed (continuing without mutation): ${message}`,
				stack,
			);
			// Fall through with no mutation — Pi proceeds with original
			// messages, equivalent to a no-op transform pass.
			return;
		}
	});
	log(
		"[magic-context][pi] registered context handler (tagging + drops + nudges)",
	);
}

/**
 * Track in-flight historian runs per session so we don't fire a second
 * pass while the first is still running. The flag also exists in
 * session_meta.compartment_in_progress (see `runPiHistorian` setting
 * it), but that DB-side flag is durable across restarts and the
 * trigger logic already inspects it; this in-memory map is a
 * fast-path so we don't hit the DB just to dedupe per turn.
 *
 * We store the actual Promise (not just the session id) so the
 * `session_shutdown` handler can `await` outstanding runs before Pi
 * exits — critical for `pi --print` mode where the parent process
 * exits as soon as `agent_end` fires, otherwise killing the historian
 * subprocess mid-run.
 */
const inFlightHistorian = new Map<string, Promise<unknown>>();

/**
 * Wait for all in-flight historian runs to complete. Called from the
 * Pi `session_shutdown` event handler so historian can finish writing
 * compartments before the process exits. Returns immediately if no
 * runs are in-flight.
 */
export async function awaitInFlightHistorians(): Promise<void> {
	if (inFlightHistorian.size === 0) return;
	const promises = Array.from(inFlightHistorian.values());
	await Promise.allSettled(promises);
}

/**
 * Trigger evaluation + fire-and-forget historian invocation. Runs
 * after the synchronous tagging pass so trigger logic sees the
 * just-assigned tags.
 *
 * The actual historian subagent spawn (`runPiHistorian`) is async
 * and intentionally NOT awaited — the LLM call should never wait on
 * historian. Errors are logged but never propagated; the user's
 * agent turn continues regardless of historian outcome.
 */
function maybeFireHistorian(args: {
	ctx: ExtensionContext;
	sessionId: string;
	db: ContextDatabase;
	historian: PiHistorianOptions;
}): void {
	const { ctx, sessionId, db, historian } = args;

	if (inFlightHistorian.has(sessionId)) {
		sessionLog(sessionId, "pi-historian trigger eval: in-flight, skipping");
		return;
	}

	// Pi exposes ctx.getContextUsage() returning { tokens, contextWindow,
	// percent }. We map to OpenCode's ContextUsage shape ({ percentage,
	// inputTokens }) used by the shared trigger.
	let usage: { percentage: number; inputTokens: number };
	try {
		const piUsage = ctx.getContextUsage?.();
		if (
			!piUsage ||
			piUsage.tokens === null ||
			piUsage.percent === null ||
			piUsage.contextWindow === 0
		) {
			sessionLog(
				sessionId,
				`pi-historian trigger eval: no usage info yet (tokens=${piUsage?.tokens ?? "<no piUsage>"}, percent=${piUsage?.percent ?? "<no piUsage>"}, contextWindow=${piUsage?.contextWindow ?? "<no piUsage>"})`,
			);
			return;
		}
		usage = {
			percentage: piUsage.percent,
			inputTokens: piUsage.tokens,
		};
		sessionLog(
			sessionId,
			`pi-historian trigger eval: usage=${usage.percentage.toFixed(1)}% (${usage.inputTokens} tokens), checking trigger...`,
		);
	} catch (err) {
		sessionLog(
			sessionId,
			`pi-historian trigger eval: getContextUsage threw: ${err instanceof Error ? err.message : String(err)}`,
		);
		return;
	}

	// Register the Pi RawMessageProvider for this sessionId so the
	// shared trigger logic + historian can read Pi session messages
	// via the standard `readRawSessionMessages` etc. helpers. The
	// provider stays registered while the historian runs and
	// unregisters in finally.
	const provider = {
		readMessages: () => readPiSessionMessages(ctx),
	};
	const unregister = setRawMessageProvider(sessionId, provider);

	let triggered = false;
	try {
		const sessionMeta = getOrCreateSessionMeta(db, sessionId);
		const trigger = checkCompartmentTrigger(
			db,
			sessionId,
			sessionMeta,
			usage,
			0, // _previousPercentage — unused by current trigger logic
			historian.executeThresholdPercentage ?? 65,
			historian.triggerBudget ?? 8000,
		);

		if (!trigger.shouldFire) {
			sessionLog(
				sessionId,
				`pi-historian trigger eval: shouldFire=false (no trigger condition met)`,
			);
			return;
		}

		triggered = true;
		sessionLog(
			sessionId,
			`pi-historian trigger fired (reason=${trigger.reason ?? "unknown"}) usage=${usage.percentage.toFixed(1)}% — spawning subagent`,
		);

		// Fire-and-forget for the user's LLM call: the parent agent
		// turn never awaits this. But we DO track the Promise in
		// inFlightHistorian so `awaitInFlightHistorians()` can wait
		// at session_shutdown — without that, `pi --print` mode would
		// kill the historian subprocess mid-run when the parent exits.
		const runPromise = runPiHistorian({
			db,
			sessionId,
			directory: ctx.cwd,
			provider,
			runner: historian.runner,
			historianModel: historian.model,
			fallbackModels: historian.fallbackModels,
			historianChunkTokens: historian.historianChunkTokens,
			historianTimeoutMs: historian.timeoutMs,
			memoryEnabled: historian.memoryEnabled,
			autoPromote: historian.autoPromote,
		}).finally(() => {
			inFlightHistorian.delete(sessionId);
			unregister();
		});
		inFlightHistorian.set(sessionId, runPromise);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		sessionLog(sessionId, `pi-historian trigger eval failed: ${message}`);
		if (!triggered) unregister();
	}
}
interface RunPipelineArgs {
	db: ContextDatabase;
	tagger: Tagger;
	sessionId: string;
	projectIdentity: string;
	messages: Parameters<typeof createPiTranscript>[0];
	ctxReduceEnabled: boolean;
	protectedTags: number;
}

async function runPipeline(args: RunPipelineArgs) {
	const transcript = createPiTranscript(args.messages, args.sessionId);

	// Tagging: assigns tag numbers + injects §N§ prefixes (unless
	// ctx_reduce_enabled is false, in which case prefixes are skipped
	// but DB-side tag IDs still get created so drops continue to work).
	const { targets } = tagTranscript(
		args.sessionId,
		transcript,
		args.tagger,
		args.db,
		{
			skipPrefixInjection: !args.ctxReduceEnabled,
		},
	);

	// Apply queued drops from pending_ops. This is what /ctx-reduce or
	// future automatic compaction triggers use to remove specific tag
	// numbers; the actual mutation goes through the TagTarget surface
	// we built above and lands in the underlying AgentMessage content.
	//
	// `protectedTags` flows from the loaded `magic-context.jsonc` config
	// (Step 5b) — drops in the protected window are deferred via
	// `applyPendingOperations` so the agent's recent working context
	// stays intact. Default is 20 (matches OpenCode); range is 1-100.
	applyPendingOperations(args.sessionId, args.db, targets, args.protectedTags);

	// Apply persistent dropped/truncated tag statuses so cross-pass
	// drops survive even if pending_ops was already drained on a
	// previous pass. Unlike OpenCode (where this is replayed every
	// transform pass for cache-stability), Pi calls this once per
	// LLM call and the mutations get written back via the adapter's
	// commit() step.
	applyFlushedStatuses(args.sessionId, args.db, targets);

	transcript.commit();

	const outputMessages = transcript.getOutputMessages();
	// Pi's ContextEventResult: returning { messages } replaces the
	// array; returning nothing leaves it untouched. We always return
	// the rebuilt array even when there were no mutations because
	// `getOutputMessages()` returns source identity in that case
	// (see createPiTranscript), so Pi can short-circuit downstream
	// work via reference equality.
	return { messages: outputMessages };
}

// ---------------------------------------------------------------------------
// Nudge / note-nudge helpers
// ---------------------------------------------------------------------------

/**
 * Apply the rolling/iteration nudge after tagging. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` (around lines 568-604) — but for Pi
 * there is no anchored-assistant cache, so we use the simpler
 * insert-before-latest-user strategy from `injectPiNudge`.
 *
 * Pi delivers a fresh `AgentMessage[]` per `context` event, so every
 * pass behaves like an OpenCode "cache-busting" pass: nudges always
 * apply when the nudger says so, and there is no defer-pass replay or
 * anchor retirement to manage.
 */
function applyRollingNudge(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	ctx: ExtensionContext;
	nudgerFn: ReturnType<typeof createNudger>;
}): PiAgentMessage[] {
	const { sessionId, db, messages, ctx, nudgerFn } = args;

	const piUsage = ctx.getContextUsage?.();
	if (
		!piUsage ||
		piUsage.tokens === null ||
		piUsage.percent === null ||
		piUsage.contextWindow === 0
	) {
		// No usage info yet — nudger requires real numbers, so skip.
		return messages;
	}

	const usage = {
		percentage: piUsage.percent,
		inputTokens: piUsage.tokens,
		// Nudger's ContextUsage type carries a contextLimit too; pass it
		// for completeness even though the rolling-nudge math doesn't
		// consume it directly.
		contextLimit: piUsage.contextWindow,
	};

	const tags = getTagsBySession(db, sessionId);
	const messagesSinceLastUser = countMessagesSinceLastUserPi(messages);

	const nudge = nudgerFn(
		sessionId,
		usage,
		db,
		getTopNBySize,
		tags,
		messagesSinceLastUser,
		// Let the nudger fetch session meta itself — Pi doesn't have the
		// preloaded-meta optimization the OpenCode transform uses.
		undefined,
	);
	if (!nudge) return messages;

	return injectPiNudge(messages, nudge);
}

/**
 * Apply note-nudge replay + delivery. Mirrors OpenCode's
 * `transform-postprocess-phase.ts` (around lines 611-650).
 *
 * Two paths:
 *   1. Sticky replay: a previously-delivered nudge anchored to a user
 *      message id replays into that same message every pass (idempotent
 *      because `appendReminderToUserMessageById` checks for the exact
 *      reminder text before appending).
 *   2. Fresh delivery: when a note trigger has fired since the last
 *      delivery and the agent hasn't already read the note state,
 *      append a `<instruction name="deferred_notes">…` block to the
 *      latest user message and mark delivered.
 *
 * Both paths fail-open: if no eligible user message exists, the call
 * simply returns the messages unchanged.
 */
function applyNoteNudges(args: {
	sessionId: string;
	db: ContextDatabase;
	messages: PiAgentMessage[];
	projectIdentity: string;
}): PiAgentMessage[] {
	const { sessionId, db, messages, projectIdentity } = args;

	// Path 1: sticky replay first, so any newly-delivered nudge below
	// doesn't get double-attached on the same pass.
	const sticky = getStickyNoteNudge(db, sessionId);
	if (sticky) {
		const reinjected = appendReminderToUserMessageByIdPi(
			messages,
			sticky.messageId,
			sticky.text,
		);
		if (!reinjected) {
			// Anchor message gone — clear stale state. Mirrors OpenCode
			// transform-postprocess-phase.ts:621-630. New nudges only
			// re-appear when a fresh trigger fires.
			clearNoteNudgeState(db, sessionId);
			sessionLog(
				sessionId,
				`pi note-nudge: sticky anchor ${sticky.messageId} gone, cleared`,
			);
		}
	}

	// Path 2: fresh delivery. Use the latest user message id (or null if
	// no user messages yet) as the trigger-message hint to peekNoteNudgeText.
	const latestUserId = findLatestUserMessageIdPi(messages);
	const deferredNoteText = peekNoteNudgeText(
		db,
		sessionId,
		latestUserId,
		projectIdentity,
	);
	if (deferredNoteText) {
		const noteInstruction = `\n\n<instruction name="deferred_notes">${deferredNoteText}</instruction>`;
		const anchoredId = appendReminderToLatestUserMessagePi(
			messages,
			noteInstruction,
		);
		// Always mark delivered once text is generated — the trigger is
		// consumed even if no anchor was found, so future passes don't
		// re-fire on every transform.
		markNoteNudgeDelivered(db, sessionId, noteInstruction, anchoredId);
	}

	return messages;
}

/**
 * Count messages since the latest meaningful user message. "Meaningful"
 * here means a `user` role with non-empty text content. Mirrors
 * `countMessagesSinceLastUser` from
 * `packages/plugin/src/hooks/magic-context/transform-message-helpers.ts`,
 * adapted to the Pi `AgentMessage` shape.
 */
function countMessagesSinceLastUserPi(messages: PiAgentMessage[]): number {
	let count = 0;
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role === "user" && hasMeaningfulUserTextPi(msg)) break;
		count += 1;
	}
	return count;
}

/** Returns true when the message is a user role with non-empty text content. */
function hasMeaningfulUserTextPi(message: PiAgentMessage): boolean {
	if (message.role !== "user") return false;
	const content = (message as { content: unknown }).content;
	if (typeof content === "string") return content.trim().length > 0;
	if (!Array.isArray(content)) return false;
	for (const part of content as Array<{ type?: unknown; text?: unknown }>) {
		if (
			part &&
			part.type === "text" &&
			typeof part.text === "string" &&
			part.text.trim().length > 0
		) {
			return true;
		}
	}
	return false;
}

/**
 * Find the id of the latest meaningful user message. Pi messages don't
 * carry a stable id field per `AgentMessage`, so we synthesize one from
 * timestamp + index. Same approach as `auto-search-pi.ts`'s
 * `buildUserMessageTurnId` — duplicated locally to keep the modules
 * decoupled (note-nudge anchor and auto-search cache key are independent
 * concerns even though both currently use the same id shape).
 */
function findLatestUserMessageIdPi(messages: PiAgentMessage[]): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const ts = readTimestamp(msg);
		return `pi:${i}:${ts}`;
	}
	return null;
}

/**
 * Append `reminder` to the user message at `messageId` (synthetic id
 * built by `findLatestUserMessageIdPi`). Idempotent: skips if the exact
 * reminder text is already present. Mirrors
 * `appendReminderToUserMessageById` from OpenCode's
 * `transform-message-helpers.ts:54`.
 */
function appendReminderToUserMessageByIdPi(
	messages: PiAgentMessage[],
	messageId: string,
	reminder: string,
): boolean {
	for (let i = 0; i < messages.length; i += 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		const ts = readTimestamp(msg);
		const synthId = `pi:${i}:${ts}`;
		if (synthId !== messageId) continue;
		appendReminderToPiUserMessage(msg, reminder);
		return true;
	}
	return false;
}

/**
 * Append `reminder` to the latest meaningful user message. Returns the
 * synthetic id for sticky anchor tracking, or null when no user message
 * exists. Mirrors `appendReminderToLatestUserMessage` from
 * `transform-message-helpers.ts:37`.
 */
function appendReminderToLatestUserMessagePi(
	messages: PiAgentMessage[],
	reminder: string,
): string | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const msg = messages[i];
		if (msg?.role !== "user" || !hasMeaningfulUserTextPi(msg)) continue;
		appendReminderToPiUserMessage(msg, reminder);
		const ts = readTimestamp(msg);
		return `pi:${i}:${ts}`;
	}
	return null;
}

/**
 * Read the optional `timestamp` property from any message role without
 * tripping the structural type checker on roles that don't carry one.
 * Falls back to `"no-ts"` so synthetic ids stay stable across passes.
 */
function readTimestamp(message: PiAgentMessage): string {
	const ts = (message as { timestamp?: unknown }).timestamp;
	return typeof ts === "number" && Number.isFinite(ts) ? String(ts) : "no-ts";
}

/**
 * Append text to a user message, preserving its existing content shape:
 *   - `string`: direct concat (Pi accepts string user content).
 *   - array: append to the first text block, or push a new text block
 *     when the message is image-only.
 *
 * Idempotent — skips when the reminder is already present.
 */
function appendReminderToPiUserMessage(
	message: PiAgentMessage,
	reminder: string,
): void {
	// Only `user` messages carry a string-or-array content shape we can
	// safely append to. Other roles (toolResult, custom, bashExecution)
	// don't get nudge text.
	if (message.role !== "user") return;
	const userMsg = message as { content: unknown };

	if (typeof userMsg.content === "string") {
		if (!userMsg.content.includes(reminder)) {
			userMsg.content = userMsg.content + reminder;
		}
		return;
	}
	if (!Array.isArray(userMsg.content)) return;

	const contentArr = userMsg.content as Array<{
		type?: unknown;
		text?: unknown;
	}>;
	for (let i = 0; i < contentArr.length; i += 1) {
		const part = contentArr[i];
		if (
			part &&
			part.type === "text" &&
			typeof (part as { text?: string }).text === "string"
		) {
			const text = (part as { text: string }).text;
			if (!text.includes(reminder)) {
				(part as { text: string }).text = text + reminder;
			}
			return;
		}
	}
	// Image-only or empty array — push a new text block. Trim leading
	// `\n\n` because there's nothing to separate from.
	contentArr.push({ type: "text", text: reminder.trimStart() });
}

/**
 * Session cleanup hook called from Pi's `session_deleted` lifecycle.
 * Drains per-session caches owned by this module so a deleted session
 * doesn't leave dangling state in process memory. Counterpart to the
 * OpenCode `session.deleted` cleanup in `event-handler.ts`.
 */
export function clearContextHandlerSession(sessionId: string): void {
	clearAutoSearchForPiSession(sessionId);
	// Note: in-flight historian + recentReduceBySession + nudge placement
	// are all module-private inside this file or its dependencies.
	// recentReduceBySession lives on the captured closure of the
	// registered handler; if Pi exposes session_deleted we can wire a
	// dedicated cleanup later (Step 5b territory).
}
