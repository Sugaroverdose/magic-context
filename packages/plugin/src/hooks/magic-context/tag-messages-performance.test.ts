/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { createTagger } from "../../features/magic-context/tagger";
import { Database } from "../../shared/sqlite";
import { closeQuietly } from "../../shared/sqlite-helpers";
import { type MessageLike, tagMessages } from "./tag-messages";

function buildMessages(sessionId: string, count: number): MessageLike[] {
    return Array.from({ length: count }, (_, index) => {
        const role = index % 2 === 0 ? "user" : "assistant";
        const parts: unknown[] =
            role === "user"
                ? [{ type: "text", text: `user message ${index}` }]
                : [
                      { type: "text", text: `assistant message ${index}` },
                      {
                          type: "tool",
                          callID: `call-${index}`,
                          tool: "read",
                          state: {
                              status: "completed",
                              input: { path: `/file-${index}` },
                              output: `tool output ${index}`,
                          },
                      },
                  ];
        return {
            info: { id: `msg-${index}`, role, sessionID: sessionId },
            parts,
        } as MessageLike;
    });
}

function median(values: number[]): number {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("tagMessages steady replay cost", () => {
    test("keeps per-message cost load-invariant from 200 to 2,000 messages", () => {
        const db = new Database(":memory:");
        try {
            initializeDatabase(db);
            runMigrations(db);

            const measure = (
                count: number,
            ): { perMessageCpuMs: number; fallbackLookups: number } => {
                const sessionId = `ses-perf-${count}`;
                const tagger = createTagger();
                tagger.initFromDb(sessionId, db);
                tagMessages(sessionId, buildMessages(sessionId, count), tagger, db);

                let fallbackLookups = 0;
                const samples: number[] = [];
                for (let pass = 0; pass < 5; pass += 1) {
                    tagger.initFromDb(sessionId, db);
                    const messages = buildMessages(sessionId, count);
                    const startedAt = process.cpuUsage();
                    tagMessages(sessionId, messages, tagger, db, {
                        onToolOwnerFallbackLookup: () => {
                            fallbackLookups += 1;
                        },
                    });
                    const elapsed = process.cpuUsage(startedAt);
                    samples.push((elapsed.user + elapsed.system) / 1000);
                }
                return { perMessageCpuMs: median(samples) / count, fallbackLookups };
            };

            const small = measure(200);
            const large = measure(2_000);
            expect(small.fallbackLookups).toBe(0);
            expect(large.fallbackLookups).toBe(0);

            const perMessageRatio = large.perMessageCpuMs / small.perMessageCpuMs;
            if (process.env.MC_PERF_GATE === "1") {
                expect(perMessageRatio).toBeLessThanOrEqual(3);
            } else {
                console.log(
                    `tagMessages per-message ratio 2000/200=${perMessageRatio.toFixed(2)} ` +
                        `(small=${small.perMessageCpuMs.toFixed(4)} CPU-ms large=${large.perMessageCpuMs.toFixed(4)}ms; perf gate off)`,
                );
            }
        } finally {
            closeQuietly(db);
        }
    });
});
