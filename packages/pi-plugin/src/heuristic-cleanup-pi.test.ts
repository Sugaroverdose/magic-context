import { describe, expect, it } from "bun:test";
import { getTagsBySession } from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	applyFlushedStatuses,
	applyPendingOperations,
} from "@magic-context/core/hooks/magic-context/apply-operations";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import {
	assistantMessage,
	createTestDb,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

function tagMessages(
	sessionId: string,
	db: ReturnType<typeof createTestDb>,
	messages: unknown[],
) {
	const tagger = createTagger();
	tagger.initFromDb(sessionId, db);
	const transcript = createPiTranscript(messages, sessionId);
	const tagged = tagTranscript(sessionId, transcript, tagger, db);
	return { tagger, transcript, targets: tagged.targets };
}

describe("applyPiHeuristicCleanup", () => {
	it("keeps identical read-tool fingerprints distinct across assistant owners", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-cross-owner";
			const messages = [
				userMessage("read once", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
				userMessage("read again", 3),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 4,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				autoDropToolAge: 100,
				dropToolStructure: true,
				protectedTags: 0,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(0);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "pi-msg-1-2-assistant", "active"],
				["read-call-b", "pi-msg-3-4-assistant", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("deduplicates same-owner parallel read calls with identical arguments", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic-same-owner";
			const messages = [
				userMessage("read twice", 1),
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "read-call-a",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
						{
							type: "toolCall",
							id: "read-call-b",
							name: "mcp_read",
							arguments: { filePath: "src/a.ts" },
						},
					],
					timestamp: 2,
				},
			];
			const { transcript, targets } = tagMessages(sessionId, db, messages);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				autoDropToolAge: 100,
				dropToolStructure: true,
				protectedTags: 0,
			});
			transcript.commit();

			expect(result.deduplicatedTools).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.type === "tool")
					.map((tag) => [tag.messageId, tag.toolOwnerMessageId, tag.status]),
			).toEqual([
				["read-call-a", "pi-msg-1-2-assistant", "dropped"],
				["read-call-b", "pi-msg-1-2-assistant", "active"],
			]);
		} finally {
			closeQuietly(db);
		}
	});

	it("persists full drops for stale ctx_reduce calls and paired tool results", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-heuristic";
			const messages = [
				userMessage("older request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will reduce now." },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old tags", 3),
					toolName: "ctx_reduce",
				},
				userMessage("next request", 4),
				assistantMessage("newer answer", 5),
				userMessage("latest request", 6),
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId);
			const { targets } = tagTranscript(sessionId, transcript, tagger, db);

			const result = applyPiHeuristicCleanup(sessionId, db, targets, messages, {
				autoDropToolAge: 2,
				dropToolStructure: true,
				protectedTags: 0,
			});
			transcript.commit();

			expect(result.droppedStaleReduceCalls).toBe(1);
			expect(
				getTagsBySession(db, sessionId)
					.filter((tag) => tag.messageId === "reduce-1")
					.map((tag) => [tag.status, tag.dropMode]),
			).toEqual([["dropped", "full"]]);

			const replayMessages = [
				userMessage("older request", 1),
				{
					role: "assistant",
					content: [
						{ type: "text", text: "I will reduce now." },
						{
							type: "toolCall",
							id: "reduce-1",
							name: "ctx_reduce",
							arguments: {},
						},
					],
					timestamp: 2,
				},
				{
					...toolResultMessage("reduce-1", "reduced old tags", 3),
					toolName: "ctx_reduce",
				},
				userMessage("next request", 4),
				assistantMessage("newer answer", 5),
				userMessage("latest request", 6),
			];
			const replayTranscript = createPiTranscript(replayMessages, sessionId);
			const replay = tagTranscript(sessionId, replayTranscript, tagger, db);
			applyPendingOperations(sessionId, db, replay.targets, 0);
			applyFlushedStatuses(sessionId, db, replay.targets);
			replayTranscript.commit();

			// Aggregate target uses tagId in sentinel (matches OpenCode parity in
			// apply-operations.ts:43 — `[dropped §<tagId>§]`). Tag allocation
			// order across the transcript: user "older request" (#1), assistant
			// text "I will reduce now." (#2), assistant toolCall reduce-1 (#3),
			// user toolResult reuses #3, user "next request" (#4), assistant
			// "newer answer" (#5), user "latest request" (#6). reduce-1 = #3.
			expect(textOf(replayTranscript.getOutputMessages()[2] as never)).toBe(
				"[dropped §3§]",
			);
		} finally {
			closeQuietly(db);
		}
	});
});
