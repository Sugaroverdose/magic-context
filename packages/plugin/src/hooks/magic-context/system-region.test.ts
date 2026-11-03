/// <reference types="bun-types" />

import { Database as BunDatabase } from "bun:sqlite";
import { describe, expect, it, mock } from "bun:test";

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

const {
    SYSTEM_REGION_SENTINEL,
    clearSystemRegion,
    encodeSystemRegionRow,
    decodeSystemRegionRow,
    readSystemRegion,
    writeSystemRegion,
} = await import("../../features/magic-context/system-region");

import type { Database } from "../../shared/sqlite";

function fixture(): { db: Database; raw: BunDatabase } {
    const raw = new BunDatabase(":memory:");
    raw.exec(`CREATE TABLE session_meta (
        session_id TEXT PRIMARY KEY,
        cached_m0_bytes BLOB
    );`);
    return { db: raw as unknown as Database, raw };
}

function seed(db: Database, sessionId: string, value: Buffer | null): void {
    db.prepare(
        "INSERT INTO session_meta (session_id, cached_m0_bytes) VALUES (?, ?) " +
            "ON CONFLICT(session_id) DO UPDATE SET cached_m0_bytes = excluded.cached_m0_bytes",
    ).run(sessionId, value);
}

describe("system-region store: R11 reader contract", () => {
    // The region BLOB reuses `session_meta.cached_m0_bytes` (owner ruling, no new
    // column). The reader contract is the real contract: a row written by the
    // head lane — or by any other writer — must NEVER be served as region bytes.
    it("treats an existing legacy row as first-render, never as region bytes", () => {
        const { db, raw } = fixture();
        try {
            // Exactly what the head lane stores today: the m[0] baseline text.
            seed(db, "ses", Buffer.from("<project-docs>...</project-docs>", "utf8"));
            expect(readSystemRegion(db, "ses")).toBeNull();
            // The legacy row is left untouched — first-render is a read verdict,
            // not a destructive migration.
            const legacy = (
                raw.query("SELECT cached_m0_bytes FROM session_meta").get() as {
                    cached_m0_bytes: Uint8Array;
                }
            ).cached_m0_bytes;
            expect(Buffer.from(legacy).toString("utf8")).toBe("<project-docs>...</project-docs>");
            expect(lines.some((line) => line.includes("system-region"))).toBe(false);
        } finally {
            raw.close();
        }
    });

    it("serves a region it wrote, byte-exact", () => {
        const { db, raw } = fixture();
        try {
            const region = "<project-docs>A</project-docs>\n\n<user-profile>B</user-profile>";
            expect(writeSystemRegion(db, "ses", region)).toBe(true);
            expect(readSystemRegion(db, "ses")).toBe(region);
            // Byte-exactness is the whole point of frozen residency: what was
            // written is what comes back, with no re-derivation.
            expect(readSystemRegion(db, "ses")).toBe(readSystemRegion(db, "ses"));
            // The stored form is the sentinel-prefixed payload.
            const stored = Buffer.from(
                (
                    raw.query("SELECT cached_m0_bytes FROM session_meta").get() as {
                        cached_m0_bytes: Uint8Array;
                    }
                ).cached_m0_bytes,
            ).toString("utf8");
            expect(stored.startsWith(SYSTEM_REGION_SENTINEL)).toBe(true);
            expect(stored.slice(SYSTEM_REGION_SENTINEL.length)).toBe(region);
        } finally {
            raw.close();
        }
    });

    it("refuses a content string that would forge the sentinel", () => {
        const { db } = fixture();
        try {
            expect(writeSystemRegion(db, "forge", `${SYSTEM_REGION_SENTINEL}forged`)).toBe(false);
            expect(lines.some((line) => line.includes("system-region write declined"))).toBe(true);
            expect(readSystemRegion(db, "forge")).toBeNull();
        } finally {
            db.close?.();
        }
    });

    it("refuses an empty region — the placeholder-floor law", () => {
        const { db } = fixture();
        try {
            expect(writeSystemRegion(db, "empty", "")).toBe(false);
            expect(
                lines.some((line) =>
                    line.includes("system-region write declined session=empty reason=empty_region"),
                ),
            ).toBe(true);
            expect(readSystemRegion(db, "empty")).toBeNull();
        } finally {
            db.close?.();
        }
    });

    it("returns null for absent rows, NULL columns, and undecodable blobs, each with a receipt on corrupt", () => {
        const { db, raw } = fixture();
        try {
            expect(readSystemRegion(db, "missing")).toBeNull();
            seed(db, "nul", null);
            expect(readSystemRegion(db, "nul")).toBeNull();
            // A blob that can only have been a region (sentinel-prefixed) yet cannot
            // decode as UTF-8 text is corrupt: refuse loudly, serve nothing, crash
            // never. A non-UTF-8 blob is corrupt regardless of prefix — no honest
            // writer ever stored it. Valid UTF-8 without the full sentinel prefix is
            // treated as a legacy row: a silent first-render, not an incident.
            seed(db, "corrupt", Buffer.from([0xff, 0xfe, 0x00, 0x80]));
            expect(readSystemRegion(db, "corrupt")).toBeNull();
            seed(db, "truncated", Buffer.from(SYSTEM_REGION_SENTINEL.slice(0, 8), "utf8"));
            expect(readSystemRegion(db, "truncated")).toBeNull();
            expect(
                lines.some((line) => line.includes("system-region read declined session=corrupt")),
            ).toBe(true);
            expect(
                lines.some((line) =>
                    line.includes("system-region read declined session=truncated"),
                ),
            ).toBe(false);
        } finally {
            raw.close();
        }
    });

    it("clear leaves a receipt and removes the row payload", () => {
        const { db } = fixture();
        try {
            expect(writeSystemRegion(db, "ses", "content")).toBe(true);
            lines.length = 0;
            clearSystemRegion(db, "ses", "lane_teardown");
            expect(readSystemRegion(db, "ses")).toBeNull();
            expect(
                lines.some((line) => line.includes("system-region cleared reason=lane_teardown")),
            ).toBe(true);
        } finally {
            db.close?.();
        }
    });

    it("encode/decode round-trip is the serve-path identity", () => {
        // The serve path must hand the model the stored payload verbatim: decode
        // is exactly strip-the-sentinel, nothing else (no trim, no newline fixups
        // — any normalization there is a byte-re-derivation and forbidden).
        const tricky = "\n\n  <x>y</x>  \n\n";
        expect(decodeSystemRegionRow(encodeSystemRegionRow(tricky))).toBe(tricky);
        expect(decodeSystemRegionRow(null)).toBeNull();
        expect(decodeSystemRegionRow(Buffer.from("", "utf8"))).toBeNull();
        expect(decodeSystemRegionRow("plain legacy text")).toBeNull();
    });
});
