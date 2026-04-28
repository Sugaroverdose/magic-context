import { describe, expect, it } from "bun:test";
import { enqueueDream } from "@magic-context/core/features/magic-context/dreamer/queue";
import { initializeDatabase } from "@magic-context/core/features/magic-context/storage-db";
import { queuePendingOp } from "@magic-context/core/features/magic-context/storage-ops";
import { insertTag } from "@magic-context/core/features/magic-context/storage-tags";
import { Database } from "@magic-context/core/shared/sqlite";
import { registerCtxDreamCommand } from "./ctx-dream";
import { registerCtxFlushCommand } from "./ctx-flush";
import { registerCtxRecompCommand } from "./ctx-recomp";
import { registerCtxStatusCommand } from "./ctx-status";

type Handler = (args: string, ctx: MockCommandContext) => Promise<void>;

interface SentMessage {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details?: unknown;
	};
	options?: { triggerTurn?: boolean };
}

interface MockCommandContext {
	cwd: string;
	model?: { provider: string; id: string };
	sessionManager: { getSessionId: () => string | undefined };
	getContextUsage: () => {
		contextWindow: number;
		tokens: number;
		percent: number;
	};
}

function createDb() {
	const db = new Database(":memory:");
	initializeDatabase(db);
	return db;
}

function createMockPi() {
	const handlers = new Map<string, Handler>();
	const sent: SentMessage[] = [];
	return {
		pi: {
			registerCommand(name: string, options: { handler: Handler }) {
				handlers.set(name, options.handler);
			},
			registerMessageRenderer() {},
			sendMessage(
				message: SentMessage["message"],
				options?: SentMessage["options"],
			) {
				sent.push({ message, options });
			},
		},
		handlers,
		sent,
	};
}

function createCtx(sessionId = "ses-1"): MockCommandContext {
	return {
		cwd: "/tmp/project",
		model: { provider: "anthropic", id: "claude" },
		sessionManager: { getSessionId: () => sessionId },
		getContextUsage: () => ({
			contextWindow: 100_000,
			tokens: 1_000,
			percent: 1,
		}),
	};
}

describe("Pi Magic Context commands", () => {
	it("registers /ctx-status and sends a non-turn custom status message", async () => {
		const db = createDb();
		const tagId = insertTag(db, "ses-1", "msg-1", "message", 1234, 1);
		queuePendingOp(db, "ses-1", tagId, "drop");
		const { pi, handlers, sent } = createMockPi();

		registerCtxStatusCommand(pi as never, {
			db,
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-status")?.("", createCtx());

		expect(sent).toHaveLength(1);
		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("## Magic Status");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("registers /ctx-flush and materializes queued pending ops", async () => {
		const db = createDb();
		const tagId = insertTag(db, "ses-1", "msg-1", "message", 1234, 1);
		queuePendingOp(db, "ses-1", tagId, "drop");
		const { pi, handlers, sent } = createMockPi();

		registerCtxFlushCommand(pi as never, { db });
		await handlers.get("ctx-flush")?.("", createCtx());

		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("Flushed 1 pending ops");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
	});

	it("registers /ctx-dream and reports existing or new queue state", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();

		registerCtxDreamCommand(pi as never, {
			db,
			projectDir: "/tmp/project",
			projectIdentity: "/tmp/project",
		});
		await handlers.get("ctx-dream")?.("", createCtx());

		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("/ctx-dream");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
		expect(enqueueDream(db, "/tmp/project", "manual")).toBeNull();
	});

	it("registers /ctx-recomp and requires confirmation before running", async () => {
		const db = createDb();
		const { pi, handlers, sent } = createMockPi();
		let runnerCalled = false;

		registerCtxRecompCommand(pi as never, {
			db,
			runner: {
				run: async () => {
					runnerCalled = true;
					return { ok: true, assistantText: "[]", cost: 0, durationMs: 1 };
				},
			},
			historianModel: "anthropic/claude",
			memoryEnabled: false,
			autoPromote: false,
		});
		await handlers.get("ctx-recomp")?.("", createCtx());

		expect(runnerCalled).toBe(false);
		expect(sent[0]?.message.customType).toBe("ctx-status");
		expect(sent[0]?.message.content).toContain("Confirmation Required");
		expect(sent[0]?.options?.triggerTurn).toBe(false);
	});
});
