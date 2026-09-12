import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import {
    computeProtectionWindow,
    getProtectionWindowForSession,
    type ProtectionWindowRow,
} from "./protection-window";
import { TAG_SELECT_COLUMNS } from "./storage-tags";

type SeedRow = { tag: number; tokens: number | null; type?: string };
const generated = (count: number): SeedRow[] =>
    Array.from({ length: count }, (_, i) => ({
        tag: i + 1,
        tokens: i % 7 === 0 ? null : i % 5 === 0 ? 0 : 100,
    }));

function compareWithReference(seeds: SeedRow[], floor: number) {
    const db = new Database(":memory:");
    try {
        // Legacy chronology can contain duplicate tag numbers; the current migration
        // adds uniqueness, so use the reader's older supported row shape for tie coverage.
        db.exec(`CREATE TABLE tags (
            id INTEGER PRIMARY KEY, session_id TEXT, message_id TEXT, type TEXT,
            status TEXT, drop_mode TEXT, tool_name TEXT, input_byte_size INTEGER DEFAULT 0,
            byte_size INTEGER, reasoning_byte_size INTEGER DEFAULT 0,
            tag_number INTEGER NOT NULL, caveman_depth INTEGER DEFAULT 0,
            tool_owner_message_id TEXT, token_count INTEGER
        ); CREATE INDEX tags_chronology ON tags(session_id, tag_number, id)`);
        const insert = db.prepare(`INSERT INTO tags
            (session_id, message_id, type, status, tag_number, token_count, byte_size,
             tool_name, tool_owner_message_id, drop_mode)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        db.transaction(() => {
            seeds.forEach((row, i) => {
                insert.run(
                    "paged",
                    `message-${i}`,
                    row.type ?? "tool",
                    i % 2 === 0 ? "dropped" : "active",
                    row.tag,
                    row.tokens,
                    i * 13,
                    "read",
                    `owner-${i}`,
                    i % 2 === 0 ? "skeleton" : null,
                );
            });
            insert.run(
                "other-session",
                "other",
                "tool",
                "active",
                999999,
                99999,
                1,
                "read",
                "other",
                null,
            );
        })();
        const allRows = db
            .prepare(`SELECT ${TAG_SELECT_COLUMNS} FROM tags
            WHERE session_id = ? AND type = 'tool' ORDER BY tag_number ASC, id ASC`)
            .all("paged") as ProtectionWindowRow[];
        const expected = computeProtectionWindow(allRows, floor);
        const actual = getProtectionWindowForSession(db, "paged", floor);
        const { isProtected: expectedPredicate, ...expectedFields } = expected;
        const { isProtected: actualPredicate, ...actualFields } = actual;
        expect(actualFields).toEqual(expectedFields);
        for (const row of allRows) expect(actualPredicate(row)).toBe(expectedPredicate(row));
        return actual;
    } finally {
        db.close();
    }
}

describe("paged protection-window differential", () => {
    it("completes a duplicate tag group across the 256-row page boundary", () => {
        const seeds = generated(27);
        for (let i = 0; i < 300; i++) seeds.push({ tag: 28, tokens: 100 });
        seeds.push({ tag: 29, tokens: 100 }, { tag: 30, tokens: 100 });
        const result = compareWithReference(seeds, 100);
        expect(result.status.protectedCount).toBe(302);
        expect(result.cutoff).toBe(28);
    });

    for (const count of [0, 1, 2, 256, 257, 20000]) {
        for (const floor of [0, 4000, count * 100 + 1]) {
            it(`matches all fields for ${count} rows at floor ${floor}`, () => {
                compareWithReference(generated(count), floor);
            });
        }
    }

    it("exhausts zero and NULL mass history with interleaved dropped rows", () => {
        compareWithReference(
            generated(600).map((row, i) => ({ ...row, tokens: i % 2 ? 0 : null })),
            4000,
        );
    });

    it("retains complete ties with fewer than three distinct tool tags", () => {
        compareWithReference(
            generated(600).map((row, i) => ({ ...row, tag: i % 2 })),
            0,
        );
    });

    it("ignores non-tool chronology and other sessions", () => {
        compareWithReference(
            generated(600).map((row, i) => ({ ...row, type: i % 3 ? "tool" : "message" })),
            4000,
        );
    });
});
