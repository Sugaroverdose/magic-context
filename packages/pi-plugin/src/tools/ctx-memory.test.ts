import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxMemoryTool } from "./ctx-memory";

describe("createCtxMemoryTool", () => {
	it("rejects list for primary agents and allows it for dreamer agents", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const dreamer = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: true,
			});

			const ctx = fakeContext("ses-memory") as never;
			const primaryResult = await primary.execute(
				"call-1",
				{ action: "list" },
				new AbortController().signal,
				undefined,
				ctx,
			);
			const dreamerResult = await dreamer.execute(
				"call-2",
				{ action: "list" },
				new AbortController().signal,
				undefined,
				ctx,
			);

			expect(primaryResult.isError).toBe(true);
			expect(primaryResult.content[0]?.text).toBe(
				"Error: Action 'list' is not allowed in this context.",
			);
			expect(dreamerResult.isError).toBeUndefined();
			expect(dreamerResult.content[0]?.text).toBe("No active memories found.");
		} finally {
			closeQuietly(db);
		}
	});

	it("allows a primary agent to archive (no longer dreamer-only)", async () => {
		const db = createTestDb();
		try {
			const primary = createCtxMemoryTool({
				db,
				memoryEnabled: true,
				embeddingEnabled: false,
				allowDreamerActions: false,
			});
			const ctx = fakeContext("ses-memory") as never;

			// write a memory as the primary agent, then archive it as the same
			// primary agent — archive replaced the old `delete` alias and is no
			// longer gated behind allowDreamerActions.
			const written = await primary.execute(
				"call-w",
				{ action: "write", category: "ARCHITECTURE", content: "Stale fact." },
				new AbortController().signal,
				undefined,
				ctx,
			);
			expect(written.isError).toBeUndefined();
			const idMatch = written.content[0]?.text?.match(/ID:\s*(\d+)/);
			const id = idMatch ? Number(idMatch[1]) : Number.NaN;
			expect(Number.isInteger(id)).toBe(true);

			const archived = await primary.execute(
				"call-a",
				{ action: "archive", id },
				new AbortController().signal,
				undefined,
				ctx,
			);
			expect(archived.isError).toBeUndefined();
			expect(archived.content[0]?.text).toContain("Archived memory");
		} finally {
			closeQuietly(db);
		}
	});
});
