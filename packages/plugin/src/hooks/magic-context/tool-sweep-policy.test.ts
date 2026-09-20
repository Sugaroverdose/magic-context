import { expect, test } from "bun:test";
import { stripReasoningFromMergedAssistants } from "./strip-content";
import type { MessageLike } from "./tag-messages";
import { ToolMutationBatch } from "./tool-drop-target";
import { TOOL_SWEEP_SCOPED_MARKER } from "./tool-sweep-policy";

test("legacy merged-reasoning reader ignores the scoped-sweep control entry", () => {
    expect(TOOL_SWEEP_SCOPED_MARKER).toBe("@tool-sweep-scoped");
    const messages: MessageLike[] = [
        { info: { id: "first", role: "assistant" }, parts: [{ type: "text", text: "first" }] },
        {
            info: { id: "second", role: "assistant" },
            parts: [{ type: "reasoning", text: "signed thinking" }],
        },
    ];
    const before = structuredClone(messages);
    // The unchanged reader treats unknown entries as message IDs. A reserved
    // control entry must not match any real assistant or select its reasoning.
    expect(
        stripReasoningFromMergedAssistants(messages, "anthropic", {
            frozenMessageIds: new Set([TOOL_SWEEP_SCOPED_MARKER]),
        }),
    ).toBe(0);
    expect(messages).toEqual(before);
});

test("scoped batch removes its empty owner but leaves unrelated reasoning and blank shells", () => {
    const tool = { type: "tool", callID: "call", state: { status: "completed", output: "spent" } };
    const owner: MessageLike = { info: { id: "owner", role: "assistant" }, parts: [tool] };
    const thinking: MessageLike = {
        info: { id: "thinking", role: "assistant" },
        parts: [{ type: "reasoning", text: "signed thinking" }],
    };
    const blank: MessageLike = {
        info: { id: "blank", role: "assistant" },
        parts: [{ type: "text", text: "" }],
    };
    const messages = [owner, thinking, blank];
    const batch = new ToolMutationBatch(messages, true);
    batch.markForRemoval({ message: owner, part: tool, kind: "result" });
    batch.finalize();
    expect(messages).toEqual([thinking, blank]);
});

test("scoped gate mixed owner retains surviving text while full owner is spliced", () => {
    const tool = () => ({ type: "tool", callID: "call", state: { status: "completed", output: "spent" } });
    const full: MessageLike = { info: { id: "full", role: "assistant" }, parts: [tool()] };
    const mixed: MessageLike = { info: { id: "mixed", role: "assistant" }, parts: [tool(), { type: "text", text: "survivor" }] };
    const messages = [full, mixed];
    const batch = new ToolMutationBatch(messages, true);
    for (const message of messages) batch.markForRemoval({ message, part: message.parts[0], kind: "result" });
    batch.finalize();
    expect(messages).toEqual([mixed]);
    expect(mixed.parts).toEqual([{ type: "text", text: "survivor" }]);
    console.log("SCOPED_GATE full owner spliced; mixed owner survives");
});
