import type {
	ExtensionAPI,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	createDroppedInputGuard,
	resolveReleasedToolInput,
} from "@magic-context/core/hooks/magic-context/dropped-input-guard";

export interface PiDroppedInputGuardOptions {
	/** The live schema of a tool by name, so the refusal can list its real parameters. */
	parametersFor?: (toolName: string) => unknown;
	/**
	 * Pre-execute FPE resolution: the original input stored for a released-call
	 * token (host session read). The `.before` contract is whole-args
	 * replacement — the Pi host documents in-place mutation of `event.input`
	 * as the args-modification channel (the executor keeps its own reference).
	 */
	fpeLookup?: (
		ctx: Pick<ExtensionContext, "sessionManager"> | undefined,
		sessionId: string,
		tagNumber: number,
	) => unknown;
}

export function createPiDroppedInputGuard(
	options: PiDroppedInputGuardOptions = {},
): (
	event: ToolCallEvent,
	ctx?: Pick<ExtensionContext, "sessionManager">,
) => ToolCallEventResult | undefined {
	const guard = createDroppedInputGuard({
		parametersFor: options.parametersFor,
	});
	return (event, ctx) => {
		let sessionID: string | undefined;
		try {
			sessionID = ctx?.sessionManager?.getSessionId?.();
		} catch {
			sessionID = undefined;
		}
		if (sessionID !== undefined && event.input !== undefined && options.fpeLookup) {
			const resolved = resolveReleasedToolInput(event.input, sessionID, {
				lookupOriginal: (sessionId, tagNumber) =>
					options.fpeLookup?.(ctx, sessionId, tagNumber),
			});
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
		}
		const reason = guard.check({
			sessionID,
			toolName: event.toolName,
			input: event.input,
		});
		if (reason === undefined) return undefined;
		return { block: true, reason };
	};
}

export function registerPiDroppedInputGuard(
	pi: ExtensionAPI,
	options: PiDroppedInputGuardOptions = {},
): void {
	pi.on(
		"tool_call",
		createPiDroppedInputGuard({
			parametersFor: (toolName) =>
				pi.getAllTools?.().find((tool) => tool.name === toolName)?.parameters,
			fpeLookup: options.fpeLookup,
		}),
	);
}
