/// <reference types="bun-types" />

import { afterAll, beforeAll, expect, it } from "bun:test";
import {
    createScenarioHarness,
    forEachHost,
    type ScenarioHarness,
} from "../src/scenario-hosts";
import { openTestDb } from "../src/test-db";

function countRows(h: ScenarioHarness, table: "pending_ops" | "tags", sessionId: string): number {
    const status = table === "tags" ? " AND status = 'dropped'" : "";
    const row = h.contextDb()
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ? AND harness = ?${status}`)
        .get(sessionId, h.harnessId) as { n: number } | null;
    return row?.n ?? 0;
}

forEachHost(import.meta.url, "drops", (host) => {
    let h: ScenarioHarness;

    beforeAll(async () => {
        // Pending operations apply only on a cache-busting pass. The force-band
        // sample and real message mass move the target beyond the protected tail.
        h = await createScenarioHarness(host, {
            modelContextLimit: 20_000,
            magicContextConfig: { protected_tokens: 4_000, execute_threshold_percentage: 20 },
        });
    });

    afterAll(async () => {
        await h.dispose();
    });

    it("drains pending_ops when drops are queued", async () => {
        h.mock.reset();
        h.mock.setDefault({
            content: Array.from({ length: 24 }, (_, index) => ({
                type: "text",
                text: `drop aging block ${index + 1}: ${h.ballast(200)}`,
            })),
            usage: { input_tokens: 18_000, output_tokens: 10, cache_creation_input_tokens: 0 },
        });

        const sessionId = await h.createSession();
        await h.sendPrompt(sessionId, "first drop target", { timeoutMs: 60_000 });
        await h.waitFor(() => h.countTags(sessionId) > 0, { label: "tag ready" });

        const writable = openTestDb(h.contextDbPath());
        try {
            writable
                .prepare(
                    "INSERT INTO pending_ops (session_id, tag_id, operation, queued_at, harness) VALUES (?, 1, 'drop', ?, ?)",
                )
                .run(sessionId, Date.now(), h.harnessId);
        } finally {
            writable.close();
        }

        h.mock.reset();
        h.mock.setDefault({
            text: "second response",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0 },
        });
        await h.sendPrompt(sessionId, "second turn force-busts and drains pending ops", {
            timeoutMs: 60_000,
        });

        expect(countRows(h, "pending_ops", sessionId)).toBe(0);
        expect(countRows(h, "tags", sessionId)).toBeGreaterThan(0);
        expect(JSON.stringify(h.mock.lastRequest()!.body)).toContain("dropped §1§");
    }, 60_000);
});
