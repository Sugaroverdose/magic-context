/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { Database } from "../../shared/sqlite";
import { runMigrations } from "./migrations";
import { initializeDatabase } from "./storage-db";
import {
    applyStrippedPlaceholderDelta,
    getHiddenSeamPlaceholderIds,
    getStrippedPlaceholderIds,
    MAX_STRIPPED_PLACEHOLDER_IDS,
    removeStrippedPlaceholderId,
    setStrippedPlaceholderIds,
} from "./storage-meta-persisted";

function createTestDb(): Database {
    const db = new Database(":memory:");
    initializeDatabase(db);
    runMigrations(db);
    return db;
}

describe("applyStrippedPlaceholderDelta (CAS)", () => {
    let db: Database;
    const ses = "ses-cas";

    beforeEach(() => {
        db = createTestDb();
    });

    it("adds ids onto an empty (null) row", () => {
        expect(applyStrippedPlaceholderDelta(db, ses, { add: ["a", "b"] })).toBe(true);
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a", "b"]));
    });

    it("merges an add-delta onto an existing set without clobbering", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        applyStrippedPlaceholderDelta(db, ses, { add: ["b", "c"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a", "b", "c"]));
    });

    it("removes ids and leaves the rest", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a", "b", "c"]));
        applyStrippedPlaceholderDelta(db, ses, { remove: ["b"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a", "c"]));
    });

    it("applies add+remove in one call", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a", "b"]));
        applyStrippedPlaceholderDelta(db, ses, { add: ["c"], remove: ["a"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["b", "c"]));
    });

    it("empties the row when all ids removed", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        applyStrippedPlaceholderDelta(db, ses, { remove: ["a"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set());
    });

    it("is a no-op for an empty delta", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        expect(applyStrippedPlaceholderDelta(db, ses, {})).toBe(true);
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["a"]));
    });

    it("removeStrippedPlaceholderId returns false when id absent, true when present", () => {
        setStrippedPlaceholderIds(db, ses, new Set(["a"]));
        expect(removeStrippedPlaceholderId(db, ses, "zzz")).toBe(false);
        expect(removeStrippedPlaceholderId(db, ses, "a")).toBe(true);
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set());
    });

    it("bounds durable ids while retaining the newest seam decisions", () => {
        const ids = Array.from(
            { length: MAX_STRIPPED_PLACEHOLDER_IDS + 3 },
            (_, index) => `message-${index}`,
        );
        applyStrippedPlaceholderDelta(db, ses, { hiddenSeamAdd: ids });

        expect(getStrippedPlaceholderIds(db, ses).size).toBe(MAX_STRIPPED_PLACEHOLDER_IDS);
        expect(getStrippedPlaceholderIds(db, ses).has("message-0")).toBe(false);
        expect(getHiddenSeamPlaceholderIds(db, ses).has(ids.at(-1) ?? "")).toBe(true);
    });

    it("removes hidden seam classification with its source id", () => {
        applyStrippedPlaceholderDelta(db, ses, { hiddenSeamAdd: ["seam"] });
        expect(removeStrippedPlaceholderId(db, ses, "seam")).toBe(true);
        expect(getHiddenSeamPlaceholderIds(db, ses)).toEqual(new Set());
    });

    it("merge semantics: a stale-read add does not undo a concurrent remove", () => {
        // Simulate the race the CAS prevents: process A reads {a,b}, process B
        // removes 'a' (set now {b}), then A applies its add-delta {add:c}. With a
        // whole-set overwrite A would write {a,b,c} (resurrecting 'a'); with the
        // delta CAS, A re-reads {b} and writes {b,c}.
        setStrippedPlaceholderIds(db, ses, new Set(["a", "b"]));
        // B's concurrent remove lands first:
        applyStrippedPlaceholderDelta(db, ses, { remove: ["a"] });
        // A's delta is computed against a fresh read inside the helper:
        applyStrippedPlaceholderDelta(db, ses, { add: ["c"] });
        expect(getStrippedPlaceholderIds(db, ses)).toEqual(new Set(["b", "c"]));
    });
});
