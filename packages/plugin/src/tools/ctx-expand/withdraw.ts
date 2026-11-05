/**
 * Stamp-withdraw: the ctx_expand regret-signal closure.
 *
 * A ctx_reduce stamp is a QUEUED drop (a pending_ops row) that lands on the
 * next bust cycle. When the model turns around and asks ctx_expand for
 * exactly that content, it has told us it needs it: the still-queued stamp
 * is revoked so it never lands. The revocation deletes only the row — the
 * tag, its status, and every served byte are untouched (a pre-land stamp has
 * no wire effect, so cancelling it cannot change one).
 *
 * Provenance is the queue row's `operation` column — the only record of who
 * asked: "drop" = model stamp (revocable), "auto_drop" = system actor
 * (compartment runner; NOT revocable from a tool call). Sweeper lanes
 * (tool-reclaim, supersession) hold in-memory synthetic ops, not rows, so
 * they are out of reach by construction. The vocabulary closure this filter
 * relies on is pinned by the producer-census law in withdraw.test.ts.
 *
 * Address parity comes from ONE resolver, not parallel rules: both lanes
 * consult resolveTagRender — the same code renderItemByTag runs — and
 * mirror its refusals exactly. Where the renderer serves content (including
 * the sibling message a Pi-split tool result is walked to, which the ordinal
 * lane covers through servedMessageIds), the stamp is revoked; where it
 * emits an error string (owner unknown, owner or part gone, locator
 * unresolvable — :fileN, out-of-range :pN), both lanes refuse: no row
 * deleted, no echo.
 *
 * Scope: the TypeScript transform lanes. In rust transform mode stamps are
 * queued to the module store's pending_agent_drops table (store.db), not
 * context.db, and the module ctx_expand facade never reads context.db — the
 * TS withdraw path cannot see or revoke them; withdraw is outside the
 * rust-mode contract until that lane migrates.
 *
 * Entry points: the OpenCode ctx_expand tool (tools/ctx-expand/tools.ts,
 * hosts 1.x and 2.x) calls these two functions, one per resolved target
 * slot. The Pi wrapper does not call them on this tree — the Pi ctx-reduce/
 * expand stratum is the Unit 7 mirror; when it lands, the wrapper passes its
 * harness's textIndexDomain so the resolver runs the same branch the
 * renderer runs there.
 */

import {
    type ContextDatabase,
    getPendingOps,
    getTagsByNumbers,
    removePendingOpById,
} from "../../features/magic-context/storage";
import type { PendingOp } from "../../features/magic-context/types";
import { visitRawSessionMessages } from "../../hooks/magic-context/read-session-chunk";
import { resolveTagRender, type TagRenderResolution } from "./render";

/** Rows a tool call may revoke: only the model's own stamps. */
function pendingAgentStampRows(db: ContextDatabase, sessionId: string): PendingOp[] {
    return getPendingOps(db, sessionId).filter((op) => op.operation === "drop");
}

function rowsByTag(rows: readonly PendingOp[]): Map<number, PendingOp[]> {
    const map = new Map<number, PendingOp[]>();
    for (const row of rows) {
        const existing = map.get(row.tagId);
        if (existing) existing.push(row);
        else map.set(row.tagId, [row]);
    }
    return map;
}

/** Active tags among the candidates that the renderer would actually serve,
 * mapped to their (single-run) resolution. */
function renderableActiveTags(
    db: ContextDatabase,
    sessionId: string,
    tagNumbers: readonly number[],
    textIndexDomain: "part" | "text",
): Map<number, Extract<TagRenderResolution, { ok: true }>> {
    if (tagNumbers.length === 0) return new Map();
    const live = getTagsByNumbers(db, sessionId, [...tagNumbers]).filter(
        (tag) => tag.status === "active",
    );
    const renderable = new Map<number, Extract<TagRenderResolution, { ok: true }>>();
    for (const tag of live) {
        const resolution = resolveTagRender(sessionId, tag, textIndexDomain);
        if (resolution.ok) renderable.set(tag.tagNumber, resolution);
    }
    return renderable;
}

/** Revoke the queued agent stamps on the addressed tags. Returns the tag
 * numbers actually withdrawn (request order, deduped). Tags the renderer
 * would refuse (owner unknown, owner/part gone, bad locator) are left alone. */
export function withdrawStampsForTags(
    db: ContextDatabase,
    sessionId: string,
    tagNumbers: readonly number[],
    textIndexDomain: "part" | "text" = "part",
): number[] {
    const requested = [...new Set(tagNumbers)];
    if (requested.length === 0) return [];
    const rows = pendingAgentStampRows(db, sessionId);
    if (rows.length === 0) return [];
    const byTag = rowsByTag(rows);
    const renderable = renderableActiveTags(db, sessionId, requested, textIndexDomain);
    const withdrawn: number[] = [];
    for (const tagNumber of requested) {
        if (!renderable.has(tagNumber)) continue;
        for (const row of byTag.get(tagNumber) ?? []) removePendingOpById(db, sessionId, row.id);
        withdrawn.push(tagNumber);
    }
    return withdrawn;
}

/** Revoke every queued agent stamp whose resolved message sits in
 * [fromOrdinal, toOrdinal]. Returns the ordinals actually withdrawn
 * (ascending, deduped) — the slots the response echoes. One row set is
 * revoked once: a tool tag served at two addresses (owner + walked split
 * result) withdraws at the first visited address. */
export function withdrawStampsForOrdinals(
    db: ContextDatabase,
    sessionId: string,
    fromOrdinal: number,
    toOrdinal: number,
    textIndexDomain: "part" | "text" = "part",
): number[] {
    if (toOrdinal < fromOrdinal) return [];
    const rows = pendingAgentStampRows(db, sessionId);
    if (rows.length === 0) return [];
    const byTag = rowsByTag(rows);
    const renderable = renderableActiveTags(db, sessionId, [...byTag.keys()], textIndexDomain);
    if (renderable.size === 0) return [];
    // Same resolver the renderer runs: a message address is covered when the
    // tag's served content lives at that raw message id.
    const tagsByMessageId = new Map<string, number[]>();
    for (const [tagNumber, resolution] of renderable) {
        for (const id of resolution.servedMessageIds) {
            const existing = tagsByMessageId.get(id);
            if (existing) existing.push(tagNumber);
            else tagsByMessageId.set(id, [tagNumber]);
        }
    }
    const withdrawn: number[] = [];
    const remaining = new Set(renderable.keys());
    visitRawSessionMessages(sessionId, fromOrdinal, toOrdinal, (message) => {
        const covering = tagsByMessageId.get(message.id);
        if (!covering) return true;
        let slotWithdrawn = false;
        for (const tagNumber of covering) {
            if (!remaining.has(tagNumber)) continue;
            for (const row of byTag.get(tagNumber) ?? []) {
                removePendingOpById(db, sessionId, row.id);
            }
            remaining.delete(tagNumber);
            slotWithdrawn = true;
        }
        if (slotWithdrawn) withdrawn.push(message.ordinal);
        return true;
    });
    return withdrawn;
}
