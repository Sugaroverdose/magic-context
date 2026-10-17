/**
 * Pi-side wrapper for the `ctx_reduce` tool.
 *
 * Mirrors OpenCode's `packages/plugin/src/tools/ctx-reduce/tools.ts`.
 * Marking QUEUES content for release; it stays visible until it is actually
 * released, which may be the next turn or many turns later.
 * The shared description below keeps this contract identical to OpenCode.
 *
 * ctx_reduce v1 (Rev 5.3): the model-facing pointing surface is the
 * `ctx_handles` array — wire call ids, verbatim message quotes, and
 * `<start>..<end>` stretches, resolved by the SHARED core engine
 * (`reduce-resolver`), answered by the SHARED response grammar
 * (`reduce-response`) with message ordinals from the Pi raw-message reader
 * (the same space `ctx_expand(message=N)` consumes). The upstream numeric
 * `drop` path stays intact and un-advertised: the schema is open
 * (`additionalProperties`), so old-shaped or imitated calls still reach the
 * legacy code below unchanged. "Two front doors, one engine."
 *
 * Registered for primary Pi sessions. `--no-session` child processes omit this
 * tool because it resolves the current session id at call time, and those
 * children would otherwise write drops against their hidden ephemeral session.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
	type OrdinalMint,
	ordinalForRegistryKey,
	type ReduceInputOutcome,
	resolveBulkDefault,
	resolveHandles,
} from "@magic-context/core/features/magic-context/reduce-resolver";
import {
	MINT_UNAVAILABLE,
	renderPointingError,
	renderPointingSuccess,
} from "@magic-context/core/features/magic-context/reduce-response";
import type { CallIdTagResolver } from "@magic-context/core/features/magic-context/tool-call-registry";
import {
	getProtectionWindowForSession,
	readEpochFloorSnapshot,
} from "@magic-context/core/features/magic-context/protection-window";
import { parseRangeString } from "@magic-context/core/features/magic-context/range-parser";
import {
	type ContextDatabase,
	getOrCreateSessionMeta,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { getInertWhitespaceAssistantTags } from "@magic-context/core/features/magic-context/storage-tags";
import { getErrorMessage } from "@magic-context/core/shared/error-message";
import { CTX_REDUCE_DESCRIPTION } from "@magic-context/core/tools/ctx-reduce/constants";
import { unwrapImitatedReducedArgs } from "@magic-context/core/tools/unwrap-imitated-reduced-args";
import { type Static, Type } from "typebox";
import { createPiOrdinalMint } from "../message-ordinal-mint-pi";

const ParamsSchema = Type.Object(
	{
		// ctx_reduce v1: the numeric 'drop' parameter is no longer advertised
		// to the model. The schema is open, so old-shaped or imitated calls
		// still reach execute() and the upstream numeric path stays intact.
		ctx_handles: Type.Optional(
			Type.Array(
				Type.String(),
				{
					description:
						"Exact targets of the release, copied from your context: a tool call id, a verbatim run of an item's own text, or a stretch `<start>..<end>` of such handles.",
				},
			),
		),
	},
	{ additionalProperties: true },
);

// The advertised shape is ctx_handles only; the schema stays open, so the
// legacy numeric `drop` (and imitated reduced-call payloads) still arrive at
// runtime and the upstream numeric path keeps its contract below.
type CtxReduceParams = Static<typeof ParamsSchema> & {
	drop?: string;
	ctx_handles?: string[];
};

function ok(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

function err(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: undefined,
		isError: true,
	};
}

function formatIds(ids: number[]): string {
	return ids.map((id) => `§${id}§`).join(", ");
}

export interface CtxReduceToolDeps {
	db: ContextDatabase;
	protectedTags?: number;
	floor?: number;
	protectedTokens?: number;
	resolveFloor?: (ctx: { cwd: string }) => number | undefined;
	resolveProtectedTags?: (ctx: { cwd: string }) => number | undefined;
	getSessionTokens?: (sessionId: string) => number;
	/** DI seam for the canonical message-ordinal mint (tests). */
	ordinalMint?: OrdinalMint | ((ctx: unknown) => OrdinalMint | undefined);
	/** DI seam for the wire-call-id -> registry pairing (tests). */
	callIdResolver?: CallIdTagResolver;
}

/**
 * Wire call id -> registry tag on Pi: tool rows key themselves by the wire
 * call id in `message_id` (the OpenCode bridge's host-store rank pairing has
 * no Pi equivalent; the session provider is the call-id authority). The
 * ORDER BY prefers the live instance when a call id was reused across turns
 * (the composite-identity hazard) — the model points at what it can see.
 */
