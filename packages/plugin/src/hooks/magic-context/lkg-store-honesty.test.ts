/// <reference types="bun-types" />

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";
import { layoutLkgPrefix } from "../../features/magic-context/lkg-prefix-chunks";
import {
    LKG_SLOT_CHUNKS_DDL,
    LKG_SLOTS_DDL,
} from "../../features/magic-context/migration-v94-write-split";
import type { Database } from "../../shared/sqlite";
import type { LkgSlot } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

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

const { captureSlot, dropSlot, registerLkgPersistence, resetLkgSlotsForTest } = await import(
    "./lkg-slot"
);
const { loadPersistedLkgSlot, saveLkgSlotToDb } = await import("./lkg-persist");
const { captureLkgSlot } = await import("./lkg-replay");

function fixture(): { db: Database; raw: BunDatabase } {
    const raw = new BunDatabase(":memory:");
    raw.exec(`${LKG_SLOTS_DDL} ${LKG_SLOT_CHUNKS_DDL}
        CREATE TABLE session_projects (session_id TEXT, updated_at INTEGER);`);
    return { db: raw as unknown as Database, raw };
}

const HEALTHY: LkgSlot = {
    jsonPrefix: `[{"parts":[{"text":"${"x".repeat(100 * 1024)}"}]}]`,
    inputIdSeq: ["m1"],
    inputContentDigests: ["digest-m1"],
    lastInputMessageId: "m1",
    modelKey: "test/model",
    providerKey: "test",
    capturedAt: 1,
};

function hadesSlot(patch: Partial<LkgSlot>): LkgSlot {
    return { ...HEALTHY, ...patch };
}

describe("LKG store honesty: captureSlot names structurally invalid slots", () => {
    // The live wipe observed `lkg_slot_chunks` going 22 chunks to 0 rows with
    // `captured_at` NULL and zero `lkg_capture_declined` lines. A slot that
    // `parsePersistedLkgSlot` could never read back must be refused at the
    // store's own gate, by name, exactly like the digest and size fences.
    it("refuses an empty jsonPrefix with reason=empty_prefix", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        expect(captureSlot("empty-prefix", hadesSlot({ jsonPrefix: "" }))).toBe(false);
        expect(
            lines.some((line) => line.includes("lkg_capture_declined reason=empty_prefix")),
        ).toBe(true);
        resetLkgSlotsForTest();
    });

    it("refuses a non-finite capturedAt with reason=invalid_captured_at", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        expect(captureSlot("nan-time", hadesSlot({ capturedAt: NaN }))).toBe(false);
        expect(
            lines.some((line) => line.includes("lkg_capture_declined reason=invalid_captured_at")),
        ).toBe(true);
        lines.length = 0;
        expect(
            captureSlot(
                "undefined-time",
                hadesSlot({ capturedAt: undefined as unknown as number }),
            ),
        ).toBe(false);
        expect(
            lines.some((line) => line.includes("lkg_capture_declined reason=invalid_captured_at")),
        ).toBe(true);
        resetLkgSlotsForTest();
    });

    it("refuses an empty lastInputMessageId with reason=missing_anchor", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        expect(captureSlot("no-anchor", hadesSlot({ lastInputMessageId: "" }))).toBe(false);
        expect(
            lines.some((line) => line.includes("lkg_capture_declined reason=missing_anchor")),
        ).toBe(true);
        resetLkgSlotsForTest();
    });
});

describe("LKG store honesty: dropSlot receipts its durable clear", () => {
    // `dropSlot` took `_reason` and discarded it: the destructive arm of the
    // observed wipe (bust pass + declined capture => dropSlot(sessionId,
    // "lkg_refresh_declined")) removed the durable row with zero log lines.
    it("logs lkg_slot_dropped with the caller's reason and clears the durable row", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        let cleared: string | undefined;
        registerLkgPersistence({
            load: () => undefined,
            clear: (sessionId) => {
                cleared = sessionId;
            },
        });
        try {
            expect(captureSlot("dropped", HEALTHY)).toBe(true);
            dropSlot("dropped", "lkg_refresh_declined");
            expect(cleared).toBe("dropped");
            expect(
                lines.some((line) => line.includes("lkg_slot_dropped reason=lkg_refresh_declined")),
            ).toBe(true);
            lines.length = 0;
            dropSlot("dropped");
            expect(lines.some((line) => line.includes("lkg_slot_dropped reason=unspecified"))).toBe(
                true,
            );
        } finally {
            registerLkgPersistence(undefined);
            resetLkgSlotsForTest();
        }
    });
});

