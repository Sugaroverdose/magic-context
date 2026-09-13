/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { RAW_MESSAGE_PARTS_BY_ID_SQL } from "./read-session-raw";

const IDS = Array.from({ length: 100 }, (_, index) => `m${index}`);
const PLACEHOLDERS = IDS.map(() => "?").join(", ");

type QueryCase = {
    name: string;
    sql: string;
    args: unknown[];
};

const bundledReaderQueries: QueryCase[] = [
    {
        name: "readRawSessionMessagesFromDb",
        sql: `SELECT message_id, data, time_updated
              FROM part
              WHERE +session_id = ?
                AND likelihood(message_id IN (${PLACEHOLDERS}), 0.000001)
              ORDER BY message_id ASC, time_created ASC, id ASC`,
        args: ["session", ...IDS],
    },
    {
        name: "readRawSessionMessagePageFromDb",
        sql: `SELECT message_id, data, time_updated
              FROM part
              WHERE +session_id = ?
                AND likelihood(message_id IN (${PLACEHOLDERS}), 0.000001)
              ORDER BY message_id ASC, time_created ASC, id ASC`,
        args: ["session", ...IDS],
    },
    {
        name: "readRawSessionTailFromDb",
        sql: `SELECT message_id, data, time_updated FROM part WHERE +session_id = ? AND likelihood(message_id IN (${PLACEHOLDERS}), 0.000001) ORDER BY time_created ASC, id ASC`,
        args: ["session", ...IDS],
    },
    {
        name: "normalizeOpenCodeRows",
        sql: `SELECT message_id, data
              FROM part
              WHERE +session_id = ?
                AND likelihood(message_id IN (${PLACEHOLDERS}), 0.000001)
              ORDER BY time_created ASC, id ASC`,
        args: ["session", ...IDS],
    },
];

