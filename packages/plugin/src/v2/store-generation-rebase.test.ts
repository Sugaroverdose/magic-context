import { expect, test } from "bun:test";
import { rawMessages } from "./hooks/store";
import type { StoreRow } from "./store-reader";

/**
 * When an OpenCode 2 host imports a 1.x store it re-projects the conversation:
 * a user turn carrying both ordinary and synthetic text becomes two rows, and a
 * completed compaction pair becomes one row that the raw projection does not
 * count at all. Message ids survive, but the positional ordinals Magic Context
 * saved against the 1.x projection do not, so a compartment's saved end ordinal
 * stops pointing at its saved endpoint message.
 *
 * The rows below are exactly what `@opencode/cli@2.0.5` wrote into
 * `session_message` when it converted a synthetic 1.x store in a throwaway root;
 * the "before" ordinals are what MC's 1.x reader produced from the same store
 * before conversion. Full transcript, coordinate inventory and the proposed
 * rebase design: `.cortexkit/alfonso/reviews/issue-492-migration.md`.
 *
 * These tests are SKIPPED because the rebase they describe does not exist yet:
 * nothing re-derives a saved ordinal from its surviving endpoint id when the
 * store generation flips, so both assertions fail today. Unskip them with the
 * fix; do not weaken them.
 */

/** Post-conversion rows for a session whose third turn carried a synthetic part. */
const syntheticSplit: StoreRow[] = [
    { id: "msg_a_001_u1", session_id: "ses_a", seq: 0, type: "user", data: { text: "u1" } },
    {
        id: "msg_a_002_a1",
        session_id: "ses_a",
        seq: 1,
        type: "assistant",
        data: { content: [{ type: "text", text: "a1" }] },
    },
    { id: "msg_a_003_u2", session_id: "ses_a", seq: 2, type: "user", data: { text: "u2" } },
    {
        // Host-derived id: first 16 characters of the source id plus a base62
        // digest of "v1-synthetic:<source id>".
        id: "msg_a_003_u2yFU0Vz0z1d7sEV",
        session_id: "ses_a",
        seq: 3,
        type: "synthetic",
        data: { text: "<system-reminder>synthetic environment note</system-reminder>" },
    },
    {
        id: "msg_a_004_a2",
        session_id: "ses_a",
        seq: 4,
        type: "assistant",
        data: { content: [{ type: "text", text: "a2" }] },
    },
    { id: "msg_a_005_u3", session_id: "ses_a", seq: 5, type: "user", data: { text: "u3" } },
    {
        id: "msg_a_006_a3",
        session_id: "ses_a",
        seq: 6,
        type: "assistant",
        data: { content: [{ type: "text", text: "a3" }] },
    },
];

/** Post-conversion rows for a session whose compaction pair became one record. */
const compactionPair: StoreRow[] = [
    { id: "msg_b_001_u1", session_id: "ses_b", seq: 0, type: "user", data: { text: "u1" } },
    {
        id: "msg_b_002_a1",
        session_id: "ses_b",
        seq: 1,
        type: "assistant",
        data: { content: [{ type: "text", text: "a1" }] },
    },
    {
        id: "msg_b_003_cu",
        session_id: "ses_b",
        seq: 2,
        type: "compaction",
        data: { status: "completed", summary: "earlier turns condensed" },
    },
    { id: "msg_b_005_u2", session_id: "ses_b", seq: 3, type: "user", data: { text: "u2" } },
    {
        id: "msg_b_006_a2",
        session_id: "ses_b",
        seq: 4,
        type: "assistant",
        data: { content: [{ type: "text", text: "a2" }] },
    },
    { id: "msg_b_007_u3", session_id: "ses_b", seq: 5, type: "user", data: { text: "u3" } },
];

/**
 * Stand-in for the missing rebase: re-derive a saved ordinal from the endpoint
 * id that survived the conversion. Returns null when the endpoint no longer
 * exists, which a real implementation must surface as "unresolvable" rather
 * than guess a neighbouring ordinal.
 */
function rebasedEndOrdinal(rows: StoreRow[], endMessageId: string): number | null {
    return rawMessages(rows).find((message) => message.id === endMessageId)?.ordinal ?? null;
}

test.skip("a saved compartment end still selects its endpoint after a synthetic split", () => {
    // Saved against the 1.x projection: end=4, endpoint msg_a_004_a2 at ordinal 4.
    const savedEnd = 4;
    const savedEndpointId = "msg_a_004_a2";
    const selected = rawMessages(syntheticSplit).filter((message) => message.ordinal <= savedEnd);

    expect(rebasedEndOrdinal(syntheticSplit, savedEndpointId)).toBe(savedEnd);
    expect(selected.map((message) => message.id)).toContain(savedEndpointId);
});

test.skip("a saved compartment end excludes messages that were outside it before conversion", () => {
    // Saved against the 1.x projection: end=5, endpoint msg_b_006_a2 at ordinal 5.
    // msg_b_007_u3 was ordinal 6 there, i.e. outside the compartment.
    const savedEnd = 5;
    const savedEndpointId = "msg_b_006_a2";
    const selected = rawMessages(compactionPair).filter((message) => message.ordinal <= savedEnd);

    expect(rebasedEndOrdinal(compactionPair, savedEndpointId)).toBe(savedEnd);
    expect(selected.map((message) => message.id)).not.toContain("msg_b_007_u3");
});
