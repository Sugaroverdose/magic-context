import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { resolveReleasedToolInput } from "@magic-context/core/hooks/magic-context/fpe-resolve";

export interface PiFpeResolutionOptions {
	/** Original input stored for a released-call token (Pi session read). */
	fpeLookup?: (
		ctx: Pick<ExtensionContext, "sessionManager"> | undefined,
		sessionId: string,
		tagNumber: number,
	) => unknown;
	/** Highest tag_number of the session; FPE resolution stays inert without it. */
	fpeMaxTag?: (sessionId: string) => number | undefined;
}

/**
 * Pi's `tool_call` gate, resolution-only on this branch: a released-call
 * token in the args is replaced with the ORIGINAL input, in place — the Pi
 * contract for modifying arguments (the executor holds its own reference, so
 * reassigning `event.input` would not propagate). The upstream dropped-input
 * refusal regex is not wired here: no drop path renders the marker bytes it
 * matched, so the scan would only cost per-call time. Unresolved tokens pass
 * through as they are, as on every harness.
 */
export function createPiFpeResolution(
	options: PiFpeResolutionOptions = {},
): (
	event: ToolCallEvent,
	ctx?: Pick<ExtensionContext, "sessionManager">,
) => ToolCallEventResult | undefined {
	return (event, ctx) => {
		let sessionID: string | undefined;
		try {
			sessionID = ctx?.sessionManager?.getSessionId?.();
		} catch {
			sessionID = undefined;
		}
		if (
			sessionID === undefined ||
			event.input === undefined ||
			!options.fpeLookup
		) {
			return undefined;
		}
		let resolved: unknown;
		try {
			resolved = resolveReleasedToolInput(event.input, sessionID, {
				lookupOriginal: (sessionId, tagNumber) =>
					options.fpeLookup?.(ctx, sessionId, tagNumber),
				maxTag: (sessionId) => options.fpeMaxTag?.(sessionId),
			});
		} catch {
			// Corrupted-token reject (instruction to re-issue) is wired on the
			// OpenCode `.before` surface; the Pi spike passes it through.
			return undefined;
		}
		if (
			resolved !== undefined &&
			event.input !== null &&
			typeof event.input === "object" &&
			!Array.isArray(event.input) &&
			typeof resolved === "object" &&
			resolved !== null &&
			!Array.isArray(resolved)
		) {
			const target = event.input as Record<string, unknown>;
			for (const key of Object.keys(target)) delete target[key];
			Object.assign(target, resolved as Record<string, unknown>);
		}
		return undefined;
	};
}

export function registerPiFpeResolution(
	pi: ExtensionAPI,
	options: PiFpeResolutionOptions,
): void {
	pi.on("tool_call", createPiFpeResolution(options));
}