describe("LKG store honesty: saveLkgSlotToDb refuses before destroying", () => {
    // The durable writer trusts its caller: it deletes every stored slice and
    // replaces the metadata row BEFORE anything looks at the slot it was
    // handed. A slot that can never be read back must never rewrite the row.
    it("refuses an empty-prefix slot without touching the healthy slices", () => {
        const { db, raw } = fixture();
        try {
            lines.length = 0;
            expect(saveLkgSlotToDb(db, "ses", HEALTHY)).toBe(true);
            const chunkCount = () =>
                (raw.query("SELECT COUNT(*) AS n FROM lkg_slot_chunks").get() as { n: number }).n;
            const healthyChunks = chunkCount();
            expect(healthyChunks).toBeGreaterThan(1);
            const before = raw
                .query("SELECT json_prefix_chars, json_prefix_chunks FROM lkg_slots")
                .get() as { json_prefix_chars: number; json_prefix_chunks: number };

            expect(saveLkgSlotToDb(db, "ses", hadesSlot({ jsonPrefix: "" }))).toBe(false);
            expect(
                lines.some((line) => line.includes("lkg_persist_declined reason=empty_prefix")),
            ).toBe(true);
            // The observed destruction: chunks gone and the row rewritten. The
            // refusal must leave the healthy durable slot byte-intact.
            expect(chunkCount()).toBe(healthyChunks);
            expect(
                raw.query("SELECT json_prefix_chars, json_prefix_chunks FROM lkg_slots").get(),
            ).toEqual(before);
        } finally {
            raw.close();
        }
    });

    it("refuses a non-finite capturedAt with a named decline, not a constraint throw", () => {
        const { db, raw } = fixture();
        try {
            lines.length = 0;
            expect(saveLkgSlotToDb(db, "ses2", HEALTHY)).toBe(true);
            expect(saveLkgSlotToDb(db, "ses2", hadesSlot({ capturedAt: NaN }))).toBe(false);
            expect(
                lines.some((line) =>
                    line.includes("lkg_persist_declined reason=invalid_captured_at"),
                ),
            ).toBe(true);
            expect(lines.some((line) => line.includes("LKG snapshot persistence failed"))).toBe(
                false,
            );
            expect(loadPersistedLkgSlot(db, "ses2")?.jsonPrefix).toBe(HEALTHY.jsonPrefix);
        } finally {
            raw.close();
        }
    });

    it("refuses an empty anchor id with reason=missing_anchor", () => {
        const { db, raw } = fixture();
        try {
            lines.length = 0;
            expect(saveLkgSlotToDb(db, "ses3", HEALTHY)).toBe(true);
            expect(saveLkgSlotToDb(db, "ses3", hadesSlot({ lastInputMessageId: "" }))).toBe(false);
            expect(
                lines.some((line) => line.includes("lkg_persist_declined reason=missing_anchor")),
            ).toBe(true);
            expect(loadPersistedLkgSlot(db, "ses3")?.lastInputMessageId).toBe("m1");
        } finally {
            raw.close();
        }
    });
});

describe("LKG store honesty: load receipts its clears", () => {
    // `loadPersistedLkgSlot` clears a row whose slices assembled but whose
    // metadata failed to parse with no log line at all (only the slice
    // mismatch branch logs). A silent delete is how the live DB lost its slot
    // without ever saying so.
    it("names the parse failure before clearing an assembled-but-unparseable row", () => {
        const { db, raw } = fixture();
        try {
            lines.length = 0;
            const layout = layoutLkgPrefix("[]");
            raw.query(
                `INSERT INTO lkg_slots (session_id, json_prefix_chars, json_prefix_chunks,
                    json_prefix_hash, input_id_seq, input_content_digests,
                    input_content_signatures, last_input_message_id, model_key, provider_key,
                    captured_at, row_version, capture_sequence)
                 VALUES ('poison', ?, ?, ?, '["m1"]', '["digest-m1"]', NULL, '', 'test/model',
                    'test', 1, NULL, NULL)`,
            ).run(layout.chars, layout.chunks.length, layout.hash);
            layout.chunks.forEach((body, chunk) => {
                raw.query(
                    "INSERT INTO lkg_slot_chunks (session_id, chunk, hash, body) VALUES (?, ?, ?, ?)",
                ).run("poison", chunk, layout.chunkHashes[chunk], body);
            });

            expect(loadPersistedLkgSlot(db, "poison")).toBeUndefined();
            expect(
                lines.some((line) => line.includes("LKG snapshot parse failed; slot cleared")),
            ).toBe(true);
            expect(
                raw.query("SELECT COUNT(*) AS n FROM lkg_slots WHERE session_id = 'poison'").get(),
            ).toEqual({ n: 0 });
            // clearPersistedLkgSlot also removed the slices.
            expect(raw.query("SELECT COUNT(*) AS n FROM lkg_slot_chunks").get()).toEqual({ n: 0 });
        } finally {
            raw.close();
        }
    });
});

describe("LKG store honesty: captureLkgSlot names build failures", () => {
    // `captureLkgSlot` returned false when `buildLkgPrefix` said null, before
    // any reason was computed or logged; the transform lane then treats
    // `!captured` on a bust as grounds to dropSlot the durable row. The build
    // failure must be as loud as a refusal from the slot store itself.
    it("logs lkg_capture_declined with the build cause", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        const user = (id: string, created: number): MessageLike => ({
            info: {
                id,
                role: "user",
                sessionID: "session",
                model: { providerID: "test", modelID: "model" },
                time: { created },
            } as never,
            parts: [{ type: "text", text: id }],
        });
        const input = [user("u0", 1)];
        // An unsynthesized output message whose id never appeared in the
        // input: the adjacency walk refuses to classify it (unknown output).
        const output = [...input, user("ghost", 2)];
        expect(
            captureLkgSlot({
                sessionId: "build-fail",
                input,
                output,
                modelKey: "test/model",
                providerKey: "test",
            }),
        ).toBe(false);
        expect(lines.some((line) => line.includes("lkg_capture_declined reason=build_"))).toBe(
            true,
        );
        resetLkgSlotsForTest();
    });
});
