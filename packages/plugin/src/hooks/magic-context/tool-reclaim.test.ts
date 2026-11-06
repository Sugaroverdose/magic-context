/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CTX_REDUCE_KEEP } from "../../features/magic-context/reclaim-protection";
import { closeDatabase, insertTag, openDatabase } from "../../features/magic-context/storage";
import { createTestTempDirFromPath } from "../../shared/test-temp-dir";
import type { TagTarget } from "./tag-messages";
import { buildSyntheticToolReclaimOps } from "./tool-reclaim";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    for (const dir of tempDirs) {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    tempDirs.length = 0;
});

function freshDb(): NonNullable<ReturnType<typeof openDatabase>> {
    const dir = createTestTempDirFromPath(join(tmpdir(), "tool-reclaim-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    const db = openDatabase();
    if (!db) throw new Error("db open failed");
    return db;
}

function target(): TagTarget {
    return {
        setContent: () => true,
        drop: () => "removed",
        canDrop: () => true,
    };
}

describe("buildSyntheticToolReclaimOps", () => {
    it("keeps the newest three ctx_reduce exemplars out of the age lane", () => {
        const db = freshDb();
        const sessionId = "ses-ctx-reduce-age";
        const targets = new Map<number, TagTarget>();
        for (let n = 1; n <= 5; n += 1) {
            insertTag(
                db,
                sessionId,
                `reduce-${n}`,
                "tool",
                4_000,
                n,
                0,
                "ctx_reduce",
                0,
                null,
                null,
                {
                    tokenCount: 1_000,
                    inputTokenCount: 0,
                    reasoningTokenCount: 0,
                },
            );
            targets.set(n, target());
        }

        const ops = buildSyntheticToolReclaimOps({
            db,
            sessionId,
            targets,
            watermark: 5,
        });

        expect(ops.map((op) => op.tagId)).toEqual([1, 2]);
        expect(CTX_REDUCE_KEEP).toBe(3);
    });
});

describe("sweeper stop line", () => {
    function seedBashTags(
        db: NonNullable<ReturnType<typeof openDatabase>>,
        sessionId: string,
        count: number,
        tokensPerTag: number,
    ): Map<number, TagTarget> {
        const targets = new Map<number, TagTarget>();
        for (let n = 1; n <= count; n += 1) {
            insertTag(
                db,
                sessionId,
                `bash-${n}`,
                "tool",
                tokensPerTag * 4,
                n,
                0,
                "bash",
                0,
                null,
                null,
                { tokenCount: tokensPerTag, inputTokenCount: 0, reasoningTokenCount: 0 },
            );
            targets.set(n, target());
        }
        return targets;
    }

    it("stops selecting once the projection reaches threshold minus 15pp", () => {
        const db = freshDb();
        const sessionId = "ses-stop-line";
        // 8 tags x 1_000 tokens; usable 20_000; usage 70%; threshold 65 → stop 50%.
        // Needed reclaim = (70−50)% x 20_000 = 4_000 → exactly tags 1..4.
        const targets = seedBashTags(db, sessionId, 8, 1_000);
        const ops = buildSyntheticToolReclaimOps({
            db,
            sessionId,
            targets,
            watermark: 8,
            budget: {
                currentUsagePercentage: 70,
                executeThresholdPercentage: 65,
                usableContextTokens: 20_000,
            },
        });
        expect(ops.map((op) => op.tagId)).toEqual([1, 2, 3, 4]);
    });

    it("takes no bite when usage already sits below the stop line", () => {
        const db = freshDb();
        const sessionId = "ses-stop-line-below";
        const targets = seedBashTags(db, sessionId, 4, 1_000);
        const ops = buildSyntheticToolReclaimOps({
            db,
            sessionId,
            targets,
            watermark: 4,
            budget: {
                currentUsagePercentage: 45,
                executeThresholdPercentage: 65,
                usableContextTokens: 20_000,
            },
        });
        expect(ops).toHaveLength(0);
    });

    it("keeps taking unknown-token tags until the budget is met", () => {
        const db = freshDb();
        const sessionId = "ses-stop-line-unknown";
        // Needed = (55 − 50)% x 20_000 = 1_000. Tags 1..2 carry no token
        // accounting (count 0 toward the budget); tag 3 meets the need; the
        // sweep stops there and never reaches tag 4.
        const targets = seedBashTags(db, sessionId, 4, 1_000);
        db.prepare(
            "UPDATE tags SET token_count = NULL, input_token_count = NULL WHERE session_id = ? AND tag_number IN (1, 2)",
        ).run(sessionId);
        const ops = buildSyntheticToolReclaimOps({
            db,
            sessionId,
            targets,
            watermark: 4,
            budget: {
                currentUsagePercentage: 55,
                executeThresholdPercentage: 65,
                usableContextTokens: 20_000,
            },
        });
        expect(ops.map((op) => op.tagId)).toEqual([1, 2, 3]);
    });
});
