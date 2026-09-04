import { describe, expect, it } from "bun:test";

import { createTestDb, fakeContext } from "../test-utils.test";
import { createCtxExpandTool } from "./ctx-expand";

async function execute(params: {
	message?: number;
	start?: number;
	end?: number;
	verbose?: boolean;
}) {
	const db = createTestDb();
	try {
		return await createCtxExpandTool({ db }).execute(
			"call-expand",
			params,
			new AbortController().signal,
			undefined,
			fakeContext("ses-expand-integers") as never,
		);
	} finally {
		db.close();
	}
}

function textOf(result: Awaited<ReturnType<typeof execute>>): string {
	return (result.content[0] as { text: string }).text;
}

describe("Pi ctx_expand ordinal validation", () => {
	it("rejects fractional message and range ordinals", async () => {
		const byMessage = await execute({ message: 1.5 });
		expect(byMessage.isError).toBe(true);
		expect(textOf(byMessage)).toBe(
			"Error: message must be a positive integer.",
		);

		const byRange = await execute({ start: 1.5, end: 2 });
		expect(byRange.isError).toBe(true);
		expect(textOf(byRange)).toBe(
			"Error: provide either message=<ordinal>, or start and end (positive integers, start <= end).",
		);
	});
});
