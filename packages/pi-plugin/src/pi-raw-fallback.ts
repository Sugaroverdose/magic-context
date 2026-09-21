import {
	calibrationForModelKey,
	providerMass,
} from "@magic-context/core/hooks/magic-context/decision-calibration";

import { tokenizePiMessages } from "./tokenize-pi-messages";

export class PiStorageBusyError extends Error {
	readonly code = "PI_STORAGE_BUSY";
	readonly recoverable = true;

	constructor(options?: { cause?: unknown }) {
		super("Magic Context storage is busy; send your message again", options);
		this.name = "PiStorageBusyError";
	}
}

/** A byte-based approximation may reject early; admission needs measured system/tools and countable messages. */
export function assertPiRawFallbackFits(
	messages: readonly unknown[],
	contextLimit: number | undefined,
	log: (message: string) => void,
	cause: unknown,
	observed?: {
		modelKey: string;
		systemTokens: number;
		toolDefinitionTokens: number;
	},
): void {
	if (
		!contextLimit ||
		!Number.isFinite(contextLimit) ||
		!observed ||
		!Number.isFinite(observed.systemTokens) ||
		observed.systemTokens <= 0 ||
		!Number.isFinite(observed.toolDefinitionTokens) ||
		observed.toolDefinitionTokens < 0
	) {
		log("raw_fallback_refused completeness=partial");
		throw new PiStorageBusyError({ cause });
	}
	let bytes = 1;
	let serializationFailed = false;
	try {
		for (const message of messages) {
			const serialized = JSON.stringify(message);
			if (typeof serialized !== "string") {
				serializationFailed = true;
				break;
			}
			bytes += Buffer.byteLength(serialized) + 1;
			if (bytes > contextLimit * 4) break;
		}
	} catch {
		serializationFailed = true;
	}
	const proxyTokens = Math.ceil(bytes / 4);
	const complete = messages.every((message) => {
		if (!message || typeof message !== "object") return false;
		const m = message as { role?: string; content?: unknown };
		return (
			["user", "assistant", "toolResult"].includes(m.role ?? "") &&
			(typeof m.content === "string" ||
				(Array.isArray(m.content) &&
					m.content.every(
						(p: unknown) =>
							p !== null &&
							typeof p === "object" &&
							["text", "thinking", "toolCall"].includes(
								String((p as { type?: unknown }).type),
							),
					)))
		);
	});
	const raw = tokenizePiMessages([...messages]);
	const tokens = providerMass(
		{
			system: observed.systemTokens,
			tools: observed.toolDefinitionTokens + raw.toolCall,
			prose: raw.conversation,
		},
		calibrationForModelKey(observed.modelKey),
		true,
	);
	if (
		!complete ||
		!Number.isFinite(tokens) ||
		tokens <= 0 ||
		tokens > contextLimit ||
		serializationFailed ||
		proxyTokens > contextLimit
	) {
		log(
			`raw_fallback_over_context_limit proxy_bytes=${bytes} proxy_tokens=${proxyTokens} limit=${contextLimit} early_abort=true serialization_failed=${serializationFailed}`,
		);
		throw new PiStorageBusyError({ cause });
	}
}
