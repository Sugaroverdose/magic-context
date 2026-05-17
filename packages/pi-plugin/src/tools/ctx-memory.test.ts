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
});
