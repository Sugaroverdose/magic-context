import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { createHostOrdinalMint } from "./message-ordinal-mint";

const SESSION = "ses_mint";

function seedHost(): string {
    const dir = mkdtempSync(join(tmpdir(), "mint-host-"));
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
    part.run("prt_a", "m_2", SESSION, JSON.stringify({ type: "tool", callID: "call_alpha" }));
    part.run("prt_b", "m_3", SESSION, JSON.stringify({ type: "tool", callID: "call_beta" }));
    part.run("prt_t", "m_2", SESSION, JSON.stringify({ type: "text", text: "narrative" }));
    db.close();
    return path;
}

const savedEnv = process.env.OPENCODE_DB;
afterEach(() => {
    if (savedEnv === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = savedEnv;
});

describe("host ordinal mint", () => {
    it("maps canonical (time,id) positions, not insertion order", () => {
        process.env.OPENCODE_DB = seedHost();
        const mint = createHostOrdinalMint(SESSION);
        expect(mint?.ordinalByMessageId.get("m_1")).toBe(1);
        expect(mint?.ordinalByMessageId.get("m_2")).toBe(2);
        expect(mint?.ordinalByMessageId.get("m_3")).toBe(3);
        expect(mint?.ordinalByMessageId.get("m_4")).toBe(4);
    });

    it("maps wire call ids to their owner message's ordinal", () => {
        process.env.OPENCODE_DB = seedHost();
        const mint = createHostOrdinalMint(SESSION);
        expect(mint?.ordinalByCallId?.get("call_alpha")).toBe(2);
        expect(mint?.ordinalByCallId?.get("call_beta")).toBe(3);
        expect(mint?.ordinalByCallId?.get("call_none")).toBeUndefined();
    });

    it("never crosses sessions", () => {
        process.env.OPENCODE_DB = seedHost();
        const mint = createHostOrdinalMint(SESSION);
        expect(mint?.ordinalByMessageId.get("m_x")).toBeUndefined();
        expect(mint?.ordinalByMessageId.size).toBe(4);
    });

    it("reports the newest user message as the bulk boundary", () => {
        process.env.OPENCODE_DB = seedHost();
        expect(createHostOrdinalMint(SESSION)?.latestUserOrdinal).toBe(4);
    });

    it("degrades to undefined without a host store", () => {
        process.env.OPENCODE_DB = join(tmpdir(), "definitely-missing-opencode.db");
        expect(createHostOrdinalMint(SESSION)).toBeUndefined();
    });
});
