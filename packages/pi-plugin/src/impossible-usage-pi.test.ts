import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
	getOrCreateSessionMeta,
	getTagsBySession,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import type { SubagentRunner } from "@magic-context/core/shared/subagent-runner";

import {
	awaitInFlightHistorians,
	clearContextHandlerSession,
	recordPiLiveModel,
	registerPiContextHandler,
} from "./context-handler";
import { persistPiPressureFromMessageEnd } from "./index";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Replays the usage sequence from a Pi session on openai-codex gpt-6-sol
// (272K window, 64K output reserve → 206,464 usable). After a WebSocket 1012
// retry, Pi's own context estimate jumped to 425,334 tokens — more than the
// model's whole window — and the next reading was back to 37,812. A reading
// above the window cannot be the prompt of any request the provider accepted,
// so it must not drive emergency reduction, historian force-firing, or the
// persisted pressure used by later passes.
const MODEL = {
	provider: "openai-codex",
	id: "gpt-6-sol",
	contextWindow: 272_000,
	maxTokens: 65_536,
};

type Handler = (
	event: { messages: never[] },
	ctx: never,
) => Promise<{ messages: never[] }>;

function setup(sessionId: string) {
	const db = createTestDb();
	updateSessionMeta(db, sessionId, { piStableIdScheme: 1 });
	const runner = {
		harness: "pi",
		run: mock(async () => ({
			ok: true as const,
			assistantText:
				'<compartment start="1" end="2" title="Replay"><p1>Replay history.</p1></compartment>',
			durationMs: 1,
		})),
	} as unknown as SubagentRunner;
	const fake = createFakePi();
	recordPiLiveModel(sessionId, "openai-codex/gpt-6-sol");
	registerPiContextHandler(fake.pi as never, {
		db,
		protectedTags: 0,
		heuristics: {},
		scheduler: { executeThresholdPercentage: 80 },
		historianContextLimit: 1_000_000,
		historianChunkTokens: 32_000,
		historian: {
			runner,
			model: "test/historian",
			historianChunkTokens: 32_000,
			historianContextLimit: 1_000_000,
			executeThresholdPercentage: 80,
			protectedTags: 0,
		},
	});
	const handler = fake.handlers.get("context") as Handler;
	const largeToolOutput = "word ".repeat(2999);
	const buildMessages = () => {
		const messages = [userMessage("start tool burst", 1)];
		for (let i = 0; i < 40; i++) {
			messages.push(assistantToolCall(`call-${i}`, "bash", {}, 2 + i * 2), {
				...toolResultMessage(`call-${i}`, largeToolOutput, 3 + i * 2),
				toolName: "bash",
			});
		}
		messages.push(userMessage("continue", 90));
		return messages as never[];
	};
	const entryIds = Array.from(
		{ length: buildMessages().length },
		(_, index) => `entry-${index + 1}`,
	);
	// When `retried` is set, the branch ends with the `context_edit` Pi appends
	// to hide a failed attempt before retrying; Pi's live figure is then a
	// chars/4 estimate of the whole raw branch.
	const contextFor = (messages: never[], tokens: number, retried = false) => {
		const base = fakeContext(sessionId, process.cwd(), entryIds, messages);
		return {
			...base,
			sessionManager: {
				...base.sessionManager,
				getBranch: () => [
					...base.sessionManager.getBranch(),
					...(retried
						? [{ type: "context_edit", id: "edit-1", targetId: "failed" }]
						: []),
				],
			},
			model: MODEL,
			getContextUsage: () => ({
				tokens,
				percent: (tokens / MODEL.contextWindow) * 100,
				contextWindow: MODEL.contextWindow,
			}),
		} as never;
	};
	// Mirrors index.ts message_end: the assistant's provider usage plus Pi's
	// live estimate, with the window Pi reports for the model.
	const messageEnd = (message: unknown, piTokens: number, retried = false) =>
		persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message,
			piContextWindow: MODEL.contextWindow,
			piContextWindowSource: "catalog",
			piModel: MODEL,
			piTokens,
			piTokensIsRawBranchEstimate: retried,
		});
	const runPass = (tokens: number, retried = false) => {
		const messages = buildMessages();
		return handler({ messages }, contextFor(messages, tokens, retried));
	};
	const droppedToolCount = () =>
		getTagsBySession(db, sessionId).filter(
			(tag) => tag.type === "tool" && tag.status === "dropped",
		).length;
	return { db, runner, runPass, messageEnd, droppedToolCount };
}

function codexUsage(promptTokens: number) {
	return {
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: promptTokens - 140_000 > 0 ? promptTokens - 140_000 : promptTokens,
			cacheRead: promptTokens - 140_000 > 0 ? 140_000 : 0,
			cacheWrite: 0,
			output: 50,
			totalTokens: promptTokens + 50,
		},
	};
}

