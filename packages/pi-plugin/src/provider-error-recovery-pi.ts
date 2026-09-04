import {
	detectOverflow,
	detectThinkingBindingMismatch,
	isFable51ThinkingBindingModel,
} from "@magic-context/core/features/magic-context/overflow-detection";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	addMergedReasoningStrippedIds,
	armThinkingBindingRecovery,
	getMergedReasoningStrippedIds,
	getThinkingBindingRecoveryTarget,
	NEWEST_REASONING_BEARING_ASSISTANT,
	recordOverflowDetected,
	THINKING_BINDING_RECOVERY_FROZEN_PREFIX,
	thinkingBindingRecoveryFrozenId,
} from "@magic-context/core/features/magic-context/storage-meta-persisted";
import { dropSlot } from "@magic-context/core/hooks/magic-context/lkg-slot";

import { clearPiLkgSessionState } from "./pi-lkg";

export type PiProviderFailureResult =
	| { kind: "none" }
	| { kind: "thinking_binding"; armed: boolean }
	| {
			kind: "overflow";
			reportedLimit?: number;
			reportedLimitProvenance?: string;
			matchedPattern?: string;
	  };

/** Persist recovery state from Pi's assistant `message_end` error payload. */
export function handlePiProviderFailure(args: {
	db: ContextDatabase;
	sessionId: string;
	message: unknown;
	compactionOff?: boolean;
	thinkingBindingRecoveryEnabled?: boolean;
}): PiProviderFailureResult {
	if (!args.message || typeof args.message !== "object")
		return { kind: "none" };
	const message = args.message as {
		role?: unknown;
		errorMessage?: unknown;
		provider?: unknown;
		model?: unknown;
	};
	if (
		message.role !== "assistant" ||
		typeof message.errorMessage !== "string" ||
		message.errorMessage.length === 0
	) {
		return { kind: "none" };
	}

	const provider =
		typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	const binding = detectThinkingBindingMismatch(message.errorMessage);
	if (binding.isBindingMismatch) {
		const enabled =
			args.thinkingBindingRecoveryEnabled !== false &&
			!args.compactionOff &&
			isFable51ThinkingBindingModel(provider, model);
		if (enabled) {
			// Pi's AgentMessage has no OpenCode-style internal assistant id. The
			// branch projection provides stable entry ids on the next context pass,
			// so recover the newest reasoning-bearing assistant there.
			armThinkingBindingRecovery(args.db, args.sessionId);
			clearPiLkgSessionState(args.sessionId);
			dropSlot(args.sessionId, "thinking-binding-recovery-arm");
		}
		return { kind: "thinking_binding", armed: enabled };
	}

	if (args.compactionOff) return { kind: "none" };
	const overflow = detectOverflow(message.errorMessage);
	if (!overflow.isOverflow) return { kind: "none" };
	const modelKey = provider && model ? `${provider}/${model}` : undefined;
	recordOverflowDetected(
		args.db,
		args.sessionId,
		overflow.reportedLimit,
		modelKey,
		"provider_overflow",
		overflow.reportedLimitProvenance,
	);
	return {
		kind: "overflow",
		...(overflow.reportedLimit !== undefined
			? { reportedLimit: overflow.reportedLimit }
			: {}),
		...(overflow.reportedLimitProvenance !== undefined
			? { reportedLimitProvenance: overflow.reportedLimitProvenance }
			: {}),
		...(overflow.matchedPattern !== undefined
			? { matchedPattern: overflow.matchedPattern }
			: {}),
	};
}

interface PiThinkingPart {
	type?: unknown;
}

interface PiAssistantMessage {
	role?: unknown;
	content?: unknown;
}

function hasThinkingPart(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const assistant = message as PiAssistantMessage;
	return (
		assistant.role === "assistant" &&
		Array.isArray(assistant.content) &&
		assistant.content.some((part) => {
			if (!part || typeof part !== "object") return false;
			const type = (part as PiThinkingPart).type;
			return (
				type === "thinking" ||
				type === "redactedThinking" ||
				type === "redacted_thinking"
			);
		})
	);
}

function stripThinkingParts(message: unknown): number {
	if (!message || typeof message !== "object") return 0;
	const assistant = message as PiAssistantMessage;
	const content = assistant.content;
	if (assistant.role !== "assistant" || !Array.isArray(content)) return 0;
	const before = content.length;
	const strippedContent = content.filter((part) => {
		if (!part || typeof part !== "object") return true;
		const type = (part as PiThinkingPart).type;
		return (
			type !== "thinking" &&
			type !== "redactedThinking" &&
			type !== "redacted_thinking"
		);
	});
	assistant.content = strippedContent;
	return before - strippedContent.length;
}

export interface PiThinkingBindingApplication {
	flagTarget: string;
	entryId: string;
}

/** Apply and replay the persisted Fable thinking-binding recovery decision. */
export function applyPiThinkingBindingRecovery(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	entryIds: readonly (string | undefined)[];
	provider?: string;
	model?: string;
}): PiThinkingBindingApplication | null {
	if (args.provider?.toLowerCase() !== "anthropic") return null;
	const frozenEntryIds = new Set<string>();
	for (const frozenId of getMergedReasoningStrippedIds(
		args.db,
		args.sessionId,
	)) {
		if (!frozenId.startsWith(THINKING_BINDING_RECOVERY_FROZEN_PREFIX)) continue;
		const entryId = frozenId.slice(
			THINKING_BINDING_RECOVERY_FROZEN_PREFIX.length,
		);
		if (entryId.length > 0) frozenEntryIds.add(entryId);
	}

	const flagTarget = isFable51ThinkingBindingModel(args.provider, args.model)
		? getThinkingBindingRecoveryTarget(args.db, args.sessionId)
		: null;
	let applied: PiThinkingBindingApplication | null = null;
	if (flagTarget) {
		let messageIndex = -1;
		if (flagTarget === NEWEST_REASONING_BEARING_ASSISTANT) {
			for (let index = args.messages.length - 1; index >= 0; index -= 1) {
				if (hasThinkingPart(args.messages[index]) && args.entryIds[index]) {
					messageIndex = index;
					break;
				}
			}
		} else {
			messageIndex = args.entryIds.findIndex(
				(entryId, index) =>
					entryId === flagTarget && hasThinkingPart(args.messages[index]),
			);
		}
		const entryId = messageIndex >= 0 ? args.entryIds[messageIndex] : undefined;
		if (entryId) {
			const frozenId = thinkingBindingRecoveryFrozenId(entryId);
			if (
				frozenEntryIds.has(entryId) ||
				addMergedReasoningStrippedIds(args.db, args.sessionId, [frozenId])
			) {
				frozenEntryIds.add(entryId);
				applied = { flagTarget, entryId };
			}
		}
	}

	for (let index = 0; index < args.messages.length; index += 1) {
		const entryId = args.entryIds[index];
		if (entryId && frozenEntryIds.has(entryId))
			stripThinkingParts(args.messages[index]);
	}
	return applied;
}
