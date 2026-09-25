/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type ContextDatabase,
    closeDatabase,
    getOrCreateSessionMeta,
    openDatabase,
} from "../../features/magic-context/storage";
import {
    getPersistedCompactionMarkerState,
    setPersistedCompactionMarkerState,
} from "../../features/magic-context/storage-meta-persisted";
import { Database } from "../../shared/sqlite";
import {
    getV2StoreReaderDebugCounters,
    resetV2StoreReaderDebugCounters,
    V2StoreReader,
} from "../store-reader";
import { trimToRecordedBoundary } from "./boundary";
import { RUST_SEED_BOUNDARY_MESSAGES, seedLongSessionBoundary } from "./seed-boundary";

const SESSION = "ses-seed";
const tempDirs: string[] = [];
const openDatabases: ContextDatabase[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    while (openDatabases.length > 0) closeDatabase(openDatabases.pop());
    while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
});

function contextDb(): ContextDatabase {
    const dir = mkdtempSync(join(tmpdir(), "mc-v2-seed-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    mkdirSync(join(dir, "cortexkit", "magic-context"), { recursive: true });
    const db = openDatabase();
    if (!db) throw new Error("test database unavailable");
    openDatabases.push(db);
    getOrCreateSessionMeta(db, SESSION);
    return db;
}

type Shape = "user-only" | "tool-arcs";

/**
 * A v2 host store holding `count` rows. "tool-arcs" is a realistic session: a user turn,
 * then several assistant steps with tool calls and results, with an instruction-update
 * row the host does not serve by id now and then.
 */
function hostStore(count: number, shape: Shape): string {
    const dir = mkdtempSync(join(tmpdir(), "mc-v2-seed-store-"));
    tempDirs.push(dir);
    const path = join(dir, "opencode.db");
    const store = new Database(path);
    store.exec(`
        CREATE TABLE session_message(
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
            seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
            data TEXT NOT NULL
        );
        CREATE UNIQUE INDEX session_message_session_seq_idx ON session_message(session_id, seq);
        CREATE INDEX session_message_session_type_seq_idx ON session_message(session_id, type, seq);
    `);
    const insert = store.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");
    store.transaction(() => {
        for (let seq = 0; seq < count; seq++) {
            const time = 1_800_000_000_000 + seq;
            const position = seq % 9;
            let type: string;
            let data: unknown;
            if (shape === "user-only" || position === 0) {
                type = "user";
                data = { text: `turn ${seq}`, time: { created: time } };
            } else if (position === 5) {
                type = "system";
                data = { text: "Today's date is now: Wed Sep 23 2026", metadata: { k: 1 } };
            } else {
                type = "assistant";
                data = {
                    content: [
                        { type: "text", text: `step ${seq}` },
                        {
                            type: "tool",
                            callID: `call-${seq}`,
                            name: "read",
                            state: {
                                status: "completed",
                                input: { path: "a" },
                                output: "x".repeat(200),
                            },
                        },
                    ],
                    model: { providerID: "p", id: "m" },
                };
            }
            insert.run(`msg-${seq}`, SESSION, type, seq, time, time, JSON.stringify(data));
        }
    })();
    store.close();
    return path;
}

function seed(db: ContextDatabase, storePath: string) {
    const reader = new V2StoreReader(storePath);
    try {
        resetV2StoreReaderDebugCounters();
        const id = seedLongSessionBoundary(db, reader, SESSION);
        const counters = getV2StoreReaderDebugCounters();
        const maxPerOperation = Math.max(
            0,
            ...Object.values(counters.operations).map((operation) => operation.maxDecodedRows),
        );
        return {
            id,
            maxPerOperation,
            ordinalOf: (messageID: string) => reader.messageOrdinalById(SESSION, messageID),
        };
    } finally {
        reader.close();
    }
}

describe("seedLongSessionBoundary", () => {
    for (const shape of ["user-only", "tool-arcs"] as const) {
        it(`bounds a 10,000-row ${shape} session with no boundary to a tail starting at a user turn`, () => {
            const db = contextDb();
            const storePath = hostStore(10_000, shape);
            const { id, maxPerOperation } = seed(db, storePath);
            expect(id).not.toBeNull();
            const marker = getPersistedCompactionMarkerState(db, SESSION);
            expect(marker?.boundaryMessageId).toBe(id!);
            const reader = new V2StoreReader(storePath);
            try {
                const row = reader.messageById(SESSION, id!);
                expect(row?.type).toBe("user");
                const ordinal = reader.messageOrdinalById(SESSION, id!)!;
                expect(marker?.boundaryOrdinal).toBe(ordinal - 1);
                const kept = reader.messageCount(SESSION) - ordinal + 1;
                // The tail starts at the user turn at or before the bound: never more
                // than one turn over it, never less than the bound.
                expect(kept).toBeGreaterThanOrEqual(RUST_SEED_BOUNDARY_MESSAGES);
                expect(kept).toBeLessThanOrEqual(RUST_SEED_BOUNDARY_MESSAGES + 9);
            } finally {
                reader.close();
            }
            // No single read decodes more than one page.
            expect(maxPerOperation).toBeLessThanOrEqual(100);

            // The array the host hands over is trimmed to the seeded boundary.
            const draft = Array.from({ length: 10_000 }, (_, seq) => ({ id: `msg-${seq}` }));
            const dropped = trimToRecordedBoundary(db, SESSION, draft);
            expect(draft[0]?.id).toBe(id!);
            expect(draft.length + dropped).toBe(10_000);
            expect(draft.length).toBeLessThanOrEqual(RUST_SEED_BOUNDARY_MESSAGES + 9);
        });
    }

    it("leaves a short session and an already-bounded session alone", () => {
        const shortDb = contextDb();
        expect(seed(shortDb, hostStore(RUST_SEED_BOUNDARY_MESSAGES, "tool-arcs")).id).toBeNull();
        expect(getPersistedCompactionMarkerState(shortDb, SESSION)).toBeNull();

        const boundedDb = contextDb();
        const existing = {
            boundaryMessageId: "msg-9000",
            summaryMessageId: "",
            compactionPartId: "",
            summaryPartId: "",
            boundaryOrdinal: 8999,
            targetEndMessageId: "msg-8999",
        };
        setPersistedCompactionMarkerState(boundedDb, SESSION, existing);
        expect(seed(boundedDb, hostStore(10_000, "user-only")).id).toBeNull();
        expect(getPersistedCompactionMarkerState(boundedDb, SESSION)).toEqual(existing);
    });
});
