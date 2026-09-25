/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ContextDatabase,
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import { getPersistedCompactionMarkerState } from "../../features/magic-context/storage-meta-persisted";
import type { RawMessage } from "../../hooks/magic-context/read-session-raw";
import {
    createV2RustCompactionMarkerStrategy,
    resolveBoundaryUserMessage,
    trimToRecordedBoundary,
} from "./boundary";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const openDatabases: ContextDatabase[] = [];

function useTempDataHome(): ContextDatabase {
    const dir = mkdtempSync(join(tmpdir(), "mc-v2-boundary-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    openDatabases.push(db);
    return db;
}

afterEach(() => {
    while (openDatabases.length > 0) closeDatabase(openDatabases.pop());
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

function raw(id: string, ordinal: number, role: "user" | "assistant"): RawMessage {
    return { id, ordinal, role, parts: [{ type: "text", text: id }] } as RawMessage;
}

/** u1 a1 u2 a2 a3 u3 a4 — ordinals 1..7. */
const history: RawMessage[] = [
    raw("u1", 1, "user"),
    raw("a1", 2, "assistant"),
    raw("u2", 3, "user"),
    raw("a2", 4, "assistant"),
    raw("a3", 5, "assistant"),
    raw("u3", 6, "user"),
    raw("a4", 7, "assistant"),
];

describe("resolveBoundaryUserMessage", () => {
    it("picks the nearest user message at or before the baseline end", () => {
        expect(resolveBoundaryUserMessage(history, "a3")?.id).toBe("u2");
        expect(resolveBoundaryUserMessage(history, "a4")?.id).toBe("u3");
    });

    it("returns the baseline end itself when it is already a user message", () => {
        expect(resolveBoundaryUserMessage(history, "u2")?.id).toBe("u2");
    });

    it("refuses a baseline end that is not in the history", () => {
        expect(resolveBoundaryUserMessage(history, "gone")).toBeNull();
    });

    it("refuses a baseline end with no user message before it", () => {
        expect(resolveBoundaryUserMessage([raw("a0", 1, "assistant")], "a0")).toBeNull();
    });
});

describe("createV2RustCompactionMarkerStrategy", () => {
    const strategy = createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
        resolveBoundaryUserMessage(history, endMessageId),
    );

    it("records the boundary in the marker columns without writing a host row", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-1");
        const outcome = strategy.applyDeferred(db, "ses-1", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        expect(outcome).toEqual({ kind: "applied", markerOrdinal: 5 });
        const state = getPersistedCompactionMarkerState(db, "ses-1");
        expect(state?.boundaryMessageId).toBe("u2");
        expect(state?.boundaryOrdinal).toBe(5);
        expect(state?.targetEndMessageId).toBe("a3");
        // No marker message or parts exist on this host, and the record says so
        // rather than inventing ids that point at nothing.
        expect(state?.summaryMessageId).toBe("");
        expect(state?.compactionPartId).toBe("");
        expect(state?.summaryPartId).toBe("");
    });

    it("advances only forward", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-2");
        strategy.applyDeferred(db, "ses-2", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        const backwards = strategy.applyDeferred(db, "ses-2", {
            ordinal: 3,
            endMessageId: "u2",
            publishedAt: Date.now(),
        });
        expect(backwards).toEqual({ kind: "already-current" });
        expect(getPersistedCompactionMarkerState(db, "ses-2")?.boundaryOrdinal).toBe(5);

        const forwards = strategy.applyDeferred(db, "ses-2", {
            ordinal: 7,
            endMessageId: "a4",
            publishedAt: Date.now(),
        });
        expect(forwards).toEqual({ kind: "applied", markerOrdinal: 7 });
        expect(getPersistedCompactionMarkerState(db, "ses-2")?.boundaryMessageId).toBe("u3");
    });

    it("keeps the previous boundary when the target no longer resolves", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-3");
        strategy.applyDeferred(db, "ses-3", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        const outcome = strategy.applyDeferred(db, "ses-3", {
            ordinal: 9,
            endMessageId: "reverted-away",
            publishedAt: Date.now(),
        });
        expect(outcome.kind).toBe("retryable-failure");
        expect(getPersistedCompactionMarkerState(db, "ses-3")?.boundaryMessageId).toBe("u2");
    });

    it("records the message an OpenCode 1 compaction row would have cut at", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-parity");
        // OpenCode 1: the host writes a compaction row at the boundary user message
        // and serves the conversation from there. OpenCode 2 has no such row, so the
        // same rule has to name the same message for the two hosts to agree on where
        // a folded session starts.
        const hostBoundary = resolveBoundaryUserMessage(history, "a3");
        expect(hostBoundary?.id).toBe("u2");
        strategy.applyDeferred(db, "ses-parity", {
            ordinal: 5,
            endMessageId: "a3",
            publishedAt: Date.now(),
        });
        expect(getPersistedCompactionMarkerState(db, "ses-parity")?.boundaryMessageId).toBe(
            hostBoundary!.id,
        );
    });
});

describe("trimToRecordedBoundary", () => {
    const strategy = createV2RustCompactionMarkerStrategy((_sessionId, endMessageId) =>
        resolveBoundaryUserMessage(history, endMessageId),
    );

    function record(db: ContextDatabase, sessionId: string, endMessageId: string): void {
        getOrCreateSessionMeta(db, sessionId);
        strategy.applyDeferred(db, sessionId, {
            ordinal: 5,
            endMessageId,
            publishedAt: Date.now(),
        });
    }

    it("drops exactly the messages before the recorded boundary", () => {
        const db = useTempDataHome();
        record(db, "ses-trim", "a3");
        const messages = history.map((message) => ({ id: message.id }));
        expect(trimToRecordedBoundary(db, "ses-trim", messages)).toBe(2);
        expect(messages.map((message) => message.id)).toEqual(["u2", "a2", "a3", "u3", "a4"]);
    });

    it("does nothing when no boundary has been recorded", () => {
        const db = useTempDataHome();
        getOrCreateSessionMeta(db, "ses-none");
        const messages = history.map((message) => ({ id: message.id }));
        expect(trimToRecordedBoundary(db, "ses-none", messages)).toBe(0);
        expect(messages).toHaveLength(history.length);
    });

    it("does nothing when the boundary is already the first message", () => {
        const db = useTempDataHome();
        record(db, "ses-head", "u1");
        const messages = history.map((message) => ({ id: message.id }));
        expect(trimToRecordedBoundary(db, "ses-head", messages)).toBe(0);
        expect(messages).toHaveLength(history.length);
    });

    it("leaves an array the host has already cut untouched", () => {
        // The host's own compaction row removes the boundary message from the array
        // before the adapter sees it. There is nothing left to drop, and guessing
        // would change what the model sees.
        const db = useTempDataHome();
        record(db, "ses-absent", "a3");
        const messages = [{ id: "u3" }, { id: "a4" }];
        expect(trimToRecordedBoundary(db, "ses-absent", messages)).toBe(0);
        expect(messages.map((message) => message.id)).toEqual(["u3", "a4"]);
    });

    it("produces the same array an OpenCode 1 compaction row would have produced", () => {
        const db = useTempDataHome();
        // OpenCode 1: the host writes a compaction row at the boundary user message
        // and serves from there, and the wire encoder then drops its injected summary
        // row. The array that reaches the module is the boundary message onward.
        const boundary = resolveBoundaryUserMessage(history, "a3");
        expect(boundary).not.toBeNull();
        const hostTrimmed = history
            .slice(history.findIndex((message) => message.id === boundary!.id))
            .map((message) => ({ id: message.id }));

        // OpenCode 2: no row exists, so the same boundary is recorded and applied here.
        record(db, "ses-parity-trim", "a3");
        const adapterTrimmed = history.map((message) => ({ id: message.id }));
        trimToRecordedBoundary(db, "ses-parity-trim", adapterTrimmed);

        expect(adapterTrimmed).toEqual(hostTrimmed);
    });
});
