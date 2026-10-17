import type { OrdinalMint } from "@magic-context/core/features/magic-context/reduce-resolver";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readPiSessionMessages } from "./read-session-pi";

/**
 * The Pi-side message-ordinal mint. The canonical space is the one
 * `ctx_expand(message=N)` consumes: Pi's raw-message provider
 * (`readPiSessionMessages`) assigns ordinals by branch-walk position, so the
 * mint walks the SAME reader and stays consistent with expansion by
 * construction — no stored ordinal is consulted.
 *
 * Maps every key domain the registry can hold:
 * - bare entry ids (`message.id`) for live message rows,
 * - wire call ids (assistant `toolCall` blocks carry the provider call id as
 *   `callID` on the Pi raw part) for tool rows,
 * - synthetic registration keys `pi-msg-<ordinal>-<ts>-<role>` (Pi rows
 *   registered before id adoption): the ordinal is embedded in the key and
 *   frozen at birth; Pi histories are append-only, so the embedded position
 *   stays the canonical position.
 * Plus the newest user-message boundary for the bulk lane.
 *
 * Read-only over the session manager; no storage surface.
 */
export function createPiOrdinalMint(
	ctx: ExtensionContext,
): OrdinalMint | undefined {
	let messages: ReturnType<typeof readPiSessionMessages>;
	try {
		messages = readPiSessionMessages(ctx);
	} catch {
		return undefined;
	}
	const ordinalByMessageId = new Map<string, number>();
	const ordinalByCallId = new Map<string, number>();
	let latestUserOrdinal: number | undefined;
	for (const message of messages) {
		if (typeof message.id === "string" && message.id.length > 0) {
			ordinalByMessageId.set(message.id, message.ordinal);
		}
		if (
			message.role === "user" &&
			(latestUserOrdinal === undefined || message.ordinal > latestUserOrdinal)
		) {
			latestUserOrdinal = message.ordinal;
		}
		for (const part of message.parts) {
			const tool = part as { type?: unknown; callID?: unknown } | null;
			if (
				tool !== null &&
				typeof tool === "object" &&
				tool.type === "tool" &&
				typeof tool.callID === "string" &&
				tool.callID.length > 0
			) {
				ordinalByCallId.set(tool.callID, message.ordinal);
			}
		}
	}
	return { ordinalByMessageId, ordinalByCallId, latestUserOrdinal };
}