describe("Pi usage readings above the model window (issue 534 replay)", () => {
	afterEach(() => {
		mock.restore();
	});

	it("ignores a 425K reading on a 272K window: no emergency, drops, or historian force", async () => {
		const sessionId = "ses-issue-534-impossible";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const { db, runner, runPass, messageEnd, droppedToolCount } =
			setup(sessionId);
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);
			await runPass(147_839);
			expect(droppedToolCount()).toBe(0);

			// The WebSocket 1012 retry: Pi's live estimate reports 425,334.
			await messageEnd(userMessage("tool result", 92), 425_334);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);
			await runPass(425_334);
			await runPass(425_334);
			await awaitInFlightHistorians();

			expect(droppedToolCount()).toBe(0);
			expect(runner.run).not.toHaveBeenCalled();
			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(false);
			expect(logs.some((line) => line.includes("force-firing"))).toBe(false);
			const impossible = logs.filter((line) =>
				line.includes("usage reading 425334 exceeds model window 272000"),
			);
			expect(impossible).toHaveLength(1);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);

			await messageEnd(assistantMessage("ok", 93, codexUsage(37_812)), 37_812);
			await runPass(37_812);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				37_812,
			);
			expect(droppedToolCount()).toBe(0);
			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(false);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("sets aside Pi's raw-branch estimate after a retry even below the window", async () => {
		const sessionId = "ses-issue-534-estimate-below-window";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const { db, runner, runPass, messageEnd, droppedToolCount } =
			setup(sessionId);
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			await runPass(147_839);

			// Same reporter shape, but the estimate (190K) fits the 272K window
			// while still sitting over the 206K usable limit.
			await messageEnd(userMessage("tool result", 92), 190_000, true);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				147_839,
			);
			await runPass(190_000, true);
			await runPass(190_000, true);
			await awaitInFlightHistorians();

			expect(droppedToolCount()).toBe(0);
			expect(runner.run).not.toHaveBeenCalled();
			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(false);
			expect(
				logs.filter((line) => line.includes("usage reading 190000 set aside")),
			).toHaveLength(1);

			await messageEnd(assistantMessage("ok", 93, codexUsage(37_812)), 37_812);
			await runPass(37_812);
			expect(getOrCreateSessionMeta(db, sessionId).lastInputTokens).toBe(
				37_812,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});

	it("still treats a 220K reading on a 272K window (over the 206K limit) as a real emergency", async () => {
		const sessionId = "ses-issue-534-real-overflow";
		const logs: string[] = [];
		spyOn(loggerModule, "sessionLog").mockImplementation(
			(_session: string, ...parts: unknown[]) => {
				logs.push(parts.map(String).join(" "));
			},
		);
		const { db, runPass, messageEnd, droppedToolCount } = setup(sessionId);
		try {
			await runPass(1_000);
			await messageEnd(
				assistantMessage("ok", 91, codexUsage(147_839)),
				147_839,
			);
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
			});
			await runPass(147_839);
			expect(droppedToolCount()).toBe(0);

			await messageEnd(userMessage("tool result", 92), 220_000);
			await runPass(220_000);
			await awaitInFlightHistorians();

			expect(logs.some((line) => line.includes("EMERGENCY"))).toBe(true);
			expect(droppedToolCount()).toBeGreaterThan(0);
			expect(logs.some((line) => line.includes("exceeds model window"))).toBe(
				false,
			);
		} finally {
			clearContextHandlerSession(sessionId);
			closeQuietly(db);
		}
	});
});

describe("isPiLiveUsageRawBranchEstimate", () => {
	const usage = (total: number) => ({
		input: total,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total,
	});
	const assistant = (total: number, stopReason = "stop") => ({
		type: "message",
		message: { role: "assistant", stopReason, usage: usage(total) },
	});

	it("follows Pi's rule: an edit or compaction after the last usage means estimate", async () => {
		const { isPiLiveUsageRawBranchEstimate } = await import("./pi-pressure");
		expect(isPiLiveUsageRawBranchEstimate([assistant(100)])).toBe(false);
		expect(
			isPiLiveUsageRawBranchEstimate([
				assistant(100),
				{ type: "message", message: { role: "toolResult" } },
			]),
		).toBe(false);
		// The failed attempt carries zero usage and is hidden by a context_edit.
		expect(
			isPiLiveUsageRawBranchEstimate([
				assistant(100),
				assistant(0, "error"),
				{ type: "context_edit" },
			]),
		).toBe(true);
		expect(
			isPiLiveUsageRawBranchEstimate([assistant(100), { type: "compaction" }]),
		).toBe(true);
		// The retried reply lands after the edit: Pi trusts its usage again.
		expect(
			isPiLiveUsageRawBranchEstimate([
				assistant(100),
				{ type: "context_edit" },
				assistant(120),
			]),
		).toBe(false);
		expect(isPiLiveUsageRawBranchEstimate(null)).toBe(false);
	});
});

describe("Pi message_end provider usage above a trusted window", () => {
	it("keeps the previous reading on success and still clamps after an overflow error", async () => {
		const db = createTestDb();
		const sessionId = "ses-issue-534-provider-usage";
		const piModel = {
			provider: "openai-codex",
			id: "gpt-6-sol",
			maxTokens: 65_536,
		};
		try {
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("ok", 1, { usage: { input: 147_839 } }),
				piContextWindow: 272_000,
				piContextWindowSource: "observed",
				piModel,
			});
			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("ok", 2, { usage: { input: 425_334 } }),
				piContextWindow: 272_000,
				piContextWindowSource: "observed",
				piModel,
			});
			let meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(147_839);
			expect(meta.observedSafeInputTokens).toBe(147_839);

			await persistPiPressureFromMessageEnd({
				db,
				sessionId,
				message: assistantMessage("", 3, {
					usage: { input: 425_334 },
					stopReason: "error",
					errorMessage: "Your input exceeds the context window",
				}),
				piContextWindow: 272_000,
				piContextWindowSource: "observed",
				piModel,
			});
			meta = getOrCreateSessionMeta(db, sessionId);
			expect(meta.lastInputTokens).toBe(272_000);
		} finally {
			closeQuietly(db);
		}
	});
});
