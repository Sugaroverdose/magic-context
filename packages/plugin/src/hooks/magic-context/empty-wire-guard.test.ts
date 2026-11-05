/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { applyEmptyAssistantWireGuard, type GuardableMessage } from "./empty-wire-guard";

function assistant(parts: unknown[], id = "a1"): GuardableMessage {
    return { info: { id, role: "assistant" }, parts } as unknown as GuardableMessage;
}

function user(text: string, id = "u1"): GuardableMessage {
    return {
        info: { id, role: "user" },
        parts: [{ type: "text", text }],
    } as unknown as GuardableMessage;
}

describe("applyEmptyAssistantWireGuard", () => {
    it("leaves a zero-part pending shell untouched (issue #327 shape)", () => {
        const messages = [user("hi"), assistant([])];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(0);
        expect(messages.map((m) => m.info.role)).toEqual(["user", "assistant"]);
    });

    it("removes an assistant whose only parts are provider-invisible metadata", () => {
        const messages = [
            assistant([
                { type: "step-start" },
                { type: "patch", hash: "h", files: [] },
                { type: "step-finish", cost: 0, tokens: {} },
            ]),
        ];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(1);
        expect(messages).toHaveLength(0);
    });

    it("drops the empty first step block and keeps the real second block byte-identical", () => {
        const keptSecond = [
            { type: "step-start" },
            { type: "reasoning", text: "real thinking" },
            { type: "text", text: "Root cause found" },
            { type: "tool", callID: "edit_163", state: { status: "completed" } },
            { type: "step-finish", cost: 0, tokens: {} },
        ];
        const messages = [
            assistant([{ type: "step-start" }, { type: "reasoning", text: "" }, ...keptSecond]),
        ];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(0);
        expect(stats.strippedParts).toBe(2);
        expect(messages[0].parts).toEqual(keptSecond);
    });

    it("keeps a healthy single-step assistant untouched", () => {
        const healthy = [
            { type: "step-start" },
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "answer" },
            { type: "tool", callID: "bash_1", state: { status: "completed" } },
            { type: "step-finish", cost: 0, tokens: {} },
        ];
        const messages = [assistant(structuredClone(healthy))];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(0);
        expect(stats.strippedParts).toBe(0);
        expect(messages[0].parts).toEqual(healthy);
    });

    it("removes an assistant whose only content part is an empty-reasoning block", () => {
        const messages = [assistant([{ type: "reasoning", text: "" }])];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(1);
        expect(messages).toHaveLength(0);
    });

    it("removes an assistant whose only content part is an empty text block", () => {
        const messages = [assistant([{ type: "text", text: "" }])];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(1);
        expect(messages).toHaveLength(0);
    });

    it("treats file parts as provider-visible", () => {
        const messages = [
            assistant([
                { type: "step-start" },
                { type: "file", url: "file:///x.png", filename: "x.png" },
            ]),
        ];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(0);
        expect(messages[0].parts).toHaveLength(2);
    });

    it("never touches user messages", () => {
        const messages = [
            { info: { id: "u0", role: "user" }, parts: [] } as unknown as GuardableMessage,
        ];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(0);
        expect(messages).toHaveLength(1);
    });

    it("counts every removed message and stripped part across several rows", () => {
        const messages = [
            user("hi"),
            assistant([]),
            assistant([{ type: "step-start" }, { type: "reasoning", text: "" }]),
            assistant([
                { type: "step-start" },
                { type: "reasoning", text: "" },
                { type: "step-start" },
                { type: "text", text: "ok" },
            ]),
        ];
        const stats = applyEmptyAssistantWireGuard(messages);
        expect(stats.removedMessages).toBe(1);
        expect(stats.strippedParts).toBe(2);
        expect(messages.map((m) => m.info.role)).toEqual(["user", "assistant", "assistant"]);
        expect(messages[1].parts).toEqual([]);
        expect(messages[2].parts).toEqual([{ type: "step-start" }, { type: "text", text: "ok" }]);
    });
});
