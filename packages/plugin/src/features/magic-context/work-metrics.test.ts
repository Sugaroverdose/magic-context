import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "../../shared/sqlite";
import { computeOpenCodeWorkMetrics, computePiWorkMetrics } from "./work-metrics";

function createOpenCodeFixture(): Database {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT)");
    return db;
}

function insertAssistant(
    db: Database,
    sessionId: string,
    time: number,
    agent: string,
    input: number,
    output: number,
    cacheRead = 0,
    cacheWrite = 0,
): void {
    db.prepare("INSERT INTO message (session_id, time_created, data) VALUES (?, ?, ?)").run(
        sessionId,
        time,
        JSON.stringify({
            role: "assistant",
            agent,
            tokens: { input, output, cache: { read: cacheRead, write: cacheWrite } },
        }),
    );
}

describe("work metrics", () => {
    test("computes linear growth", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "build", 100, 10);
        insertAssistant(db, "ses", 2, "build", 150, 20);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 170,
            totalInputTokens: 150,
        });
    });

    test("clamps execute drops and sums phase peaks", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "build", 100, 1);
        insertAssistant(db, "ses", 2, "build", 200, 2);
        insertAssistant(db, "ses", 3, "build", 80, 3);
        insertAssistant(db, "ses", 4, "build", 120, 4);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 244,
            totalInputTokens: 320,
        });
    });

    test("partitions by agent", () => {
        const db = createOpenCodeFixture();
        insertAssistant(db, "ses", 1, "a", 100, 10);
        insertAssistant(db, "ses", 2, "b", 500, 20);
        insertAssistant(db, "ses", 3, "a", 150, 30);
        expect(computeOpenCodeWorkMetrics(db, "ses")).toEqual({
            newWorkTokens: 700,
            totalInputTokens: 650,
        });
    });

    test("empty sessions are zero", () => {
        const db = createOpenCodeFixture();
        expect(computeOpenCodeWorkMetrics(db, "missing")).toEqual({
            newWorkTokens: 0,
            totalInputTokens: 0,
        });
    });

    test("Pi metrics mirror the delta and phase-peak logic", () => {
        expect(
            computePiWorkMetrics([
                {
                    role: "assistant",
                    usage: { input: 100, output: 1, cacheRead: 0, cacheWrite: 0 },
                },
                {
                    role: "assistant",
                    usage: { input: 200, output: 2, cacheRead: 0, cacheWrite: 0 },
                },
                { role: "assistant", usage: { input: 80, output: 3, cacheRead: 0, cacheWrite: 0 } },
                {
                    role: "assistant",
                    usage: { input: 120, output: 4, cacheRead: 0, cacheWrite: 0 },
                },
            ]),
        ).toEqual({ newWorkTokens: 244, totalInputTokens: 320 });
    });

    test("live OpenCode smoke targets stay within 1%", () => {
        const dbPath = join(homedir(), ".local", "share", "opencode", "opencode.db");
        if (!existsSync(dbPath)) return;
        const db = new Database(dbPath, { readonly: true });
        const cases = [
            ["ses_331acff95fferWZOYF1pG0cjOn", 122_527_859, 345_669_836],
            ["ses_227ce5788ffeRPA9THoPLOQreO", 11_847_315, 71_309_730],
        ] as const;
        for (const [sessionId, expectedNewWork, expectedTotalInput] of cases) {
            const actual = computeOpenCodeWorkMetrics(db, sessionId);
            expect(Math.abs(actual.newWorkTokens - expectedNewWork) / expectedNewWork).toBeLessThan(
                0.01,
            );
            expect(
                Math.abs(actual.totalInputTokens - expectedTotalInput) / expectedTotalInput,
            ).toBeLessThan(0.01);
        }
    });
});
