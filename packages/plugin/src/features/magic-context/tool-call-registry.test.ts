import { describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { createRegistryCallIdResolver, enrichReclaimHintsWithCallIds } from "./tool-call-registry";

const SESSION = "ses_registry";

function world() {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT, message_id TEXT, type TEXT, status TEXT,
            tag_number INTEGER, tool_owner_message_id TEXT
        );
    `);
    const insert = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, tag_number) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(SESSION, "call_a", "tool", "active", 1);
    insert.run(SESSION, "call_b", "tool", "dropped", 2);
    insert.run(SESSION, "msg_1:p0", "message", "active", 3);
    insert.run("ses_other", "call_z", "tool", "active", 4);
    return db;
}

describe("registry call-id resolver", () => {
    it("resolves seeded ids and reports unknowns as undefined", () => {
        const resolver = createRegistryCallIdResolver(world(), SESSION);
        const map = resolver.resolve(["call_a", "call_b", "nope-1"]);
        expect(map.get("call_a")?.tag_number).toBe(1);
        expect(map.get("call_b")?.tag_number).toBe(2);
        expect(map.get("nope-1")).toBeUndefined();
    });

    it("never crosses sessions and never keys on message rows", () => {
        const resolver = createRegistryCallIdResolver(world(), SESSION);
        expect(resolver.resolve(["call_z"]).get("call_z")).toBeUndefined();
        expect(resolver.resolve(["msg_1:p0"]).get("msg_1:p0")).toBeUndefined();
    });

    it("dedupes repeated ids in one batch", () => {
        const resolver = createRegistryCallIdResolver(world(), SESSION);
        const map = resolver.resolve(["call_a", "call_a"]);
        expect(map.size).toBe(1);
        expect(map.get("call_a")?.tag_number).toBe(1);
    });

    it("flags a reused call id with two visible occurrences instead of preferring", () => {
        const db = world();
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, tag_number) VALUES (?, ?, ?, ?, ?)",
        ).run(SESSION, "call_b", "tool", "active", 9);
        const row = createRegistryCallIdResolver(db, SESSION).resolve(["call_b"]).get("call_b");
        expect(row?.ambiguous).toBe(true);
    });

    it("resolves the visible occurrence when the reused twin is compacted", () => {
        const db = world();
        db.prepare(
            "INSERT INTO tags (session_id, message_id, type, status, tag_number) VALUES (?, ?, ?, ?, ?)",
        ).run(SESSION, "call_b", "tool", "compacted", 9);
        const row = createRegistryCallIdResolver(db, SESSION).resolve(["call_b"]).get("call_b");
        expect(row?.ambiguous).toBeUndefined();
        expect(row?.tag_number).toBe(2);
    });
});

describe("reclaim-hint enrichment", () => {
    it("attaches the registry's wire call id, keeps set ids, leaves tagless hints", () => {
        const db = world();
        const hints = [
            { tagNumber: 2 },
            { tagNumber: 1, callId: "call_pre" },
            { tagNumber: 3 },
            { tagNumber: 404 },
        ];
        const enriched = enrichReclaimHintsWithCallIds(db, SESSION, hints);
        expect(enriched[0]?.callId).toBe("call_b");
        expect(enriched[1]?.callId).toBe("call_pre");
        expect(enriched[2]?.callId).toBeUndefined();
        expect(enriched[3]?.callId).toBeUndefined();
    });

    it("empty hints return empty", () => {
        expect(enrichReclaimHintsWithCallIds(world(), SESSION, [])).toEqual([]);
    });
});
