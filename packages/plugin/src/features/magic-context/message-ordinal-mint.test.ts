import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createTestTempDir } from "../../shared/test-temp-dir";
import { createHostOrdinalMint } from "./message-ordinal-mint";

const SESSION = "ses_mint";

function seedHost(): string {
    const { dir } = createTestTempDir("mint-host-");
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.exec(`
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);
    `);
    // Deliberately NOT insertion-ordered: ordinals must come from
    // (time_created, id), the canonical ctx_expand space.
    const msg = db.prepare(
        "INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)",
    );
    msg.run("m_3", SESSION, 300, JSON.stringify({ role: "assistant" }));
    msg.run("m_1", SESSION, 100, JSON.stringify({ role: "user" }));
    msg.run("m_2", SESSION, 200, JSON.stringify({ role: "assistant" }));
    msg.run("m_4", SESSION, 400, JSON.stringify({ role: "user" }));
    msg.run("m_x", "ses_other", 50, JSON.stringify({ role: "user" }));
    const part = db.prepare(
        "INSERT INTO part (id, message_id, session_id, data) VALUES (?, ?, ?, ?)",
    );
    part.run("prt_t", "m_2", SESSION, JSON.stringify({ type: "text", text: "narrative" }));
    db.close();
    return path;
}

const SESSION2 = SESSION;

function seedRegistry(): Database {
    const db = new Database(":memory:");
    db.exec(`
        CREATE TABLE tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT, message_id TEXT, type TEXT, status TEXT,
            tag_number INTEGER, tool_owner_message_id TEXT
        );
    `);
    const insert = db.prepare(
        "INSERT INTO tags (session_id, message_id, type, status, tag_number, tool_owner_message_id) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insert.run(SESSION2, "call_alpha", "tool", "active", 1, "m_2");
    insert.run(SESSION2, "call_beta", "tool", "dropped", 2, "m_3");
    insert.run(SESSION2, "call_orphan", "tool", "dropped", 3, "m_gone");
    return db;
}

const savedEnv = process.env.OPENCODE_DB;
afterEach(() => {
    if (savedEnv === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = savedEnv;
});

describe("host ordinal mint", () => {
    it("maps canonical (time,id) positions, not insertion order", () => {
        process.env.OPENCODE_DB = seedHost();
        const mint = createHostOrdinalMint(seedRegistry(), SESSION);
        expect(mint?.ordinalByMessageId.get("m_1")).toBe(1);
        expect(mint?.ordinalByMessageId.get("m_2")).toBe(2);
        expect(mint?.ordinalByMessageId.get("m_3")).toBe(3);
        expect(mint?.ordinalByMessageId.get("m_4")).toBe(4);
    });

    it("maps wire call ids to their owner message's ordinal", () => {
        process.env.OPENCODE_DB = seedHost();
        const mint = createHostOrdinalMint(seedRegistry(), SESSION);
        expect(mint?.ordinalByCallId?.get("call_alpha")).toBe(2);
        expect(mint?.ordinalByCallId?.get("call_beta")).toBe(3);
        expect(mint?.ordinalByCallId?.get("call_none")).toBeUndefined();
        expect(mint?.ordinalByCallId?.get("call_orphan")).toBeUndefined();
    });

    it("never crosses sessions", () => {
        process.env.OPENCODE_DB = seedHost();
        const mint = createHostOrdinalMint(seedRegistry(), SESSION);
        expect(mint?.ordinalByMessageId.get("m_x")).toBeUndefined();
        expect(mint?.ordinalByMessageId.size).toBe(4);
    });

    it("reports the newest user message as the bulk boundary", () => {
        process.env.OPENCODE_DB = seedHost();
        expect(createHostOrdinalMint(seedRegistry(), SESSION)?.latestUserOrdinal).toBe(4);
    });

    it("degrades to undefined without a host store", () => {
        process.env.OPENCODE_DB = join(tmpdir(), "definitely-missing-opencode.db");
        expect(createHostOrdinalMint(seedRegistry(), SESSION)).toBeUndefined();
    });
});
