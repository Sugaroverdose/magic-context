import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getPendingOps,
	getTagsBySession,
	queuePendingOp,
	removePendingOp,
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
	type PiMessage,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

// Mirror of the OpenCode lane law: system-origin reclaim (queued drops, the
// tool-reclaim sweeper, heuristics) rides only byte-change events. A consumed
// deferred-materialization intent whose fold rewrote nothing must keep the
// whole queue waiting. Frozen-base adaptation: dual vocabulary ('drop' model
// stamps + 'auto_drop' system-origin from the core compartment runner) — the
// classes differ at apply (sweeper render shape), not in ride permission:
// the queue is all-or-nothing (#2641).
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
		persistPiMessageEndModelMeta({
			db,
			sessionId,
			message,
			cacheTtlConfig: "30m",
		});
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
	const callStamp = assistantToolCall(
		"call-stamp",
		"Read",
		{ path: "a.ts" },
		3,
	);
	const resultStamp = toolResultMessage("call-stamp", "stamped output", 4);
	const callSweep = assistantToolCall(
		"call-sweep",
		"Read",
		{ path: "b.ts" },
		5,
	);
	const resultSweep = toolResultMessage(
		"call-sweep",
		"sweeper target output",
		6,
	);
	const messages = [
		user1,
		answer,
		callStamp,
		resultStamp,
		callSweep,
		resultSweep,
	];
	await ctx.runPass(messages, 30);
	const rows = getTagsBySession(ctx.db, sessionId).filter(
		(tag) => tag.status === "active",
	);
	const stampTag =
		rows.find((tag) => tag.messageId === "call-stamp") ?? rows[0];
	const sweepTag =
		rows.find((tag) => tag.messageId === "call-sweep") ?? rows[1];
	// Production vocabulary: the model stamps its own release as 'drop';
	// the system-origin lane (compartment runner) queues the sweep target as
	// 'auto_drop' — see core compartment-runner-drop-queue.ts.
	queuePendingOp(ctx.db, sessionId, stampTag.id, "drop");
	queuePendingOp(ctx.db, sessionId, sweepTag.id, "auto_drop");
	return { ctx, messages, stampTag, sweepTag };
}

describe("Pi system-origin reclaim rides byte-change events", () => {
	afterEach(() => {});

	it("holds queued rows when the consumed deferred fold rewrote nothing", async () => {
		const sessionId = "ses-pi-system-reclaim-hold";
		const { ctx, messages, stampTag, sweepTag } =
			await seededToolRound(sessionId);
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
			expect(
				getTagsBySession(ctx.db, sessionId).find((t) => t.id === stampTag.id)!
					.status,
			).toBe("active");
			expect(getPendingOps(ctx.db, sessionId).map((op) => op.tagId)).toEqual([
				stampTag.id,
				sweepTag.id,
			]);
			expect(
				getTagsBySession(ctx.db, sessionId).find((t) => t.id === sweepTag.id)!
					.status,
			).toBe("active");
			expect(
				ctx.logs.some((line) =>
					line.includes("reason=system-reclaim-ride-required"),
				),
			).toBe(true);
		} finally {
			ctx.cleanup();
		}
	});

	it("drains queued rows on the forced band", async () => {
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
			expect(
				getTagsBySession(ctx.db, sessionId).find((t) => t.id === sweepTag.id)!
					.status,
			).toBe("dropped");
		} finally {
			ctx.cleanup();
		}
	});

	it("duplicate auto_drop+stamp rows both apply; last (stamp) release realizes, shape converges to full", async () => {
		const sessionId = "ses-pi-system-reclaim-dup";
		const { ctx, messages, sweepTag } = await seededToolRound(sessionId);
		try {
			// Same tag, both vocabularies: the system lane queues auto_drop
			// first, the model stamps drop on top before either drains.
			// pending_ops has no unique constraint on (session, tag) — both
			// rows persist, and BOTH apply: tagStatusById is snapshotted
			// before the apply loop, so the second row never sees the first
			// row's flip (removePendingOp(tag_id) clears both). The terminal
			// persisted shape is the last-applied (stamp) row's — the
			// model's release realizes. DOCUMENTED CURRENT BEHAVIOR: the
			// stale-snapshot double-apply is escalated to the coordinator;
			// do not "fix" this row silently either way.
			for (const op of getPendingOps(ctx.db, sessionId)) {
				removePendingOp(ctx.db, sessionId, op.tagId);
			}
			queuePendingOp(ctx.db, sessionId, sweepTag.id, "auto_drop");
			queuePendingOp(ctx.db, sessionId, sweepTag.id, "drop");
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
			const tag = getTagsBySession(ctx.db, sessionId).find(
				(t) => t.id === sweepTag.id,
			)!;
			expect(tag.status).toBe("dropped");
			// Both rows run (tagStatusById is snapshotted before the apply
			// loop, so the second row does not see the first row's flip): the
			// terminal persisted shape is the last-applied row's. On the Pi
			// adapter every class converges to the structural drop("full") —
			// the target has no erase/skeletonReal capability — so the stamp
			// intent is realized and no release is lost. See contrast row.
			expect(tag.dropMode).toBe("full");
		} finally {
			ctx.cleanup();
		}
	});

	it("model stamp alone reaches the same terminal shape as the duplicate pair", async () => {
		const sessionId = "ses-pi-system-reclaim-stamp-only";
		const { ctx, messages, sweepTag } = await seededToolRound(sessionId);
		try {
			for (const op of getPendingOps(ctx.db, sessionId)) {
				removePendingOp(ctx.db, sessionId, op.tagId);
			}
			queuePendingOp(ctx.db, sessionId, sweepTag.id, "drop");
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
			const tag = getTagsBySession(ctx.db, sessionId).find(
				(t) => t.id === sweepTag.id,
			)!;
			expect(tag.status).toBe("dropped");
			// Same terminal dropMode as the duplicate row above: the Pi
			// adapter renders every pending-op class through the structural
			// drop, so the model's release is not lost when a stale
			// auto_drop row is queued underneath it. Hosts with full target
			// capability (erase/skeletonReal) are covered by the core
			// apply-operations source-gate tests.
			expect(tag.dropMode).toBe("full");
		} finally {
			ctx.cleanup();
		}
	});
});
