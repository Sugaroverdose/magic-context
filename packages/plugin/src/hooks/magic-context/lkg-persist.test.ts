import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
    LKG_SLOT_CHUNKS_DDL,
    LKG_SLOTS_DDL,
} from "../../features/magic-context/migration-v94-write-split";
import type { Database } from "../../shared/sqlite";
import {
    clearPersistedLkgSlot,
    loadPersistedLkgSlot,
    pruneStaleLkgSlots,
    saveLkgSlotToDb,
} from "./lkg-persist";
import type { LkgSlot } from "./lkg-slot";

function fixture(): { db: Database; raw: BunDatabase } {
    const raw = new BunDatabase(":memory:");
    raw.exec(`${LKG_SLOTS_DDL} ${LKG_SLOT_CHUNKS_DDL}
        CREATE TABLE session_projects (session_id TEXT, updated_at INTEGER);`);
    return { db: raw as unknown as Database, raw };
}

const slot: LkgSlot = {
    jsonPrefix: '[{"text":"one"}]',
    inputIdSeq: ["m1"],
    inputContentDigests: ["digest"],
    lastInputMessageId: "m1",
    modelKey: "model",
    providerKey: "provider",
    capturedAt: 1,
};

describe("LKG durable write discipline", () => {
    it("writes once for identical passes, but persists a one-byte change and a clear", () => {
        const { db, raw } = fixture();
        try {
            expect(saveLkgSlotToDb(db, "ses", slot)).toBe(true);
            const initial = raw.query("SELECT total_changes() AS count").get() as { count: number };
            for (let i = 0; i < 5; i++)
                expect(saveLkgSlotToDb(db, "ses", { ...slot, capturedAt: i + 2 })).toBe(true);
            expect(
                (raw.query("SELECT total_changes() AS count").get() as { count: number }).count,
            ).toBe(initial.count);
            const changed = { ...slot, jsonPrefix: '[{"text":"onf"}]' };
            expect(saveLkgSlotToDb(db, "ses", changed)).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(changed.jsonPrefix);
            // The prefix's only slice and the metadata row.
            expect(
                (raw.query("SELECT total_changes() AS count").get() as { count: number }).count,
            ).toBe(initial.count + 2);
            clearPersistedLkgSlot(db, "ses");
            expect(saveLkgSlotToDb(db, "ses", changed)).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses")?.jsonPrefix).toBe(changed.jsonPrefix);
        } finally {
            raw.close();
        }
    });

    it("prunes old slots but keeps recent captures and recent session bindings", () => {
        const { db, raw } = fixture();
        try {
            const now = 20 * 24 * 60 * 60 * 1000;
            saveLkgSlotToDb(db, "old", slot);
            saveLkgSlotToDb(db, "active", slot);
            saveLkgSlotToDb(db, "recent", { ...slot, capturedAt: now });
            raw.query("INSERT INTO session_projects VALUES (?, ?)").run("active", now);
            expect(pruneStaleLkgSlots(db, now)).toBe(1);
            expect(loadPersistedLkgSlot(db, "old")).toBeUndefined();
            expect(loadPersistedLkgSlot(db, "active")).toBeDefined();
            expect(loadPersistedLkgSlot(db, "recent")).toBeDefined();
            expect(saveLkgSlotToDb(db, "old", slot)).toBe(true);
            expect(loadPersistedLkgSlot(db, "old")).toBeDefined();
        } finally {
            raw.close();
        }
    });
});
