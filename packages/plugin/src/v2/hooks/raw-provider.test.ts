/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import type { StoreRow } from "../store-reader";
import { createV2RawMessageProvider } from "./raw-provider";
import { rawMessages } from "./store";

/**
 * Rows in the shape the v2 store writes them. Assistant rows carry a creation
 * time; ordinary user rows do not, which is the asymmetry the generic
 * timestamp-based fallbacks cannot page over.
 */
const rows: StoreRow[] = [
    { id: "m1", session_id: "ses", seq: 0, type: "user", data: { text: "u1" } },
    {
        id: "m2",
        session_id: "ses",
        seq: 1,
        type: "assistant",
        data: { content: [{ type: "text", text: "a1" }], time: { created: 1_770_000_000_000 } },
    },
    { id: "m3", session_id: "ses", seq: 2, type: "user", data: { text: "u2" } },
    {
        id: "m4",
        session_id: "ses",
        seq: 3,
        type: "assistant",
        data: { content: [{ type: "text", text: "a2" }], time: { created: 1_770_000_001_000 } },
    },
];

const read = (): RawMessage[] => rawMessages(rows);
const provider = createV2RawMessageProvider(read);

describe("createV2RawMessageProvider", () => {
    it("pages ordinals in canonical order across the whole session", () => {
        const first = provider.readMessageOrdinalPage!(null, 2);
        expect(first.map((entry) => entry.id)).toEqual(["m1", "m2"]);
        const second = provider.readMessageOrdinalPage!(
            { timeCreated: first[1]!.timeCreated, id: first[1]!.id },
            2,
        );
        expect(second.map((entry) => entry.id)).toEqual(["m3", "m4"]);
        expect(
            provider.readMessageOrdinalPage!(
                { timeCreated: second[1]!.timeCreated, id: second[1]!.id },
                2,
            ),
        ).toEqual([]);
    });

    /**
     * Without an explicit page the registry derives one from `createdAt`, falling
     * back to the ordinal when a row has no time. Mixing epoch milliseconds with
     * small ordinals puts every untimed user row before every timed assistant row,
     * so paging past the first assistant loses the untimed rows entirely. This
     * pins that the provider's order is the conversation's order.
     */
    it("orders rows by the conversation, not by whether a row carries a timestamp", () => {
        const all = provider.readMessageOrdinalPage!(null, 100);
        expect(all.map((entry) => entry.id)).toEqual(["m1", "m2", "m3", "m4"]);
        expect(all.map((entry) => entry.timeCreated)).toEqual([1, 2, 3, 4]);
        expect(all.every((entry) => entry.contributesOrdinal)).toBe(true);
    });

    it("answers ordinal lookups from the same canonical numbering", () => {
        expect(provider.readMessageOrdinalById!("m3")).toBe(3);
        expect(provider.readMessageOrdinalById!("absent")).toBeNull();
        expect([...provider.readMessageIdOrdinals!()]).toEqual([
            ["m1", 1],
            ["m2", 2],
            ["m3", 3],
            ["m4", 4],
        ]);
    });

    it("counts every projected row, with no compaction summaries to exclude", () => {
        expect(provider.getMessageCount!()).toBe(4);
        expect(provider.getStoredMessageCount!()).toBe(4);
    });

    it("windows a message page by ordinal and watermark", () => {
        expect(provider.readMessagePage!(1, 10, 3).map((message) => message.id)).toEqual([
            "m2",
            "m3",
        ]);
        expect(provider.readMessagePage!(0, 1, 4).map((message) => message.id)).toEqual(["m1"]);
    });

    it("reads a single message and its parts by id", () => {
        expect(provider.readMessageById!("m2")?.ordinal).toBe(2);
        expect(provider.readMessagePartsById!("m4")?.parts).toEqual([{ type: "text", text: "a2" }]);
        expect(provider.readMessageById!("absent")).toBeNull();
    });
});