function createStockPartDb(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX message_session_time_created_id_idx
            ON message(session_id, time_created, id);
        CREATE TABLE part (
            id TEXT PRIMARY KEY,
            message_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            time_created INTEGER NOT NULL,
            time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE INDEX part_session_idx ON part(session_id);
        CREATE INDEX part_message_id_id_idx ON part(message_id, id);
    `);
    const insertMessage = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
    const insert = db.prepare("INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)");
    for (let index = 0; index < 300; index += 1) {
        insertMessage.run(`m${index}`, "session", index, index, JSON.stringify({ role: "user" }));
        for (let part = 0; part < 4; part += 1) {
            insert.run(`p${index}-${part}`, `m${index}`, "session", index, index, "{}");
        }
    }
    insert.run("cross-session", "m0", "other", 0, 0, "{}");
    return db;
}

function explain(db: Database, query: QueryCase): string[] {
    return (
        db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args) as Array<{
            detail: string;
        }>
    ).map((row) => row.detail);
}

function installAdversarialStats(db: Database): void {
    db.exec(`
        ANALYZE;
        UPDATE sqlite_stat1 SET stat = '1201 1' WHERE idx = 'part_session_idx';
        UPDATE sqlite_stat1 SET stat = '1201 1201 1' WHERE idx = 'part_message_id_id_idx';
        ANALYZE sqlite_schema;
    `);
}

function expectTargetedPlan(details: string[]): void {
    expect(details.join(" | ")).toContain("part_message_id_id_idx");
    expect(details.join(" | ")).not.toContain("part_session_idx");
}

describe("OpenCode stock part query plans", () => {
    for (const query of bundledReaderQueries) {
        it(`${query.name} uses message-id lookups without or with adversarial sqlite_stat1`, () => {
            const db = createStockPartDb();
            try {
                const absent = explain(db, query);
                console.log(
                    `[opencode-query-plan] ${query.name} sqlite_stat1=absent: ${absent.join(" | ")}`,
                );
                expectTargetedPlan(absent);

                const originalSql = query.sql.replace("+session_id", "session_id");
                const originalRows = db.prepare(originalSql).all(...query.args);
                const correctedRows = db.prepare(query.sql).all(...query.args);
                expect(correctedRows).toEqual(originalRows);
                expect(correctedRows).toHaveLength(400);

                installAdversarialStats(db);
                const adversarial = explain(db, query);
                console.log(
                    `[opencode-query-plan] ${query.name} sqlite_stat1=adversarial: ${adversarial.join(" | ")}`,
                );
                expectTargetedPlan(adversarial);
            } finally {
                closeQuietly(db);
            }
        });
    }

    it("single-message readers use the message-id index and retain the text session filter", () => {
        const db = createStockPartDb();
        try {
            for (const query of [
                {
                    name: "RAW_MESSAGE_PARTS_BY_ID_SQL",
                    sql: RAW_MESSAGE_PARTS_BY_ID_SQL,
                    args: ["session", "m0"],
                },
                {
                    name: "assistantAwaitingToolsFromOpenCodeDb",
                    sql: "SELECT data FROM part WHERE +session_id = ? AND likelihood(message_id = ?, 0.000001)",
                    args: ["session", "m0"],
                },
            ]) {
                expectTargetedPlan(explain(db, query));
                expect(db.prepare(query.sql).all(...query.args)).toHaveLength(4);
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("other bounded part statements never select the session-only index", () => {
        const db = createStockPartDb();
        try {
            const statements: QueryCase[] = [
                {
                    name: "remove marker summary parts",
                    sql: "DELETE FROM part WHERE +session_id = ? AND message_id = ?",
                    args: ["session", "m0"],
                },
                {
                    name: "legacy summary ownership probe",
                    sql: `SELECT m.id FROM message m
                          WHERE m.session_id = ? AND EXISTS (
                              SELECT 1 FROM part p
                              WHERE +p.session_id = m.session_id
                                AND p.message_id = m.id
                                AND COALESCE(json_extract(p.data, '$.type'), '') = 'text'
                          )`,
                    args: ["session"],
                },
                {
                    name: "readRawSeedTailFromDb part join",
                    sql: `WITH canonical AS (
                              SELECT id, time_created,
                                     ROW_NUMBER() OVER (ORDER BY time_created, id) AS ordinal
                              FROM message WHERE session_id = ?
                          )
                          SELECT c.id, p.data
                          FROM canonical c
                          LEFT JOIN part p
                            ON +p.session_id = ? AND likelihood(p.message_id = c.id, 0.000001)
                          ORDER BY c.ordinal, p.time_created, p.id`,
                    args: ["session", "session"],
                },
            ];
            for (const statement of statements) {
                const details = explain(db, statement);
                expect(details.join(" | ")).not.toContain("part_session_idx");
                expect(details.join(" | ")).toContain("part_message_id_id_idx");
            }
        } finally {
            closeQuietly(db);
        }
    });

    it("compaction marker part pages are targeted and exclude cross-session rows", () => {
        const db = createStockPartDb();
        try {
            db.prepare("UPDATE part SET data = ? WHERE message_id = ?").run(
                JSON.stringify({ type: "compaction" }),
                "m0",
            );
            const query: QueryCase = {
                name: "listSessionCompactionMarkers",
                sql: `SELECT id, message_id, time_created
                      FROM part
                      WHERE +session_id = ?
                        AND likelihood(message_id IN (${PLACEHOLDERS}), 0.000001)
                        AND COALESCE(json_extract(data, '$.type'), '') = 'compaction'
                      ORDER BY time_created ASC, id ASC`,
                args: ["session", ...IDS],
            };
            expectTargetedPlan(explain(db, query));
            expect(db.prepare(query.sql).all(...query.args)).toHaveLength(4);
            installAdversarialStats(db);
            expectTargetedPlan(explain(db, query));
        } finally {
            closeQuietly(db);
        }
    });
});
