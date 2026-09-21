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
import { createV2RustCompactionMarkerStrategy, resolveBoundaryUserMessage } from "./boundary";

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
    const strategy = createV2RustCompactionMarkerStrategy(() => history);

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
