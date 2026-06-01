import { describe, expect, it } from "bun:test";
import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import {
	assistantMessage,
	assistantToolCall,
	createTestDb,
	textOf,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";
import { createPiTranscript } from "./transcript-pi";

describe("createPiTranscript", () => {
	it("round-trips Pi messages through transcript mutation and commit", () => {
		const messages = [userMessage("hello", 10), assistantMessage("world", 11)];
		const transcript = createPiTranscript(messages, "ses-transcript");

		expect(transcript.messages[0]?.parts[0]?.setText("hello tagged")).toBe(
			true,
		);
		transcript.commit();
		const output = transcript.getOutputMessages();

		// commit() now syncs mutations from `working` back into source so
		// downstream callers (e.g. `<session-history>` injection) can splice
		// or unshift on the same array Pi sent us. Output is therefore the
		// SAME reference as the source input, with mutations applied in
		// place at the dirty indices.
		expect(output).toBe(messages);
		expect(textOf(output[0] as never)).toBe("hello tagged");
		expect(textOf(output[1] as never)).toBe("world");
	});

	it("preserves source identity when there are no mutations", () => {
		const messages = [
			userMessage("unchanged", 10),
			assistantMessage("same", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		transcript.commit();

		expect(transcript.getOutputMessages()).toBe(messages);
	});

	it("injects tag prefixes into user, assistant, and folded tool-result text", () => {
		const messages = [
			userMessage("user text", 10),
			assistantMessage("assistant text", 11),
			toolResultMessage("call-1", "tool output", 12),
			userMessage("after tool", 13),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		for (const msg of transcript.messages) {
			for (const part of msg.parts) {
				const current = part.getText();
				if (current) part.setText(`§99§ ${current}`);
			}
		}
		transcript.commit();
		const output = transcript.getOutputMessages();

		expect(textOf(output[0] as never)).toBe("§99§ user text");
		expect(textOf(output[1] as never)).toBe("§99§ assistant text");
		expect(textOf(output[2] as never)).toBe("§99§ tool output");
		expect(textOf(output[3] as never)).toBe("§99§ after tool");
	});

	it("supports tag-prefix removal via part text mutation", () => {
		const messages = [
			userMessage("§1§ keep me", 10),
			assistantMessage("§2§ keep assistant", 11),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		for (const msg of transcript.messages) {
			for (const part of msg.parts) {
				part.setText((part.getText() ?? "").replace(/§\d+§\s*/g, ""));
			}
		}
		transcript.commit();
		const output = transcript.getOutputMessages();

		expect(textOf(output[0] as never)).toBe("keep me");
		expect(textOf(output[1] as never)).toBe("keep assistant");
	});

	it("preserves mixed user content shape for string and array messages", () => {
		const messages = [
			userMessage("string user", 10),
			userMessage(
				[
					{ type: "text", text: "array text" },
					{ type: "image", data: "abc", mimeType: "image/png" },
				],
				11,
			),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		transcript.messages[0]?.parts[0]?.setText("changed string");
		transcript.messages[1]?.parts[0]?.setText("changed array");
		transcript.commit();
		const output = transcript.getOutputMessages() as typeof messages;

		expect(typeof (output[0] as { content: unknown }).content).toBe("string");
		expect(Array.isArray((output[1] as { content: unknown }).content)).toBe(
			true,
		);
		expect(textOf(output[0] as never)).toBe("changed string");
		expect(textOf(output[1] as never)).toBe("changed array");
	});

	it("falls back to replacing toolCall arguments through setText", () => {
		const messages = [
			assistantToolCall("call-1", "Read", { path: "large-file.txt" }),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");
		const part = transcript.messages[0]?.parts[0];

		expect(() => part?.setToolOutput("[truncated]")).toThrow(
			"setToolOutput on assistant part",
		);
		expect(part?.setText("[truncated]")).toBe(true);
		transcript.commit();

		const output = transcript.getOutputMessages() as Array<{
			content: Array<{ type: string; arguments?: Record<string, unknown> }>;
		}>;
		expect(output[0]?.content[0]).toMatchObject({
			type: "toolCall",
			arguments: { __magic_context_replacement__: "[truncated]" },
		});
	});

	it("folds Pi toolResult messages into the following user transcript message", () => {
		const messages = [
			assistantToolCall("call-1", "Read", { path: "x" }),
			toolResultMessage("call-1", "file contents"),
			userMessage("continue", 13),
		];
		const transcript = createPiTranscript(messages, "ses-transcript");

		expect(transcript.messages).toHaveLength(2);
		expect(transcript.messages[1]?.info.role).toBe("user");
		expect(transcript.messages[1]?.parts.map((part) => part.kind)).toEqual([
			"tool_result",
			"text",
		]);
	});
	it("gives tail synthetic tool-result users a stable deterministic id", () => {
		const makeTranscriptId = () => {
			const messages = [
				assistantToolCall("call-tail", "Read", { path: "tail.txt" }, 11),
				toolResultMessage("call-tail", "tail output", 12),
			];
			const transcript = createPiTranscript(messages, "ses-transcript", [
				"entry-assistant",
				"entry-tool-result",
			]);

			return transcript.messages[1]?.info.id;
		};

		expect(makeTranscriptId()).toBe("synth-user-entry-tool-result");
		expect(makeTranscriptId()).toBe(makeTranscriptId());
	});

	it("covers image and multi-block tool results with one droppable tag", () => {
		const db = createTestDb();
		try {
			const sessionId = "ses-image-tool-result";
			const messages = [
				assistantToolCall("call-image", "Read", { path: "image.png" }, 11),
				{
					role: "toolResult",
					toolCallId: "call-image",
					toolName: "Read",
					content: [
						{ type: "image", data: "base64-image", mimeType: "image/png" },
						{ type: "text", text: "caption one" },
						{ type: "text", text: "caption two" },
					],
					isError: false,
					timestamp: 12,
				},
			];
			const tagger = createTagger();
			tagger.initFromDb(sessionId, db);
			const transcript = createPiTranscript(messages, sessionId, [
				"entry-assistant",
				"entry-tool-result",
			]);

			expect(transcript.messages[1]?.info.id).toBe(
				"synth-user-entry-tool-result",
			);
			expect(transcript.messages[1]?.parts.map((part) => part.kind)).toEqual([
				"tool_result",
				"tool_result",
				"tool_result",
			]);

			const { targets } = tagTranscript(sessionId, transcript, tagger, db);
			expect(targets.size).toBe(1);

			const target = Array.from(targets.values())[0];
			expect(target?.drop()).toBe("removed");
			transcript.commit();

			const output = transcript.getOutputMessages() as Array<{
				content?: Array<{ type: string; text?: string }>;
			}>;
			expect(output[0]?.content?.[0]).toMatchObject({
				type: "toolCall",
				arguments: { __magic_context_dropped__: "[dropped §1§]" },
			});
			expect(output[1]?.content).toEqual([
				{ type: "text", text: "[dropped §1§]" },
				{ type: "text", text: "[dropped §1§]" },
				{ type: "text", text: "[dropped §1§]" },
			]);
		} finally {
			closeQuietly(db);
		}
	});

});
