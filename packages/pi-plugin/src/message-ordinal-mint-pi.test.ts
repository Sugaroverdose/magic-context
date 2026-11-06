import { describe, expect, it } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiOrdinalMint } from "./message-ordinal-mint-pi";

function ctxWith(entries: unknown[]): ExtensionContext {
	return {
		sessionManager: { getBranch: () => entries },
	} as unknown as ExtensionContext;
}

const ENTRIES = [
	{ type: "message", id: "msg_a", message: { role: "user", content: "start", timestamp: 1 } },
	{
		type: "message",
		id: "msg_b",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_a", name: "bash", arguments: { command: "ls" } }],
			timestamp: 2,
		},
	},
	{
		type: "message",
		id: "msg_c",
		message: { role: "toolResult", toolCallId: "call_a", toolName: "bash", content: "out", timestamp: 3 },
	},
	{ type: "message", id: "msg_d", message: { role: "user", content: "next", timestamp: 4 } },
];

describe("Pi ordinal mint", () => {
	it("assigns ordinals by branch position, matching the expand space", () => {
		const mint = createPiOrdinalMint(ctxWith(ENTRIES));
		expect(mint).toBeDefined();
		// toolResult entries fold into the next chat message: 3 raw messages.
		expect(mint!.ordinalByMessageId.get("msg_a")).toBe(1);
		expect(mint!.ordinalByMessageId.get("msg_b")).toBe(2);
		expect(mint!.ordinalByMessageId.get("msg_d")).toBe(3);
		expect(mint!.ordinalByMessageId.size).toBe(3);
	});

	it("maps wire call ids to their owner message's ordinal", () => {
		const mint = createPiOrdinalMint(ctxWith(ENTRIES));
		expect(mint?.ordinalByCallId.get("call_a")).toBe(2);
		expect(mint?.ordinalByCallId.get("call_none")).toBeUndefined();
	});

	it("reports the newest user message as the bulk boundary", () => {
		const mint = createPiOrdinalMint(ctxWith(ENTRIES));
		expect(mint?.latestUserOrdinal).toBe(3);
	});

	it("yields empty maps when the branch is unreadable", () => {
		const broken = {
			sessionManager: {
				getBranch: () => {
					throw new Error("no session");
				},
			},
		} as unknown as ExtensionContext;
		const mint = createPiOrdinalMint(broken);
		expect(mint).toBeDefined();
		expect(mint!.ordinalByMessageId.size).toBe(0);
		expect(mint!.ordinalByCallId.size).toBe(0);
		expect(mint!.latestUserOrdinal).toBeUndefined();
	});
});
