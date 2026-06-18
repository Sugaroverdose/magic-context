import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import { __test, TRANSFORM_DECISIONS_RETENTION } from "./transform-decision-log";

let dir: string;
let dbPath: string;
let db: Database;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-txn-decision-"));
    dbPath = join(dir, "context.db");
    db = new Database(dbPath);
    initializeDatabase(db);
    runMigrations(db);
    __test.reset();
});

afterEach(() => {
    closeQuietly(db);
    rmSync(dir, { recursive: true, force: true });
    __test.reset();
});

function baseRow(messageId: string, tsMs: number) {
    return {
        sessionId: "ses-1",
        harness: "opencode" as const,
        messageId,
        tsMs,
        decision: "execute" as const,
        materialized: true,
        materializeReason: "model_change" as const,
        emergency: false,
        droppedTokens: 0,
        droppedCount: 0,
        inputTokens: 100,
        bustedThisPass: true,
    };
}

function rowCount(): number {
    return (
        db
            .prepare(
                "SELECT COUNT(*) AS c FROM transform_decisions WHERE session_id = 'ses-1' AND harness = 'opencode'",
            )
            .get() as { c: number }
    ).c;
}

describe("transform_decisions retention cap", () => {
    it("prunes to the newest TRANSFORM_DECISIONS_RETENTION rows per (session,harness)", () => {
        // Write cap + 5 rows with strictly increasing ts and distinct message ids.
        const total = TRANSFORM_DECISIONS_RETENTION + 5;
        for (let i = 0; i < total; i++) {
            __test.writeRow(dbPath, baseRow(`msg-${i}`, 1000 + i));
        }
        expect(rowCount()).toBe(TRANSFORM_DECISIONS_RETENTION);

        // The oldest (smallest ts) must be gone; the newest must remain.
        const oldest = db
            .prepare("SELECT 1 FROM transform_decisions WHERE message_id = 'msg-0'")
            .get();
        const newest = db
            .prepare(`SELECT 1 FROM transform_decisions WHERE message_id = 'msg-${total - 1}'`)
            .get();
        expect(oldest ?? null).toBeNull();
        expect(newest ?? null).not.toBeNull();
    });

    it("does not prune below the cap", () => {
        for (let i = 0; i < 10; i++) {
            __test.writeRow(dbPath, baseRow(`m-${i}`, 1000 + i));
        }
        expect(rowCount()).toBe(10);
    });
});

describe("findNewestPiAssistantEntryIdAfter (index-aware binding)", () => {
    const asst = (id: string) => ({
        id,
        type: "message",
        message: { role: "assistant" },
    });
    const user = (id: string) => ({
        id,
        type: "message",
        message: { role: "user" },
    });

    it("binds to the first assistant AFTER the snapshot", () => {
        const entries = [asst("a1"), user("u1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "a1")).toBe("a2");
    });

    it("returns null when no assistant exists after the snapshot (no older-entry fallback)", () => {
        // Branch still ends at the snapshot — a value-skip scan would wrongly
        // return the older a1; the index-aware version must refuse.
        const entries = [asst("a1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "a2")).toBeNull();
    });

    it("refuses to bind when the snapshot id is absent (compacted/reordered)", () => {
        const entries = [asst("a1"), asst("a2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, "missing-snapshot")).toBeNull();
    });

    it("with a null snapshot, binds to the FIRST assistant (recorded when none existed)", () => {
        // Null snapshot = no assistant at record time, so the first assistant to
        // arrive is the one this decision belongs to (not the newest — that would
        // misattribute to a later pass's message if resolve lagged).
        const entries = [asst("a1"), user("u1"), asst("a2"), user("u2")];
        expect(__test.findNewestPiAssistantEntryIdAfter(entries, null)).toBe("a1");
    });
});
