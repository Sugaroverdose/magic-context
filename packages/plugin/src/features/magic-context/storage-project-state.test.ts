import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { initializeDatabase } from "./storage-db";
import {
    bumpProjectMemoryEpoch,
    bumpProjectUserProfileVersion,
    deleteProjectState,
    ensureProjectState,
    GLOBAL_USER_PROFILE_PROJECT_PATH,
    getProjectState,
    setProjectState,
} from "./storage-project-state";

let db: Database | null = null;

function makeDb(): Database {
    db = new Database(":memory:");
    initializeDatabase(db);
    return db;
}

afterEach(() => {
    if (db) {
        closeQuietly(db);
        db = null;
    }
});

describe("storage-project-state", () => {
    test("lazily creates and bumps project-scoped epochs", () => {
        const database = makeDb();

        expect(getProjectState(database, "git:abc")).toBeNull();
        expect(ensureProjectState(database, "git:abc", 10)).toEqual({
            projectPath: "git:abc",
            projectMemoryEpoch: 0,
            projectUserProfileVersion: 0,
            updatedAt: 10,
        });
        expect(bumpProjectMemoryEpoch(database, "git:abc", 20)).toEqual({
            projectPath: "git:abc",
            projectMemoryEpoch: 1,
            projectUserProfileVersion: 0,
            updatedAt: 20,
        });
        expect(bumpProjectMemoryEpoch(database, "git:abc", 30).projectMemoryEpoch).toBe(2);
    });

    test("updates user profile sentinel rows and supports set/delete CRUD", () => {
        const database = makeDb();

        expect(bumpProjectUserProfileVersion(database, undefined, 40)).toEqual({
            projectPath: GLOBAL_USER_PROFILE_PROJECT_PATH,
            projectMemoryEpoch: 0,
            projectUserProfileVersion: 1,
            updatedAt: 40,
        });
        expect(
            setProjectState(database, "git:def", {
                projectMemoryEpoch: 4,
                projectUserProfileVersion: 5,
                updatedAt: 60,
            }),
        ).toEqual({
            projectPath: "git:def",
            projectMemoryEpoch: 4,
            projectUserProfileVersion: 5,
            updatedAt: 60,
        });
        expect(deleteProjectState(database, "git:def")).toBe(true);
        expect(getProjectState(database, "git:def")).toBeNull();
    });
});
