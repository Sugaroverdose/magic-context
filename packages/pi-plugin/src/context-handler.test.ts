import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as searchModule from "@magic-context/core/features/magic-context/search";
import {
	addNote,
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { onNoteTrigger } from "@magic-context/core/hooks/magic-context/note-nudger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { clearAutoSearchForPiSession } from "./auto-search-pi";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

describe("registerPiContextHandler", () => {
	afterEach(() => {
		clearContextHandlerSession("ses-context");
		clearContextHandlerSession("ses-sticky-context");
		clearAutoSearchForPiSession("ses-context");
		clearAutoSearchForPiSession("ses-sticky-context");
	});

	it("tags user, assistant, and toolResult messages through the Pi adapter", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const result = await handler(
				{
					messages: [
						userMessage("hello", 1),
						assistantMessage("answer", 2),
						toolResultMessage("call-1", "tool output", 3),
						userMessage("next", 4),
					] as never[],
				},
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[0] as never)).toMatch(/^§1§ hello/);
			expect(textOf(result.messages[1] as never)).toMatch(/^§2§ answer/);
			expect(textOf(result.messages[2] as never)).toMatch(/^§3§ tool output/);
			expect(
				getTagsBySession(db, "ses-context").map((tag) => tag.type),
			).toEqual(["message", "message", "tool", "message"]);
		} finally {
			closeQuietly(db);
		}
	});

	it("applies and drains pending drops for the session", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				// Disable protection so the immediate drop on tag #2 actually
				// materializes; otherwise the schema default (20) defers the
				// drop because tag #2 is in the protected window.
				protectedTags: 0,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				fakeContext("ses-context") as never,
			);
			queuePendingOp(db, "ses-context", 2, "drop");
			const result = await handler(
				{
					messages: [
						userMessage("keep user", 1),
						assistantMessage("drop assistant", 2),
					] as never[],
				},
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[1] as never)).toBe("[dropped §2§]");
			expect(getPendingOps(db, "ses-context")).toEqual([]);
		} finally {
			closeQuietly(db);
		}
	});

	it("injects a rolling nudge when the shared nudger band fires", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				nudge: {
					protectedTags: 0,
					nudgeIntervalTokens: 100,
					iterationNudgeThreshold: 10,
					executeThresholdPercentage: 65,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			const ctx = {
				...fakeContext("ses-context"),
				getContextUsage: () => ({
					tokens: 100,
					percent: 30,
					contextWindow: 10_000,
				}),
			};

			const result = await handler(
				{
					messages: [
						assistantMessage("answer", 1),
						userMessage("latest prompt", 2),
					] as never[],
				},
				ctx as never,
			);

			expect(result.messages).toHaveLength(3);
			expect(textOf(result.messages[1] as never)).toContain("CONTEXT REMINDER");
			expect(result.messages[2]?.role).toBe("user");
		} finally {
			closeQuietly(db);
		}
	});

	it("injects deferred-note text into the latest new user message", async () => {
		const db = createTestDb();
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId: "ses-context",
				content: "Remember to update docs.",
			});
			onNoteTrigger(db, "ses-context", "historian_complete");

			await handler(
				{ messages: [userMessage("trigger turn", 1)] as never[] },
				fakeContext("ses-context") as never,
			);
			const result = await handler(
				{ messages: [userMessage("new turn", 2)] as never[] },
				fakeContext("ses-context") as never,
			);

			expect(textOf(result.messages[0] as never)).toContain(
				'<instruction name="deferred_notes">',
			);
			expect(textOf(result.messages[0] as never)).toContain("1 deferred note");
		} finally {
			closeQuietly(db);
		}
	});

	it("replays sticky note nudges idempotently across passes", async () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-sticky-context";
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;
			addNote(db, "session", {
				sessionId,
				content: "Sticky reminder.",
			});
			onNoteTrigger(db, sessionId, "historian_complete");
			await handler(
				{ messages: [userMessage("trigger turn", 1)] as never[] },
				fakeContext(sessionId) as never,
			);
			await handler(
				{ messages: [userMessage("new turn", 2)] as never[] },
				fakeContext(sessionId) as never,
			);

			const result = await handler(
				{ messages: [userMessage("new turn", 2)] as never[] },
				fakeContext(sessionId) as never,
			);
			const onceMore = await handler(
				{ messages: result.messages },
				fakeContext(sessionId) as never,
			);

			expect(
				textOf(result.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
			expect(
				textOf(onceMore.messages[0] as never).match(/deferred_notes/g),
			).toHaveLength(1);
		} finally {
			closeQuietly(db);
		}
	});

	it("appends an auto-search hint to the latest user message when the threshold is met", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () =>
				[
					{
						source: "memory",
						content: "Relevant Pi search wiring",
						score: 0.9,
						memoryId: 1,
						category: "WORKFLOW_RULES",
						matchType: "fts",
					},
				] as never,
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			const result = await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);

			expect(spy).toHaveBeenCalledTimes(1);
			expect(textOf(result.messages[0] as never)).toContain(
				"<ctx-search-hint>",
			);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});

	it("clearContextHandlerSession clears auto-search per-session caches", async () => {
		const db = createTestDb();
		const spy = spyOn(searchModule, "unifiedSearch").mockImplementation(
			async () => [],
		);
		try {
			const fake = createFakePi();
			registerPiContextHandler(fake.pi as never, {
				db,
				ctxReduceEnabled: true,
				autoSearch: {
					enabled: true,
					scoreThreshold: 0.6,
					minPromptChars: 10,
					memoryEnabled: true,
					embeddingEnabled: false,
					gitCommitsEnabled: false,
				},
			});
			const handler = fake.handlers.get("context") as (
				event: { messages: never[] },
				ctx: never,
			) => Promise<{ messages: never[] }>;

			await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);
			await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);
			clearContextHandlerSession("ses-context");
			await handler(
				{ messages: [userMessage("explain pi search wiring", 1)] as never[] },
				fakeContext("ses-context") as never,
			);

			expect(spy).toHaveBeenCalledTimes(2);
		} finally {
			spy.mockRestore();
			closeQuietly(db);
		}
	});
});
