/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import { insertMemory } from "../memory";
import { runMigrations } from "../migrations";
import { initializeDatabase } from "../storage-db";
import { evaluateTaskGate } from "./task-gates";

let db: Database | null = null;

afterEach(() => {
    if (db) closeQuietly(db);
    db = null;
});

function freshDb(): Database {
    const database = new Database(":memory:");
    initializeDatabase(database);
    runMigrations(database);
    return database;
}

describe("evaluateTaskGate", () => {
    test("classify-memories runs when active memories exist", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: null,
                promotionThreshold: 3,
            }),
        ).toBe(false);

        insertMemory(db, {
            projectPath: projectIdentity,
            category: "PROJECT_RULES",
            content: "Use Bun for package scripts in this repo.",
        });

        expect(
            evaluateTaskGate("classify-memories", {
                db,
                projectIdentity,
                lastRunAt: Date.now(),
                promotionThreshold: 3,
            }),
        ).toBe(true);
    });

    test("retrospective runs when a project session changed since last run", () => {
        db = freshDb();
        const projectIdentity = "/repo/project";
        db.prepare(
            "INSERT INTO session_projects (session_id, harness, project_path, updated_at) VALUES (?, ?, ?, ?)",
        ).run("s1", "opencode", projectIdentity, 200);

        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: null,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: 100,
                promotionThreshold: 3,
            }),
        ).toBe(true);
        expect(
            evaluateTaskGate("retrospective", {
                db,
                projectIdentity,
                lastRunAt: 300,
                promotionThreshold: 3,
            }),
        ).toBe(false);
    });
});
