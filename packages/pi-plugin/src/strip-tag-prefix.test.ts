import { describe, expect, it } from "bun:test";
import { prependTag } from "@magic-context/core/hooks/magic-context/tag-content-primitives";
import { stripTagPrefixFromAssistantMessage } from "./strip-tag-prefix";

/**
 * ctx_reduce v1 ruling: the plugin never cuts tag notation out of persisted
 * content. `§N§` is no longer primed as plugin behavior, so nothing
 * legitimate puts it into persisted text; what is already there (legacy
 * materialization, model prose) is inert residue and the model's bytes
 * persist verbatim. This suite pins the PRESERVATION contract: every
 * notation shape, on every role, is byte-identical after the call, and the
 * seam reports no mutation.
 */
describe("stripTagPrefixFromAssistantMessage (no-strip ruling)", () => {
	const NOTATIONS: Array<[string, string]> = [
		["leading §N§ prefix (canonical MC tagger mimicry)", "§4§ Yes. I can see the magic context."],
		["consecutive §N§ prefixes", "§3§ §4§ §5§ Hello world"],
		["trailing whitespace after the prefix", "§4§   \n\nYes"],
		["multi-digit tag IDs", "§38773§ Found it."],
		["mid-text §N§ pair", "Looking at §5§ which references the earlier discussion"],
		['malformed §N"> hybrid', `Hello §40827">Oracle confirmed`],
		["stray § character", "See § marker for details"],
		["leading prefix and mid-text § together", "§42§ The pattern §40827§ appeared."],
	];

	for (const [label, text] of NOTATIONS) {
		it(`preserves ${label} verbatim on assistant text`, () => {
			const msg = { role: "assistant", content: [{ type: "text", text }] };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(text);
		});
	}

	describe("scope guards", () => {
		it("preserves notation on user messages", () => {
			const msg = {
				role: "user",
				content: [{ type: "text", text: "§4§ Hello from user" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"§4§ Hello from user",
			);
		});

		it("preserves notation on tool result messages", () => {
			const msg = {
				role: "toolResult",
				content: [{ type: "text", text: "§7§ tool output" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("preserves notation across multiple text parts in a single message", () => {
			const msg = {
				role: "assistant",
				content: [
					{ type: "text", text: "§4§ First chunk" },
					{ type: "text", text: "§4§ Second chunk" },
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect((msg.content[0] as { type: string; text: string }).text).toBe(
				"§4§ First chunk",
			);
			expect((msg.content[1] as { type: string; text: string }).text).toBe(
				"§4§ Second chunk",
			);
		});

		it("ignores non-text parts (thinking, toolCall, image)", () => {
			const msg = {
				role: "assistant",
				content: [
					{
						type: "thinking",
						thinking: "§4§ pretend reasoning, not stripped",
					},
					{ type: "text", text: "§4§ Real assistant text" },
					{
						type: "toolCall",
						id: "t1",
						name: "ctx_search",
						arguments: {},
					},
				],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect((msg.content[1] as { type: string; text: string }).text).toBe(
				"§4§ Real assistant text",
			);
			expect(
				(msg.content[0] as { type: string; thinking: string }).thinking,
			).toBe("§4§ pretend reasoning, not stripped");
		});
	});

	describe("no-op cases", () => {
		it("returns false when no text parts have any §", () => {
			const msg = {
				role: "assistant",
				content: [{ type: "text", text: "Plain response without any prefix" }],
			};
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("handles empty content array gracefully", () => {
			const msg = { role: "assistant", content: [] };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
		});

		it("handles non-array content gracefully", () => {
			// Pi user messages can have content: string (legacy shape)
			const msg = { role: "assistant", content: "§4§ legacy string" };
			expect(stripTagPrefixFromAssistantMessage(msg)).toBe(false);
			expect(msg.content).toBe("§4§ legacy string");
		});
	});
});

it("leading self-tag bytes persist byte-identically through Pi storage and replay", () => {
	const reply =
		"§12§ Reading both files in parallel.\n\nThe next step follows.";
	const part = { type: "text", text: reply };
	const message = { role: "assistant", content: [part] };
	expect(stripTagPrefixFromAssistantMessage(message)).toBe(false);
	expect(part.text).toBe(reply);
	expect(prependTag(12, part.text.slice("§12§ ".length))).toBe(reply);
});
