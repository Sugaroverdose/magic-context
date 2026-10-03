/// <reference types="bun-types" />

import { expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { getSourceContents } from "../../features/magic-context/storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { type MessageLike, tagMessages } from "./tag-messages";

const SESSION_ID = "ses-section-reference";

function userMessage(id: string, text: string): MessageLike {
    return {
        info: { id, role: "user", sessionID: SESSION_ID },
        parts: [{ type: "text", text }],
    } as MessageLike;
}

it("keeps a leading section reference in the tagged text and its saved source content", () => {
    const db = new Database(":memory:");
    try {
        initializeDatabase(db);
        runMigrations(db);
        const tagger = createTagger();
        tagger.initFromDb(SESSION_ID, db);

        const text = "\u00a75 of the contract";
        const first = [userMessage("m-1", text)];
        tagMessages(SESSION_ID, first, tagger, db);
        const tagged = (first[0].parts[0] as { text: string }).text;
        expect(tagged).toBe(`\u00a71\u00a7 ${text}`);
        expect(getSourceContents(db, SESSION_ID, [1]).get(1)).toBe(text);

        // A replay restores from the saved source, so it must serve the same bytes.
        tagger.initFromDb(SESSION_ID, db);
        const replay = [userMessage("m-1", text)];
        tagMessages(SESSION_ID, replay, tagger, db);
        expect((replay[0].parts[0] as { text: string }).text).toBe(tagged);
    } finally {
        db.close();
    }
});
