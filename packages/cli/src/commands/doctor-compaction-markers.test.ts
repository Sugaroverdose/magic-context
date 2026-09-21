import { describe, expect, it } from "bun:test";
import { Database } from "@magic-context/core/shared/sqlite";
import {
    checkOpenCodeCompactionMarkerConversion,
    formatOpenCodeCompactionMarkerConversion,
    formatOpenCodeV2ReconversionRecipe,
} from "./doctor-compaction-markers";

function convertedStoreFixture(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            time_created INTEGER,
            time_updated INTEGER,
            data TEXT NOT NULL
        );
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
        CREATE TABLE session_v2 (id TEXT PRIMARY KEY);
        CREATE TABLE session_message (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            type TEXT NOT NULL,
            seq INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    const insert = db.prepare(
        "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 'ses-1', 1, 1, ?)",
    );
    insert.run(
        "mc-summary",
        JSON.stringify({
            role: "assistant",
            parentID: "mc-boundary",
            summary: true,
            finish: "stop",
            providerID: "magic-context",
            time: { created: 101 },
        }),
    );
    insert.run(
        "native-summary",
        JSON.stringify({
            role: "assistant",
            parentID: "native-boundary",
            summary: true,
            finish: "stop",
            providerID: "openai",
            time: { created: 200, completed: 250 },
        }),
    );
    insert.run(
        "mc-non-summary",
        JSON.stringify({
            role: "assistant",
            providerID: "magic-context",
            time: { created: 300 },
        }),
    );
    db.prepare("INSERT INTO session_v2 (id) VALUES ('ses-1')").run();
    db.prepare("INSERT INTO kv (key, value) VALUES ('migration.v1-v2', ?)").run(
        JSON.stringify({ phase: "completed" }),
    );
    return db;
}

function messageData(db: Database, id: string): Record<string, unknown> {
    const row = db.prepare("SELECT data FROM message WHERE id = ?").get(id) as { data: string };
    return JSON.parse(row.data) as Record<string, unknown>;
}

describe("doctor OpenCode compaction-marker conversion check", () => {
    it("reports read-only counts, repairs only MC summaries, and detects stale v2 conversion", () => {
        const db = convertedStoreFixture();
        try {
            const before = checkOpenCodeCompactionMarkerConversion(db);
            expect(before).toEqual({
                missingBefore: 1,
                missingAfter: 1,
                repaired: 0,
                migrationCompleted: true,
                migratedV2Schema: true,
                unmatchedConvertedMarkers: 1,
                recoveryRequired: true,
            });
            expect(formatOpenCodeCompactionMarkerConversion(before)).toContain(
                "before=1 missing time.completed; after=1",
            );
            expect(messageData(db, "mc-summary")).toMatchObject({ time: { created: 101 } });

            const fixed = checkOpenCodeCompactionMarkerConversion(db, { fix: true });
            expect(fixed.missingBefore).toBe(1);
            expect(fixed.missingAfter).toBe(0);
            expect(fixed.repaired).toBe(1);
            expect(messageData(db, "mc-summary")).toMatchObject({
                time: { created: 101, completed: 101 },
            });
            expect(messageData(db, "native-summary")).toMatchObject({
                time: { created: 200, completed: 250 },
            });
            expect(messageData(db, "mc-non-summary")).toMatchObject({ time: { created: 300 } });

            db.prepare(
                "INSERT INTO session_message (id, session_id, type, seq, data) VALUES ('mc-boundary', 'ses-1', 'compaction', 0, '{}')",
            ).run();
            const converted = checkOpenCodeCompactionMarkerConversion(db);
            expect(converted.unmatchedConvertedMarkers).toBe(0);
            expect(converted.recoveryRequired).toBe(false);
        } finally {
            db.close();
        }
    });

    it("documents manual reconversion without proposing v2 table edits", () => {
        const recipe = formatOpenCodeV2ReconversionRecipe("/tmp/opencode-channel.db").join("\n");
        expect(recipe).toContain("every OpenCode host stopped");
        expect(recipe).toContain("clear only the kv.migration.v1-v2 marker");
        expect(recipe).toContain("DELETE FROM kv WHERE key = 'migration.v1-v2'");
        expect(recipe).toContain("opencode serve --port N");
        expect(recipe).toContain('{"phase":"completed"}');
        expect(recipe).toContain("note #3157");
        expect(recipe).not.toContain("INSERT INTO session_message");
    });
});
