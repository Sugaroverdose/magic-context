/**
 * Pi-side stamp-withdraw laws. The revocation mechanics, provenance rule, and
 * echo template all live in the shared core (`@magic-context/core/tools/
 * ctx-expand/withdraw`); these laws pin that the Pi wrapper (1) exercises the
 * same behavior through its own execute() and (2) contains no fork of the
 * template or bespoke queue SQL.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getPendingOps,
	queuePendingOp,
} from "@magic-context/core/features/magic-context/storage";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import {
	assistantToolCall,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "../test-utils.test";
import { createCtxExpandTool } from "./ctx-expand";

const SESSION = "ses-pi-withdraw";

function fixture() {
	const db = createTestDb();
	const tagger = createTagger();
	const messages = [
		userMessage("original text", 1),
		assistantToolCall("call-1", "Read", { path: "PLAN.md" }),
		toolResultMessage("call-1", "original output"),
	];
	const ctx = fakeContext(
		SESSION,
		process.cwd(),
		["entry-0", "entry-1", "entry-2"],
		messages,
	);
	const toolTag = tagger.assignToolTag(SESSION, "call-1", "entry-1", 10, db);
	return { db, ctx, toolTag };
}

function textOf(
	result: Awaited<
		ReturnType<ReturnType<typeof createCtxExpandTool>["execute"]>
	>,
) {
	return (result.content[0] as { text: string }).text;
}

describe("Pi ctx_expand stamp-withdraw", () => {
	it("tag mode revokes the pending agent stamp and echoes the canonical line", async () => {
		const { db, ctx, toolTag } = fixture();
		try {
			queuePendingOp(db, SESSION, toolTag, "drop");
			const text = textOf(
				await createCtxExpandTool({ db }).execute(
					"expand",
					{ tag: toolTag },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).toContain("original output");
			expect(text).toContain(`stamp withdrawn: ${toolTag} stays in context`);
			expect(getPendingOps(db, SESSION)).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	it("message mode revokes by ordinal with the ordinal-keyed line", async () => {
		const { db, ctx, toolTag } = fixture();
		try {
			queuePendingOp(db, SESSION, toolTag, "drop");
			const text = textOf(
				await createCtxExpandTool({ db }).execute(
					"expand",
					{ message: 2 },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).toContain("stamp withdrawn: 2 stays in context");
			expect(getPendingOps(db, SESSION)).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	it("range mode revokes every pending agent stamp in the span", async () => {
		const { db, ctx, toolTag } = fixture();
		try {
			queuePendingOp(db, SESSION, toolTag, "drop");
			const text = textOf(
				await createCtxExpandTool({ db }).execute(
					"expand",
					{ start: 1, end: 3 },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).toContain("stamp withdrawn: 2 stays in context");
			expect(getPendingOps(db, SESSION)).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	it("law (ii): expand at the split-result ordinal shows the output AND revokes the stamp", async () => {
		// Pi stores the invocation and the result as sibling messages; the
		// render path serves the stamped output at the RESULT ordinal via the
		// sibling walk, so the withdraw lane must cover that address too.
		const { db, ctx, toolTag } = fixture();
		try {
			queuePendingOp(db, SESSION, toolTag, "drop");
			const text = textOf(
				await createCtxExpandTool({ db }).execute(
					"expand",
					{ message: 3 },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).toContain("original output");
			expect(text).toContain("stamp withdrawn: 3 stays in context");
			expect(getPendingOps(db, SESSION)).toHaveLength(0);
		} finally {
			db.close();
		}
	});

	it("ownerless tool tag refuses in both lanes: renderer text, row intact, no echo", async () => {
		const db = createTestDb();
		try {
			const tagger = createTagger();
			const orphan = tagger.assignToolTag(SESSION, "call-1", "entry-1", 10, db);
			db.prepare(
				"UPDATE tags SET tool_owner_message_id = NULL WHERE tag_number = ?",
			).run(orphan);
			queuePendingOp(db, SESSION, orphan, "drop");
			const messages = [
				userMessage("original text", 1),
				assistantToolCall("call-1", "Read", { path: "PLAN.md" }),
				toolResultMessage("call-1", "original output"),
			];
			const ctx = fakeContext(
				SESSION,
				process.cwd(),
				["entry-0", "entry-1", "entry-2"],
				messages,
			);
			const text = textOf(
				await createCtxExpandTool({ db }).execute(
					"expand",
					{ tag: orphan },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).toBe(
				`Tag ${orphan}'s tool owner is unknown; its original call cannot be resolved safely.`,
			);
			expect(text).not.toContain("stamp withdrawn");
			expect(getPendingOps(db, SESSION)).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("system-origin rows are not revocable and no withdrawal is claimed", async () => {
		const { db, ctx, toolTag } = fixture();
		try {
			queuePendingOp(db, SESSION, toolTag, "auto_drop");
			const text = textOf(
				await createCtxExpandTool({ db }).execute(
					"expand",
					{ tag: toolTag },
					new AbortController().signal,
					undefined,
					ctx as never,
				),
			);
			expect(text).not.toContain("stamp withdrawn");
			const ops = getPendingOps(db, SESSION);
			expect(ops.map((row) => row.operation)).toEqual(["auto_drop"]);
		} finally {
			db.close();
		}
	});
});

describe("Pi ctx_expand withdraw census", () => {
	it("resolves stamps only through the shared core withdraw module, with no forked template or bespoke queue SQL", () => {
		const source = readFileSync(join(import.meta.dir, "ctx-expand.ts"), "utf8");
		expect(source).toContain("@magic-context/core/tools/ctx-expand/withdraw");
		expect(source).toContain("withdrawStampsForTags");
		expect(source).toContain("withdrawStampsForOrdinals");
		expect(source).toContain("stampWithdrawnLine");
		// The template lives in the core constants module — never re-worded here.
		expect(source).not.toContain("stamp withdrawn:");
		// The tool lane speaks no SQL: deletions go through the storage layer's
		// sanctioned helpers only (getPendingOps / removePendingOpById).
		expect(source).not.toContain("pending_ops");
		expect(source).not.toContain("db.prepare");
		// Every withdraw call site pins the Pi text-index domain, so the
		// resolver runs the exact branch renderItemByTag runs on this harness.
		const callSites = source.match(
			/withdrawStampsFor(?:Tags|Ordinals)\((?:[^()]|\([^()]*\))*"text"/g,
		);
		expect(callSites?.length).toBe(4);
	});
});