function createPiCallIdResolver(
	db: ContextDatabase,
	sessionId: string,
): CallIdTagResolver {
	return {
		resolve(callIds) {
			const map = new Map<
				string,
				{ tag_number: number; message_id: string; status: string; type: string } | undefined
			>();
			const statement = db.prepare(
				`SELECT tag_number, message_id, status, type
                   FROM tags
                  WHERE session_id = ? AND message_id = ? AND type = 'tool'
                  ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, tag_number DESC
                  LIMIT 1`,
			);
			for (const callId of callIds) {
				if (map.has(callId)) continue;
				const row = statement.get(sessionId, callId) as
					| { tag_number: number; message_id: string; status: string; type: string }
					| undefined;
				map.set(callId, row);
			}
			return map;
		},
	};
}

export function createCtxReduceTool(
	deps: CtxReduceToolDeps,
): ToolDefinition<typeof ParamsSchema> {
	const touchNudgeWatermark = (sessionId: string) => {
		const currentInputTokens =
			deps.getSessionTokens?.(sessionId) ??
			getOrCreateSessionMeta(deps.db, sessionId).lastInputTokens;
		updateSessionMeta(deps.db, sessionId, {
			lastNudgeTokens: currentInputTokens,
		});
	};

	const ordinalMintFor = (ctx: unknown): OrdinalMint | undefined => {
		if (deps.ordinalMint) {
			return typeof deps.ordinalMint === "function"
				? deps.ordinalMint(ctx)
				: deps.ordinalMint;
		}
		return createPiOrdinalMint(ctx as never);
	};

	/**
	 * Protection context for the v1 lanes. Mirrors the legacy path's
	 * effective-floor and window resolution below (kept as a separate
	 * computation so the upstream numeric path stays byte-identical).
	 */
	const resolveV1ProtectionContext = (
		sessionId: string,
		ctx: { cwd: string },
	): { protectedSet: ReadonlySet<number>; inertTagNumbers: Set<number> } => {
		const allTags = getTagsBySession(deps.db, sessionId);
		const effectiveFloor =
			readEpochFloorSnapshot(deps.db, sessionId) ??
			deps.resolveFloor?.(ctx) ??
			deps.floor ??
			deps.protectedTokens ??
			16_000;
		const windowResult = getProtectionWindowForSession(
			deps.db,
			sessionId,
			effectiveFloor,
		);
		const hasToolTags = allTags.some((tag) => tag.type === "tool");
		const activeTagNumbers = allTags
			.filter((tag) => tag.status === "active")
			.map((tag) => tag.tagNumber);
		const protectedSet = hasToolTags
			? windowResult.tagNumberSet.tagNumbers
			: typeof deps.protectedTags === "number" && deps.protectedTags > 0
				? new Set(
						[...activeTagNumbers]
							.sort((left, right) => right - left)
							.slice(0, deps.protectedTags),
					)
				: new Set<number>();
		const inertTagNumbers = new Set(
			getInertWhitespaceAssistantTags(deps.db, sessionId).map((tag) => tag.tagNumber),
		);
		return { protectedSet, inertTagNumbers };
	};

	/** No-arg default: release everything already responded past. */
	const executeBulkRelease = (
		sessionId: string,
		ctx: { cwd: string },
	): ReturnType<typeof ok> => {
		const { protectedSet, inertTagNumbers } = resolveV1ProtectionContext(
			sessionId,
			ctx,
		);
		const mint = ordinalMintFor(ctx);
		if (!mint) return err(MINT_UNAVAILABLE);
		const result = resolveBulkDefault({
			db: deps.db,
			sessionId,
			protectedTagNumbers: protectedSet,
			inertTagNumbers,
			mint,
		});
		if (result.releasedItems.length === 0) {
			return ok(
				result.protectedItems.length > 0
					? "Nothing older to release; newer work is still protected."
					: "Nothing to release: no consumed tool output is waiting.",
			);
		}
		try {
			const now = Date.now();
			deps.db
				.transaction(() => {
					for (const item of result.releasedItems) {
						queuePendingOp(deps.db, sessionId, item.tagNumber, "drop", now);
					}
				})
				.immediate();
		} catch (error) {
			return err(
				`Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
			);
		}
		touchNudgeWatermark(sessionId);
		const distinctOrdinals = [
			...new Set(
				result.releasedItems.flatMap((item) => {
					const ordinal = ordinalForRegistryKey(mint, item.messageId);
					return typeof ordinal === "number" ? [ordinal] : [];
				}),
			),
		];
		const lines: string[] = [
			`released everything responded past: ${distinctOrdinals.join(", ")}.`,
		];
		const inertOrdinals = [
			...new Set(
				result.inertItems.flatMap((item) => {
					const ordinal = ordinalForRegistryKey(mint, item.messageId);
					return typeof ordinal === "number" ? [ordinal] : [];
				}),
			),
		];
		if (inertOrdinals.length > 0) {
			lines.push(`nothing to reclaim: ${inertOrdinals.join(", ")}.`);
		}
		if (result.protectedItems.length > 0) {
			lines.push(
				"Newer items are inside the protected working set; they apply once your work displaces them.",
			);
		}
		return ok(lines.join("\n"));
	};

	const executePointingLane = (
		sessionId: string,
		rawHandles: string[],
		ctx: { cwd: string },
	): ReturnType<typeof ok> => {
		const handles = rawHandles
			.map((handle) => handle.trim())
			.filter((handle) => handle.length > 0);
		if (handles.length === 0) {
			return err("Error: 'ctx_handles' must contain entries.");
		}

		const { protectedSet, inertTagNumbers } = resolveV1ProtectionContext(
			sessionId,
			ctx,
		);
		const mint = ordinalMintFor(ctx);
		if (!mint) return err(MINT_UNAVAILABLE);

		// Validation completes BEFORE any enqueue: any error class rejects the
		// whole batch, so the forced retry is application-free (one apply event
		// per reduce intent).
		const result = resolveHandles(
			{
				db: deps.db,
				sessionId,
				protectedTagNumbers: protectedSet,
				inertTagNumbers,
				callIdResolver:
					deps.callIdResolver ?? createPiCallIdResolver(deps.db, sessionId),
				mint,
			},
			handles,
		);
		if (result.internalError) {
			return err(result.internalError);
		}

		const failure = result.outcomes.find(
			(outcome): outcome is Extract<ReduceInputOutcome, { kind: "error" }> =>
				outcome.kind === "error",
		);
		if (failure) {
			return err(renderPointingError(failure, mint));
		}

		if (result.queueTagNumbers.length > 0) {
			try {
				const now = Date.now();
				deps.db
					.transaction(() => {
						for (const tagNumber of result.queueTagNumbers) {
							queuePendingOp(deps.db, sessionId, tagNumber, "drop", now);
						}
					})
					.immediate();
			} catch (error) {
				return err(
					`Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
				);
			}
			touchNudgeWatermark(sessionId);
		}

		return ok(renderPointingSuccess(handles, result.outcomes, mint));
	};

	return {
		name: "ctx_reduce",
		label: "Magic Context: Reduce",
		description: CTX_REDUCE_DESCRIPTION,
		parameters: ParamsSchema,
		async execute(
			_toolCallId,
			params: CtxReduceParams,
			_signal,
			_onUpdate,
			ctx,
		) {
			params = unwrapImitatedReducedArgs(params, ["drop"], { drop: "string" });
			const sessionId = ctx.sessionManager.getSessionId();

			const hasHandles =
				Array.isArray(params.ctx_handles) && params.ctx_handles.length > 0;
			if (hasHandles && params.drop) {
				return err(
					"Error: 'ctx_handles' and 'drop' cannot be combined in one call.",
				);
			}
			if (!hasHandles && !params.drop) {
				if ("ctx_handles" in params) {
					return err("Error: 'ctx_handles' must contain entries.");
				}
				if ("drop" in params) {
					return err("Error: 'drop' must be provided.");
				}
				return executeBulkRelease(sessionId, ctx);
			}
			if (hasHandles) {
				return executePointingLane(
					sessionId,
					params.ctx_handles as string[],
					ctx,
				);
			}

			if (!params.drop) {
				return err("Error: 'drop' must be provided.");
			}

			let dropIds: number[] = [];
			try {
				dropIds = parseRangeString(params.drop);
			} catch (e) {
				return err(`Error: Invalid range syntax. ${(e as Error).message}`);
			}

			const allIds = [...new Set(dropIds)];

			const allTags = getTagsBySession(deps.db, sessionId);
			const foundSet = new Set(allTags.map((tag) => tag.tagNumber));
			const unknownIds = allIds.filter((id) => !foundSet.has(id));
			if (unknownIds.length > 0) {
				return err(
					`Error: Unknown tag(s) ${formatIds(unknownIds)}. Check available tags in conversation.`,
				);
			}

			const activeTags = allTags.filter((tag) => tag.status === "active");

			// Resolve the effective token floor threshold used to compute the protection window
			const effectiveFloor =
				readEpochFloorSnapshot(deps.db, sessionId) ??
				deps.resolveFloor?.(ctx) ??
				deps.floor ??
				deps.protectedTokens ??
				16_000;
			// Protection window membership in tag-number coordinate space (empty-window behaviour: empty set)
			const windowResult = getProtectionWindowForSession(
				deps.db,
				sessionId,
				effectiveFloor,
			);
			const hasToolTags = allTags.some((t) => t.type === "tool");
			const protectedSet = hasToolTags
				? windowResult.tagNumberSet.tagNumbers
				: typeof deps.protectedTags === "number" && deps.protectedTags > 0
					? new Set(
							activeTags
								.map((tag) => tag.tagNumber)
								.sort((left, right) => right - left)
								.slice(0, deps.protectedTags),
						)
					: new Set<number>();

			const tagStatusMap = new Map(
				allTags.map((tag) => [tag.tagNumber, tag.status]),
			);
			const inertWhitespaceTagNumbers = new Set(
				getInertWhitespaceAssistantTags(deps.db, sessionId).map(
					(tag) => tag.tagNumber,
				),
			);
			const inertDropIds = [
				...new Set(dropIds.filter((id) => inertWhitespaceTagNumbers.has(id))),
			];
			const inertNote =
				inertDropIds.length > 0
					? `Skipped: ${inertDropIds
							.map((id) => `§${id}§ is provider framing, nothing to reclaim`)
							.join("; ")}.`
					: "";

			const pendingOps = getPendingOps(deps.db, sessionId);
			const pendingMap = new Map(
				pendingOps.map((op) => [op.tagId, op.operation]),
			);

			// Reject drops on compaction-survivor tags. Mirrors OpenCode's
			// `tagStatusMap.get(id) === "compacted"` guard — those tags are
			// the synthesized survivors of an OpenCode compaction marker and
			// can't be dropped without confusing downstream readers.
			const conflicts: string[] = [];
			for (const id of dropIds) {
				if (
					tagStatusMap.get(id) === "compacted" &&
					!inertWhitespaceTagNumbers.has(id)
				) {
					conflicts.push(`§${id}§ is from before compaction`);
				}
			}
			if (conflicts.length > 0) {
				return err(`Error: Conflicting operations — ${conflicts.join("; ")}.`);
			}

			const alreadyDropped = [
				...new Set(dropIds.filter((id) => tagStatusMap.get(id) === "dropped")),
			];
			const alreadyQueued = [
				...new Set(
					dropIds.filter(
						(id) =>
							tagStatusMap.get(id) !== "dropped" &&
							pendingMap.get(id) === "drop",
					),
				),
			];
			const skippedNote = [
				alreadyDropped.length
					? `Already dropped: ${formatIds(alreadyDropped)}.`
					: "",
				alreadyQueued.length
					? `Already queued: ${formatIds(alreadyQueued)}.`
					: "",
			]
				.filter(Boolean)
				.join(" ");
			dropIds = dropIds.filter(
				(id) =>
					!inertWhitespaceTagNumbers.has(id) &&
					tagStatusMap.get(id) !== "dropped" &&
					pendingMap.get(id) !== "drop",
			);

			if (dropIds.length === 0) {
				return ok(
					[inertNote, skippedNote, "No new action is needed."]
						.filter(Boolean)
						.join(" "),
				);
			}

			try {
				deps.db
					.transaction(() => {
						const now = Date.now();
						for (const id of dropIds) {
							queuePendingOp(deps.db, sessionId, id, "drop", now);
						}
					})
					.immediate();
			} catch (error) {
				return err(
					`Error: Failed to queue ctx_reduce operations. ${getErrorMessage(error)}`,
				);
			}

			touchNudgeWatermark(sessionId);

			const immediateDropIds = dropIds.filter((id) => !protectedSet.has(id));
			const deferredDropIds = [
				...new Set(dropIds.filter((id) => protectedSet.has(id))),
			];

			const parts: string[] = [];
			if (immediateDropIds.length > 0)
				parts.push(`drop ${formatIds(immediateDropIds)}`);
			if (deferredDropIds.length > 0)
				parts.push(`deferred drop ${formatIds(deferredDropIds)}`);
			return ok(
				`Queued: ${parts.join(", ")}.${skippedNote ? ` ${skippedNote}` : ""}${inertNote ? ` ${inertNote}` : ""}`,
			);
		},
	};
}

