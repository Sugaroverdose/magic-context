/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    closeDatabase,
    insertTag,
    openDatabase,
    queuePendingOp,
} from "../../features/magic-context/storage";
import { buildSupersessionReclaimOps } from "./supersession-reclaim";
import type { TagTarget } from "./tag-messages";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        try {
            rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
            /* ignore */
        }
    }
    tempDirs.length = 0;
});

function freshDb(): ReturnType<typeof openDatabase> & object {
    const dir = mkdtempSync(join(tmpdir(), "supersession-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase();
    if (!db) throw new Error("db open failed");
    return db as ReturnType<typeof openDatabase> & object;
}

const SES = "ses-1";

/** A droppable tool target; optional input for ctx_note action reads. */
function target(input?: Record<string, unknown>): TagTarget {
    return {
        setContent: () => true,
        drop: () => "removed",
        truncate: () => "truncated",
        canDrop: () => true,
        readInput: () => input ?? null,
    };
}

/** A target whose drop would reclaim nothing (absent/incomplete on this pass). */
function noDropTarget(): TagTarget {
    return { setContent: () => false, canDrop: () => false };
}

function ids(ops: ReturnType<typeof buildSupersessionReclaimOps>): number[] {
    return ops.map((o) => o.tagId).sort((a, b) => a - b);
}

describe("buildSupersessionReclaimOps", () => {
    it("keeps newest 1 todowrite, drops older ones", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 100, 1, 0, "todowrite");
        insertTag(db, SES, "c2", "tool", 100, 2, 0, "todowrite");
        insertTag(db, SES, "c3", "tool", 100, 3, 0, "todowrite");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
            [3, target()],
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        // newest (3) kept; 1 and 2 dropped.
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("keeps newest 5 ctx_reduce, drops older ones", () => {
        const db = freshDb();
        const targets = new Map<number, TagTarget>();
        for (let n = 1; n <= 7; n += 1) {
            insertTag(db, SES, `c${n}`, "tool", 40, n, 0, "ctx_reduce");
            targets.set(n, target());
        }
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        // newest 5 (3..7) kept; 1 and 2 dropped.
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("drops all zero-value meta (bash_status / bash_kill)", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 30, 1, 0, "bash_status");
        insertTag(db, SES, "c2", "tool", 30, 2, 0, "bash_kill");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("drops ctx_note read/dismiss but never write/update; unreadable action is safe", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 50, 1, 0, "ctx_note");
        insertTag(db, SES, "c2", "tool", 50, 2, 0, "ctx_note");
        insertTag(db, SES, "c3", "tool", 50, 3, 0, "ctx_note");
        insertTag(db, SES, "c4", "tool", 50, 4, 0, "ctx_note");
        const targets = new Map<number, TagTarget>([
            [1, target({ action: "read" })],
            [2, target({ action: "dismiss" })],
            [3, target({ action: "write" })], // intent — never dropped
            [4, target(undefined)], // unreadable action — fail safe
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        expect(ids(ops)).toEqual([1, 2]);
    });

    it("never targets non-superseded tools (read/grep/edit untouched)", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 800, 1, 0, "read");
        insertTag(db, SES, "c2", "tool", 800, 2, 0, "grep");
        insertTag(db, SES, "c3", "tool", 800, 3, 0, "edit");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
            [3, target()],
        ]);
        const ops = buildSupersessionReclaimOps({ db, sessionId: SES, targets });
        expect(ops).toHaveLength(0);
    });

    it("excludes tags already in pendingOps and tags that cannot reclaim", () => {
        const db = freshDb();
        insertTag(db, SES, "c1", "tool", 30, 1, 0, "bash_status");
        insertTag(db, SES, "c2", "tool", 30, 2, 0, "bash_status");
        insertTag(db, SES, "c3", "tool", 30, 3, 0, "bash_status");
        queuePendingOp(db, SES, 2, "drop");
        const targets = new Map<number, TagTarget>([
            [1, target()],
            [2, target()],
            [3, noDropTarget()], // would reclaim nothing
        ]);
        const ops = buildSupersessionReclaimOps({
            db,
            sessionId: SES,
            targets,
            pendingOps: [{ id: 1, sessionId: SES, tagId: 2, operation: "drop", queuedAt: 0 }],
        });
        // 2 already pending, 3 not droppable → only 1.
        expect(ids(ops)).toEqual([1]);
    });
});
