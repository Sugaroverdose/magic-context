/// <reference types="bun-types" />

/**
 * Byte pins for prefix-trim shapes that must not change when the absent-boundary
 * fallback is added: a boundary found by id, no boundary, a boundary with no
 * host store to consult, and the source-order trim. The pinned digests were
 * computed before the fallback existed, so this file imports nothing the
 * fallback introduced and can be run against either version of
 * inject-compartments.ts.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type InjectM0M1Result,
    injectM0M1,
    type PrefixTrimSourceOrder,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_prefix_trim_pure_replay";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const cleanup: Array<() => void> = [];

afterEach(() => {
    closeReadOnlySessionDb();
    for (const fn of cleanup.splice(0)) fn();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

/** An XDG_DATA_HOME with no OpenCode store in it, so no ordinal can resolve. */
function emptyDataHome(): void {
    const dir = mkdtempSync(join(tmpdir(), "mc-prefix-trim-pure-"));
    process.env.XDG_DATA_HOME = dir;
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    cleanup.push(() => closeQuietly(db));
    return db;
}

const idOf = (index: number): string => `msg_${String(index).padStart(3, "0")}`;

function liveWindow(from: number, to: number, skip: readonly number[] = []): MessageLike[] {
    const messages: MessageLike[] = [];
    for (let index = from; index <= to; index += 1) {
        if (skip.includes(index)) continue;
        messages.push({
            info: {
                id: idOf(index),
                role: index % 2 === 1 ? "user" : "assistant",
                sessionID: SESSION_ID,
            },
            parts: [{ type: "text", text: `row ${index}` }],
        });
    }
    return messages;
}

function prepared(boundary: string | undefined): InjectM0M1Result {
    return {
        injected: true,
        prependedMessageCount: 0,
        m0RematerializedThisPass: false,
        materializationContentionRetryExhausted: false,
        decision: { value: false, reason: "cache_hit" },
        m0Bytes: Buffer.from("m0"),
        m1Text: "m1",
        preparedMessages: [
            {
                info: { role: "user", sessionID: SESSION_ID },
                parts: [{ type: "text", text: "summary prefix", synthetic: true }],
            } as MessageLike,
        ],
        preparedTrimBoundaryId: boundary,
    };
}

function pass(
    db: Database,
    messages: MessageLike[],
    boundary: string | undefined,
    busting: boolean,
    sourceOrder?: PrefixTrimSourceOrder,
): string {
    const result = injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        messages,
        preparedPrefix: prepared(boundary),
        isCacheBustingPass: busting,
        prefixTrimSourceOrder: sourceOrder,
    });
    return createHash("sha256")
        .update(JSON.stringify({ status: result.prefixTrimStatus, messages }))
        .digest("hex")
        .slice(0, 16);
}

function sourceOrderOf(messages: readonly MessageLike[]): PrefixTrimSourceOrder {
    return {
        messageIds: messages.map((message) => message.info.id as string),
        syntheticHeadCount: 0,
        invalidReason: null,
    };
}

function scenarios(): Record<string, string[]> {
    emptyDataHome();
    const db = contextDb();
    const out: Record<string, string[]> = {};
    out.foundById = [
        pass(db, liveWindow(1, 20), idOf(6), true),
        pass(db, liveWindow(1, 20), idOf(6), false),
        pass(db, liveWindow(1, 21), idOf(6), false),
    ];
    out.noBoundary = [
        pass(db, liveWindow(1, 20), undefined, true),
        pass(db, liveWindow(1, 21), undefined, false),
    ];
    out.absentNoStore = [
        pass(db, liveWindow(1, 20, [6]), idOf(6), false),
        pass(db, liveWindow(1, 20, [6]), idOf(6), true),
        pass(db, liveWindow(1, 21, [6]), idOf(6), false),
    ];
    const ordered = liveWindow(1, 20);
    out.sourceOrderFound = [
        pass(db, ordered, idOf(9), true, sourceOrderOf(liveWindow(1, 20))),
        pass(db, liveWindow(1, 21), idOf(9), false, sourceOrderOf(liveWindow(1, 21))),
    ];
    out.sourceOrderInvalid = [
        pass(db, liveWindow(1, 20), idOf(9), false, {
            ...sourceOrderOf(liveWindow(1, 20)),
            invalidReason: "host reordered",
        }),
    ];
    return out;
}

describe("prefix trim shapes the absent-boundary fallback must not change", () => {
    it("serves the same bytes as before the fallback existed", () => {
        const actual = scenarios();
        if (process.env.MC_PURE_REPLAY_PRINT === "1") console.log(JSON.stringify(actual));
        expect(actual).toEqual(PINNED);
    });
});

// Computed with inject-compartments.ts from master bd8b7d5fce (before the fallback).
const PINNED: Record<string, string[]> = {
    foundById: ["e240e7397f6f9ee3", "e240e7397f6f9ee3", "9d4ad8f05834550d"],
    noBoundary: ["daa9121a6e3f22d2", "4799ab1110ffbdf5"],
    absentNoStore: ["b46ecebebfe62beb", "b46ecebebfe62beb", "84e38817a370b5b2"],
    sourceOrderFound: ["fde86711883560fc", "0ec71e798e4c1e9b"],
    sourceOrderInvalid: ["ddbde1ceead49af4"],
};
