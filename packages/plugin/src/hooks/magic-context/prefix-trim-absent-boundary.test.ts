/// <reference types="bun-types" />

/**
 * The m[0]/m[1] prefix trim when the stored compartment boundary is not in the
 * live message array.
 *
 * Reporter shape: a resumed OpenCode session whose loaded window starts after
 * the boundary, so the boundary id never appears in the live array. That is a
 * boundary that sorts before the whole window: there is nothing to cut, and the
 * trim must say so instead of refusing on every pass. A boundary that sorts
 * inside the window but whose row is missing, or a boundary that no longer
 * resolves at all, is a degraded state: it keeps serving the whole window
 * until a cache-busting pass, cuts there, and every later defer pass replays
 * that exact cut.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { getOrCreateSessionMeta } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import {
    type InjectM0M1Result,
    injectM0M1,
    resetPrefixTrimFallbackState,
} from "./inject-compartments";
import { closeReadOnlySessionDb } from "./read-session-db";
import type { MessageLike } from "./tag-messages";

const SESSION_ID = "ses_prefix_trim_absent";
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const tempDirs: string[] = [];
const openDbs: Database[] = [];

afterEach(() => {
    closeReadOnlySessionDb();
    resetPrefixTrimFallbackState(SESSION_ID);
    for (const db of openDbs.splice(0)) closeQuietly(db);
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

const idOf = (index: number): string => `msg_${String(index).padStart(3, "0")}`;
const roleOf = (index: number): "user" | "assistant" => (index % 2 === 1 ? "user" : "assistant");

/** Persist rows 1..count in OpenCode's message table, in canonical order. */
function seedOpenCodeSession(count: number): void {
    const dir = mkdtempSync(join(tmpdir(), "mc-prefix-trim-absent-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const path = join(dir, "opencode", "opencode.db");
    mkdirSync(dirname(path), { recursive: true });
    const db = new Database(path);
    try {
        db.exec(`
          CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
          CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
          );
        `);
        const insert = db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        );
        for (let index = 1; index <= count; index += 1) {
            insert.run(
                idOf(index),
                SESSION_ID,
                index * 1000,
                index * 1000,
                JSON.stringify({ id: idOf(index), role: roleOf(index), sessionID: SESSION_ID }),
            );
        }
    } finally {
        closeQuietly(db);
    }
}

function contextDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    getOrCreateSessionMeta(db, SESSION_ID);
    openDbs.push(db);
    return db;
}

function liveWindow(from: number, to: number, skip: readonly number[] = []): MessageLike[] {
    const messages: MessageLike[] = [];
    for (let index = from; index <= to; index += 1) {
        if (skip.includes(index)) continue;
        messages.push({
            info: { id: idOf(index), role: roleOf(index), sessionID: SESSION_ID },
            parts: [{ type: "text", text: `row ${index}` }],
        });
    }
    return messages;
}

