/// <reference types="bun-types" />

import { describe, expect, it, mock } from "bun:test";
import type { LkgSlot } from "./lkg-slot";

const lines: string[] = [];
mock.module("../../shared/logger", () => ({
    log: () => {},
    sessionLog: (_sessionId: string, message: string) => lines.push(message),
    flushLogger: () => {},
    setLogLineForwarder: () => {},
    writeForwardedLogLine: () => {},
    getLogFilePath: () => "/tmp/magic-context-test.log",
    getLoggerDiagnostics: () => ({
        swallowedWriteCount: 0,
        lastErrorMessage: null,
        lastErrorTime: null,
    }),
}));

const { captureSlot, registerLkgPersistence, resetLkgSlotsForTest } = await import("./lkg-slot");

describe("captureSlot refusal telemetry", () => {
    it("logs the single-slot cap as the refusal reason", () => {
        // The 24 MiB cap rejected oversized sessions in silence for the whole
        // boot-cache-bust arc (`if (captured)` had no else arm anywhere in
        // the TS lane), so an oversized session simply never had a slot and
        // no receipt said why. The refusal must name the fired check at the
        // refusal choke itself.
        resetLkgSlotsForTest();
        registerLkgPersistence({ load: () => undefined, clear: () => {} });
        try {
            // slotBytes counts 2 * jsonPrefix.length: 13 MiB of chars
            // crosses the 24 MiB single-slot gate.
            const oversized: LkgSlot = {
                jsonPrefix: "x".repeat(13 * 1024 * 1024),
                inputIdSeq: ["m1"],
                inputContentDigests: ["digest-m1"],
                lastInputMessageId: "m1",
                modelKey: "test/model",
                providerKey: "test",
                capturedAt: 1,
            };
            expect(captureSlot("oversized-session", oversized)).toBe(false);
            expect(
                lines.some((line) => line.includes("lkg_capture_declined reason=slot_bytes=")),
            ).toBe(true);
            // The reason carries the measured bytes: 2 * prefix chars +
            // 2 * digest chars + LKG_METADATA_BYTES.
            expect(lines.join("").match(/slot_bytes=(\d+)/)?.[1]).toBe(
                String(2 * 13 * 1024 * 1024 + 2 * "digest-m1".length + 256),
            );
        } finally {
            registerLkgPersistence(undefined);
        }
    });

    it("names the failing fence when a digest/count mismatch refuses the capture", () => {
        resetLkgSlotsForTest();
        try {
            const broken: LkgSlot = {
                jsonPrefix: "[]",
                inputIdSeq: ["m1"],
                inputContentDigests: [],
                lastInputMessageId: "m1",
                modelKey: "test/model",
                providerKey: "test",
                capturedAt: 1,
            };
            expect(captureSlot("broken-session", broken)).toBe(false);
            expect(
                lines.some((line) => line.includes("lkg_capture_declined reason=digest_count=")),
            ).toBe(true);
        } finally {
            registerLkgPersistence(undefined);
        }
    });
});
