import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
	signalPiDeferredMaterialization,
} from "./context-handler";
import {
	persistPiMessageEndModelMeta,
	persistPiPressureFromMessageEnd,
} from "./index";
import {
	assistantMessage,
	assistantToolCall,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	type PiMessage,
	userMessage,
} from "./test-utils.test";

// Mirror of the OpenCode lane law: system-origin reclaim (auto_drop rows,
// the tool-reclaim sweeper, heuristics) rides only byte-change events. A
// consumed deferred-materialization intent whose fold rewrote nothing must
// keep queued auto_drop rows in the queue; model stamps release immediately.
const MODEL = { provider: "test-provider", id: "test-model" };

function providerUsage(inputTokens: number) {
	return {
		usage: {
			input: inputTokens,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 40,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function setup(sessionId: string) {
	const logs: string[] = [];
	spyOn(loggerModule, "sessionLog").mockImplementation(
		(_session: string, ...parts: unknown[]) => {
			logs.push(parts.map(String).join(" "));
		},
	);
	const root = createTestTempDirFromPath(join(tmpdir(), "mc-system-reclaim-"));
	const db = createTestDb();
	const fake = createFakePi();
	registerPiContextHandler(fake.pi as never, {
		db,
		heuristics: {},
		injection: { injectionBudgetTokens: 10_000 },
		protectedTags: 1,
		scheduler: { executeThresholdPercentage: 65 },
	});
	const handler = fake.handlers.get("context") as (
		event: { messages: never[] },
		ctx: never,
	) => Promise<unknown>;
	const messageEnd = async (message: PiMessage) => {
		persistPiMessageEndModelMeta({ db, sessionId, message, cacheTtlConfig: "30m" });
		await persistPiPressureFromMessageEnd({
			db,
			sessionId,
			message,
			piContextWindow: 100_000,
			piContextWindowSource: "catalog",
			piModel: MODEL,
		});
	};
	const runPass = async (messages: PiMessage[], percent: number) => {
		await handler({ messages: messages as never[] }, {
			...fakeContext(
				sessionId,
				root,
				messages.map((_message, index) => `entry-${index}`),
				messages,
			),
			model: { ...MODEL, contextWindow: 100_000 },
			getContextUsage: () => ({
				tokens: percent * 1_000,
				percent,
				contextWindow: 100_000,
			}),
		} as never);
	};
	const cleanup = () => {
		clearContextHandlerSession(sessionId);
		closeQuietly(db);
		rmSync(root, { recursive: true, force: true });
	};
	return { db, logs, messageEnd, runPass, cleanup };
}

async function seededToolRound(sessionId: string) {
	const ctx = setup(sessionId);
	const user1 = userMessage(`first request ${"context ".repeat(200)}`, 1);
	await ctx.runPass([user1], 20);
	const answer = assistantMessage(`first answer ${"detail ".repeat(200)}`, 2, {
		provider: MODEL.provider,
		model: MODEL.id,
		...providerUsage(20_000),
	});
	await ctx.messageEnd(answer);
	const callStamp = assistantToolCall("call-stamp", "Read", { path: "a.ts" }, 3);
	const resultStamp = toolResultMessage("call-stamp", "stamped output", 4);
	const callSweep = assistantToolCall("call-sweep", "Read", { path: "b.ts" }, 5);
	const resultSweep = toolResultMessage("call-sweep", "sweeper target output", 6);
	const messages = [user1, answer, callStamp, resultStamp, callSweep, resultSweep];
	await ctx.runPass(messages, 30);
	const rows = getTagsBySession(ctx.db, sessionId).filter(
		(tag) => tag.status === "active",
	);
	const stampTag = rows.find((tag) => tag.messageId === "call-stamp") ?? rows[0];
	const sweepTag = rows.find((tag) => tag.messageId === "call-sweep") ?? rows[1];
	queuePendingOp(ctx.db, sessionId, stampTag.id, "drop");
	queuePendingOp(ctx.db, sessionId, sweepTag.id, "auto_drop");
	return { ctx, messages, stampTag, sweepTag };
}

describe("Pi system-origin reclaim rides byte-change events", () => {
	afterEach(() => {});

	it("holds auto_drop rows when the consumed deferred fold rewrote nothing", async () => {
		const sessionId = "ses-pi-system-reclaim-hold";
		const { ctx, messages, stampTag, sweepTag } = await seededToolRound(sessionId);
		try {
			signalPiDeferredMaterialization(sessionId);
			await ctx.runPass(
				[
					...messages,
					assistantMessage(`continue ${"work ".repeat(200)}`, 7, {
						provider: MODEL.provider,
						model: MODEL.id,
						...providerUsage(21_000),
					}),
				],
				70,
			);
			expect(getTagsBySession(ctx.db, sessionId).find((t) => t.id === stampTag.id)!.status).toBe(
				"dropped",
			);
			expect(getPendingOps(ctx.db, sessionId).map((op) => op.tagId)).toEqual([sweepTag.id]);
			expect(getTagsBySession(ctx.db, sessionId).find((t) => t.id === sweepTag.id)!.status).toBe(
				"active",
			);
			expect(
				ctx.logs.some((line) => line.includes("reason=system-reclaim-ride-required")),
			).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	it("drains auto_drop rows on the forced band", async () => {
		const sessionId = "ses-pi-system-reclaim-force";
		const { ctx, messages, sweepTag } = await seededToolRound(sessionId);
		try {
			await ctx.runPass(
				[
					...messages,
					assistantMessage(`continue ${"work ".repeat(200)}`, 7, {
						provider: MODEL.provider,
						model: MODEL.id,
						...providerUsage(40_000),
					}),
				],
				96,
			);
			expect(getPendingOps(ctx.db, sessionId)).toEqual([]);
			expect(getTagsBySession(ctx.db, sessionId).find((t) => t.id === sweepTag.id)!.status).toBe(
				"dropped",
			);
		} finally {
			ctx.cleanup();
		}
	});
});