function preparedPrefix(boundary: string): InjectM0M1Result {
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

function servePass(
    db: Database,
    messages: MessageLike[],
    boundary: string,
    isCacheBustingPass: boolean,
): InjectM0M1Result {
    return injectM0M1({
        db,
        sessionId: SESSION_ID,
        state: getOrCreateSessionMeta(db, SESSION_ID),
        messages,
        preparedPrefix: preparedPrefix(boundary),
        isCacheBustingPass,
    });
}

const ids = (messages: readonly MessageLike[]): Array<string | undefined> =>
    messages.map((message) => message.info.id);
const sha = (messages: readonly MessageLike[]): string =>
    createHash("sha256").update(JSON.stringify(messages)).digest("hex");

describe("prefix trim with a boundary absent from the live window", () => {
    it("treats a resumed window that starts after the boundary as nothing to cut, on every pass", () => {
        // 40 persisted rows; the boundary is row 12; the resumed host window
        // holds only rows 25..40.
        seedOpenCodeSession(40);
        const db = contextDb();
        const boundary = idOf(12);

        const priced = liveWindow(25, 40);
        const pricedResult = servePass(db, priced, boundary, true);
        expect(pricedResult.prefixTrimStatus).toBe("boundary-precedes-window");
        expect(ids(priced)).toEqual([undefined, ...ids(liveWindow(25, 40))]);

        // Priced -> defer: the defer pass over the same window replays the
        // priced bytes exactly.
        const deferSame = liveWindow(25, 40);
        const deferResult = servePass(db, deferSame, boundary, false);
        expect(deferResult.prefixTrimStatus).toBe("boundary-precedes-window");
        expect(sha(deferSame)).toBe(sha(priced));

        // A later defer pass with one more turn keeps the priced bytes as its
        // prefix and only appends.
        seedAppend(41);
        const deferGrown = liveWindow(25, 41);
        servePass(db, deferGrown, boundary, false);
        expect(sha(deferGrown.slice(0, priced.length))).toBe(sha(priced));
        expect(deferGrown).toHaveLength(priced.length + 1);
    });

    it("keeps serving the whole window on defer passes until a busting pass cuts at the boundary's ordinal", () => {
        // The boundary row 12 sorts inside the window (rows 5..30) but is not
        // in the live array.
        seedOpenCodeSession(30);
        const db = contextDb();
        const boundary = idOf(12);

        const deferBefore = liveWindow(5, 30, [12]);
        const deferBeforeResult = servePass(db, deferBefore, boundary, false);
        expect(deferBeforeResult.prefixTrimStatus).toBe("refused");
        expect(ids(deferBefore)).toEqual([undefined, ...ids(liveWindow(5, 30, [12]))]);

        const priced = liveWindow(5, 30, [12]);
        const pricedResult = servePass(db, priced, boundary, true);
        expect(pricedResult.prefixTrimStatus).toBe("applied-by-ordinal");
        expect(ids(priced)).toEqual([undefined, ...ids(liveWindow(13, 30))]);

        const deferAfter = liveWindow(5, 30, [12]);
        const deferAfterResult = servePass(db, deferAfter, boundary, false);
        expect(deferAfterResult.prefixTrimStatus).toBe("applied-by-ordinal");
        expect(sha(deferAfter)).toBe(sha(priced));
    });

    it("re-anchors a boundary that no longer resolves at the newest older compartment that does", () => {
        seedOpenCodeSession(30);
        const db = contextDb();
        appendCompartments(db, SESSION_ID, [
            {
                sequence: 1,
                startMessage: 1,
                endMessage: 8,
                startMessageId: idOf(1),
                endMessageId: idOf(8),
                title: "first",
                content: "first",
            },
            {
                sequence: 2,
                startMessage: 9,
                endMessage: 14,
                startMessageId: idOf(9),
                endMessageId: "msg_deleted_boundary",
                title: "second",
                content: "second",
            },
        ]);
        const boundary = "msg_deleted_boundary";

        const deferBefore = liveWindow(1, 30);
        expect(servePass(db, deferBefore, boundary, false).prefixTrimStatus).toBe("refused");
        expect(deferBefore).toHaveLength(31);

        const priced = liveWindow(1, 30);
        expect(servePass(db, priced, boundary, true).prefixTrimStatus).toBe("applied-by-ordinal");
        expect(ids(priced)).toEqual([undefined, ...ids(liveWindow(9, 30))]);

        const deferAfter = liveWindow(1, 30);
        expect(servePass(db, deferAfter, boundary, false).prefixTrimStatus).toBe(
            "applied-by-ordinal",
        );
        expect(sha(deferAfter)).toBe(sha(priced));
    });

    it("still refuses, without cutting, when nothing gives a cut coordinate", () => {
        seedOpenCodeSession(20);
        const db = contextDb();
        const boundary = "msg_never_persisted";

        for (const busting of [false, true, false]) {
            const live = liveWindow(1, 20);
            expect(servePass(db, live, boundary, busting).prefixTrimStatus).toBe("refused");
            expect(ids(live)).toEqual([undefined, ...ids(liveWindow(1, 20))]);
        }
    });

    it("does not change a trim whose boundary is in the live array", () => {
        seedOpenCodeSession(20);
        const db = contextDb();
        const live = liveWindow(1, 20);
        expect(servePass(db, live, idOf(6), false).prefixTrimStatus).toBe("applied");
        expect(ids(live)).toEqual([undefined, ...ids(liveWindow(7, 20))]);
    });
});

function seedAppend(index: number): void {
    const path = join(process.env.XDG_DATA_HOME!, "opencode", "opencode.db");
    closeReadOnlySessionDb();
    const db = new Database(path);
    try {
        db.prepare(
            "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
        ).run(
            idOf(index),
            SESSION_ID,
            index * 1000,
            index * 1000,
            JSON.stringify({ id: idOf(index), role: roleOf(index), sessionID: SESSION_ID }),
        );
    } finally {
        closeQuietly(db);
    }
}
