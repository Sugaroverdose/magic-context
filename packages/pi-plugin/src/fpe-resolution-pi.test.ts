/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { deriveKey, renderDropToken } from "@magic-context/core/hooks/magic-context/fpe";
import { createPiFpeResolution } from "./fpe-resolution-pi";
import { lookupReleasedToolInputPi } from "./fpe-resolve-pi";

function sessionContext(id: string) {
	return { sessionManager: { getSessionId: () => id } } as never;
}

describe("Pi .before FPE resolution", () => {
	const session = "pi-fpe-session";
	const key = deriveKey(session);

	it("restores the original input in place when a released-call token resolves", () => {
		const guard = createPiFpeResolution({
			fpeLookup: (ctx, sessionId, tagNumber) =>
				sessionId === session && tagNumber === 42
					? { path: "/tmp/a", content: "x" }
					: undefined,
			fpeMaxTag: () => 1000,
		});
		const input = { command: renderDropToken(42, key) };

		const result = guard(
			{ type: "tool_call", toolCallId: "call-42", toolName: "bash", input },
			sessionContext(session),
		);

		expect(result).toBeUndefined();
		// Same object identity, original bytes — the Pi contract is in-place
		// mutation (the executor holds its own reference to this object).
		expect(input).toEqual({ path: "/tmp/a", content: "x" });
	});

	it("leaves the token as it is when the lookup resolves nothing", () => {
		const guard = createPiFpeResolution({
			fpeLookup: () => undefined,
			fpeMaxTag: () => 1000,
		});
		const token = renderDropToken(43, key);
		const input = { command: token };

		const result = guard(
			{ type: "tool_call", toolCallId: "call-43", toolName: "bash", input },
			sessionContext(session),
		);

		expect(result).toBeUndefined();
		expect(input).toEqual({ command: token });
	});

	it("reads the original arguments from session entries by wire call id", () => {
		const db = {
			prepare: () => ({ get: () => ({ content_id: "call-9" }) }),
		} as never;
		const sessionManager = {
			getBranch: () => [
				{ type: "message", message: { content: [{ type: "text", text: "hi" }] } },
				{
					type: "message",
					message: {
						content: [
							{
								type: "toolCall",
								id: "call-9",
								name: "bash",
								arguments: { command: "ls -la" },
							},
						],
					},
				},
			],
		};

		expect(lookupReleasedToolInputPi(db, sessionManager, session, 9)).toEqual({
			command: "ls -la",
		});

		const noTag = { prepare: () => ({ get: () => undefined }) } as never;
		expect(lookupReleasedToolInputPi(noTag, sessionManager, session, 10)).toBeUndefined();
	});
});
