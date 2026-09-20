/** Provider instructions and tool deltas are protocol state, never reclaimable content. */
export interface PiSystemEntry {
	role: "system";
	content: string | { type: "text"; text: string; textSignature?: string }[];
	sections?: Record<string, string | null>;
	toolsAdded?: readonly unknown[];
	toolsRemoved?: readonly { name: string }[];
	timestamp?: number;
}

/** Role alone is the compatibility boundary; older Pi and OMP transcripts have none. */
export function isPiSystemEntry(message: unknown): message is PiSystemEntry {
	return (
		message !== null &&
		typeof message === "object" &&
		"role" in message &&
		message.role === "system"
	);
}

/** Insert history users after the leading system run: Pi reads initial tool declarations only at index zero. */
export function piPrefixInsertionIndex(messages: readonly unknown[]): number {
	let index = 0;
	while (isPiSystemEntry(messages[index])) index++;
	return index;
}

export function isPiSystemMessageEntry(entry: unknown): boolean {
	return (
		entry !== null &&
		typeof entry === "object" &&
		"message" in entry &&
		isPiSystemEntry(entry.message)
	);
}

/** Adopt the host system snapshot when recording compaction, so the next replay does not change request bytes. */
export function adoptPiCompactionSystemSnapshot(
	messages: unknown[],
	entries: readonly unknown[],
): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (
			!entry ||
			typeof entry !== "object" ||
			!("type" in entry) ||
			entry.type !== "compaction"
		)
			continue;
		if (!("systemMessage" in entry) || !isPiSystemEntry(entry.systemMessage))
			return false;
		const snapshot = structuredClone(entry.systemMessage);
		const content = messages.filter((message) => !isPiSystemEntry(message));
		messages.splice(0, messages.length, snapshot, ...content);
		// Match the injected history messages' timestamps to the new system head,
		// just as prefix injection will do on every later replay.
		for (let offset = 1; offset <= 2; offset++) {
			const message = messages[offset];
			if (
				message &&
				typeof message === "object" &&
				"timestamp" in message &&
				typeof snapshot.timestamp === "number"
			)
				message.timestamp = snapshot.timestamp + offset - 3;
		}
		return true;
	}
	return false;
}
