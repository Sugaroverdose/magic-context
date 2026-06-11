import { describe, expect, it } from "bun:test";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestDb } from "../test-utils.test";
import { registerMagicContextTools } from "./index";

describe("registerMagicContextTools", () => {
	it("can omit ctx_memory for retrieval-only sidekick subagents", () => {
		const db = createTestDb();
		try {
			const registered: string[] = [];
			const pi = {
				registerTool: (tool: { name: string }) => {
					registered.push(tool.name);
				},
			} as never;

			registerMagicContextTools(pi, {
				db,
				memoryToolEnabled: false,
				sessionScopedToolsDisabled: true,
			});

			expect(registered).toContain("ctx_search");
			expect(registered).not.toContain("ctx_memory");
			expect(registered).not.toContain("ctx_note");
			expect(registered).not.toContain("ctx_expand");
		} finally {
			closeQuietly(db);
		}
	});
});
