import type { Database } from "@magic-context/core/shared/sqlite";

interface PiSessionEntryLike {
	type?: unknown;
	message?: unknown;
}

interface PiSessionReaderLike {
	getBranch?: (fromId?: string) => unknown[];
}

/**
 * Pi's `.before` FPE resolution: resolve a released-call token's tag number
 * to the ORIGINAL tool call input stored in the Pi session. The tags row
 * pins the call exactly (`content_id` = the wire call id, same grammar as
 * OpenCode), and the Pi store keeps real bytes for released calls (drops are
 * wire transforms — the same property ctx_expand expands from). Reads only;
 * no MC writes. The OpenCode path (opencode.db) does not apply — on Pi the
 * transcript lives in the session entries.
 */
export function lookupReleasedToolInputPi(
	db: Database,
	sessionManager: PiSessionReaderLike | undefined,
	sessionId: string,
	tagNumber: number,
): Record<string, unknown> | undefined {
	const tag = db
		.prepare(
			"SELECT content_id FROM tags WHERE session_id = ? AND tag_number = ? AND type = 'tool'",
		)
		.get(sessionId, tagNumber) as { content_id: string | null } | undefined;
	const callId = tag?.content_id;
	if (typeof callId !== "string" || callId.length === 0) return undefined;
	if (typeof sessionManager?.getBranch !== "function") return undefined;
	let entries: unknown[];
	try {
		entries = sessionManager.getBranch();
	} catch {
		return undefined;
	}
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const messageEntry = entry as PiSessionEntryLike;
		if (messageEntry.type !== "message") continue;
		const message = messageEntry.message as { content?: unknown } | undefined;
		const content = message?.content;
		if (!Array.isArray(content)) continue;
		for (const block of content as unknown[]) {
			if (!block || typeof block !== "object") continue;
			const call = block as { type?: unknown; id?: unknown; arguments?: unknown };
			if (call.type !== "toolCall" || call.id !== callId) continue;
			if (
				call.arguments &&
				typeof call.arguments === "object" &&
				!Array.isArray(call.arguments)
			) {
				return call.arguments as Record<string, unknown>;
			}
		}
	}
	return undefined;
}
