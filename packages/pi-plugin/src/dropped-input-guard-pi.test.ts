/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import { createPiDroppedInputGuard } from "./dropped-input-guard-pi";

const blockedInputs: Array<[string, Record<string, unknown>]> = [
	["tagged drop sentinel", { command: "[dropped §431§]" }],
	// Drop-shape doctrine restore (2026-11-06 owner ruling, base bytes
	// canonical): the five-character truncation copy rejoins the core guard's
	// blocked set — edit-marker.ts is byte-identical to base and LIVE on this
	// tree, minting the exact shape into model-visible edit_marker tool input
	// (9c1520810:dropped-input-guard-pi.test.ts:9 had it blocked for the same
	// reason: the core guard recognized it).
	["legacy truncation", { command: "which...[truncated]" }],
	["new dropped marker", { dropped: "[dropped §431§]" }],
];

// Core-contract mirror (Unit 4, coordinator split item D) — narrowed 2026-11-06
// with the doctrine restore: only the two shapes that NEITHER base nor v2 mints
// stay unrecognised in the shared core guard this Pi wrapper delegates to
// ("[N items]", "[object]" — pre-upgrade wire archaeology, rg-verified absent
// from base production; census drop-shape doctrine-restore addendum). The
// truncation-shaped string rejoined blockedInputs above: the Unit 4 "no minter"
// premise was falsified for it (edit-marker.ts renders `...[truncated]`).
const notBlockedInputs: Array<[string, Record<string, unknown>]> = [
	["array-summary string (no minter)", { files: "[3 items]" }],
	["object-summary string (no minter)", { metadata: "[object]" }],
];

const writeParameters = Type.Object({
	path: Type.String(),
	content: Type.String(),
	append: Type.Optional(Type.Boolean()),
});

function sessionContext(id: string) {
	return { sessionManager: { getSessionId: () => id } } as never;
}

describe("Pi dropped input execution guard", () => {
	for (const [label, input] of blockedInputs) {
		it(`blocks the ${label}`, () => {
			const result = createPiDroppedInputGuard()({
				type: "tool_call",
				toolCallId: "call-431",
				toolName: "write",
				input,
			});

			expect(result).toEqual({
				block: true,
				reason: expect.stringContaining(
					`your arguments to \`write\` were ${JSON.stringify(input)}`,
				),
			});
		});
	}

	it("executes a shape the retired arms used to block (core contract)", () => {
		for (const [, input] of notBlockedInputs) {
			const result = createPiDroppedInputGuard()({
				type: "tool_call",
				toolCallId: "call-clean",
				toolName: "write",
				input,
			});
			expect(result).toBeUndefined();
		}
	});

	it("lists the tool's real parameters from its schema, required first", () => {
		const result = createPiDroppedInputGuard({
			parametersFor: (name) => (name === "write" ? writeParameters : undefined),
		})({
			type: "tool_call",
			toolCallId: "call-768",
			toolName: "write",
			input: { dropped: "[dropped §768§]" },
		});

		expect(result?.reason).toContain(
			"the placeholder Magic Context shows in place of an earlier call's arguments",
		);
		expect(result?.reason).toContain(
			"its parameters: path (required), content (required), append.",
		);
	});

	it("counts consecutive refusals per session and resets on an accepted call", () => {
		const guard = createPiDroppedInputGuard();
		const refused = {
			type: "tool_call" as const,
			toolCallId: "call",
			toolName: "read",
			input: { dropped: "[dropped §770§]" },
		};

		expect(guard(refused, sessionContext("pi-a"))?.reason).not.toContain(
			"in a row",
		);
		expect(guard(refused, sessionContext("pi-a"))?.reason).toContain(
			"This is the 2nd call in a row with placeholder arguments.",
		);
		expect(guard(refused, sessionContext("pi-b"))?.reason).not.toContain(
			"in a row",
		);
		expect(
			guard(
				{ ...refused, input: { path: "README.md" } },
				sessionContext("pi-a"),
			),
		).toBeUndefined();
		expect(guard(refused, sessionContext("pi-a"))?.reason).not.toContain(
			"in a row",
		);
	});

	it("allows ordinary executable arguments", () => {
		const result = createPiDroppedInputGuard()({
			type: "tool_call",
			toolCallId: "call-clean",
			toolName: "bash",
			input: { command: "which docker" },
		});

		expect(result).toBeUndefined();
	});
});
