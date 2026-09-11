import { sessionLog } from "../../shared/logger";
import { isRecord } from "../../shared/record-type-guard";
import type { Database } from "../../shared/sqlite";
import { ensureSessionMetaRow } from "./storage-meta-shared";

const CAS_RETRY_LIMIT = 5;
const MISSING_REPLAY_DOCUMENT_COLUMN = Symbol("missing replay document column");

export type PersistedTrailingBlankDecision = "keep" | `keep:${number}` | "strip";

export interface ReplayDocument {
    version: 1 | 2;
    trailingBlank: Record<string, PersistedTrailingBlankDecision>;
    piNative?: unknown;
    [key: string]: unknown;
}

export function isPersistedTrailingBlankDecision(
    value: unknown,
): value is PersistedTrailingBlankDecision {
    if (value === "keep" || value === "strip") return true;
    if (typeof value !== "string" || !value.startsWith("keep:")) return false;
    const countText = value.slice("keep:".length);
    if (!/^[1-9]\d*$/.test(countText)) return false;
    const count = Number(countText);
    return Number.isSafeInteger(count) && count > 1 && count <= 10_000;
}

export class ReplayDocumentError extends Error {
    constructor(reason: string) {
        super(`invalid persisted replay document: ${reason}`);
        this.name = "ReplayDocumentError";
    }
}

function invalidReplayDocument(reason: string): ReplayDocumentError {
    return new ReplayDocumentError(reason);
}

type BlankParseMode = "strict" | "read";

function parseTrailingBlank(
    value: unknown,
    mode: BlankParseMode,
): Record<string, PersistedTrailingBlankDecision> {
    if (!isRecord(value)) {
        throw invalidReplayDocument("trailingBlank must be an object");
    }

    const entries: Array<[string, PersistedTrailingBlankDecision]> = [];
    for (const [id, decision] of Object.entries(value)) {
        if (id.length === 0 || !isPersistedTrailingBlankDecision(decision)) {
            if (mode === "read") continue;
            throw invalidReplayDocument("trailingBlank contains an invalid decision");
        }
        entries.push([id, decision]);
    }
    return Object.fromEntries(entries);
}

function parseV2ReplayDocument(
    parsed: Record<string, unknown>,
    mode: BlankParseMode,
): ReplayDocument {
    if (parsed.version !== 2) {
        throw invalidReplayDocument("unknown envelope version");
    }
    if (!Object.hasOwn(parsed, "trailingBlank")) {
        throw invalidReplayDocument("version 2 is missing trailingBlank");
    }

    return {
        ...parsed,
        version: 2,
        trailingBlank: parseTrailingBlank(parsed.trailingBlank, mode),
    };
}

/**
 * Decode the shared replay document. The historical v1 storage format is the
 * flat trailing-blank map itself; v2 is the namespaced envelope. Parsing is
 * deliberately strict so writers cannot turn an unrecognized document into a
 * new, lossy format.
 */
export function parseReplayDocument(
    raw: string | null | undefined,
    mode: BlankParseMode = "strict",
): ReplayDocument {
    if (raw === null || raw === undefined || raw === "") {
        return { version: 1, trailingBlank: {} };
    }
    if (typeof raw !== "string") {
        throw invalidReplayDocument("stored value is not text");
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw invalidReplayDocument("stored value is not JSON");
    }
    if (!isRecord(parsed)) {
        throw invalidReplayDocument("stored value is not an object");
    }

    // A legacy assistant may itself be named "version".
    if (Object.hasOwn(parsed, "version") && !isPersistedTrailingBlankDecision(parsed.version))
        return parseV2ReplayDocument(parsed, mode);

    return {
        version: 1,
        trailingBlank: parseTrailingBlank(parsed, mode),
    };
}

/** Serialize v1 as its historical flat map and v2 as its namespaced envelope. */
export function serializeReplayDocument(doc: ReplayDocument): string {
    const trailingBlank = parseTrailingBlank(doc.trailingBlank, "strict");
    if (doc.version === 1) return JSON.stringify(trailingBlank);
    if (doc.version !== 2) {
        throw invalidReplayDocument("unknown document version");
    }

    return JSON.stringify({
        ...doc,
        version: 2,
        trailingBlank,
    });
}

function isMissingReplayDocumentColumn(error: unknown): boolean {
    return (
        error instanceof Error && /no such column: trailing_blank_decisions/i.test(error.message)
    );
}

function readRawReplayDocument(
    db: Database,
    sessionId: string,
): string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN {
    try {
        const row = db
            .prepare("SELECT trailing_blank_decisions FROM session_meta WHERE session_id = ?")
            .get(sessionId) as { trailing_blank_decisions?: unknown } | undefined;
        const raw = row?.trailing_blank_decisions;
        if (raw === null || raw === undefined || typeof raw === "string") return raw;
        throw invalidReplayDocument("stored value is not text");
    } catch (error) {
        if (isMissingReplayDocumentColumn(error)) return MISSING_REPLAY_DOCUMENT_COLUMN;
        throw error;
    }
}

/** Read the raw document without creating session metadata. */
export function readReplayDocument(
    db: Database,
    sessionId: string,
    mode: BlankParseMode = "strict",
): ReplayDocument {
    const raw = readRawReplayDocument(db, sessionId);
    if (raw === MISSING_REPLAY_DOCUMENT_COLUMN) {
        return { version: 1, trailingBlank: {} };
    }
    return parseReplayDocument(raw, mode);
}

/**
 * Mutate the complete replay document with a bounded whole-column CAS. A false
 * result means either that the stored document was unreadable/unsupported, the
 * column is unavailable on an old schema, or all compare-and-swap attempts lost.
 * A mutator returning false is a successful byte-preserving no-op.
 */
export function updateReplayDocument(
    db: Database,
    sessionId: string,
    mutate: (doc: ReplayDocument) => boolean,
): boolean {
    let initial: string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN;
    try {
        initial = readRawReplayDocument(db, sessionId);
    } catch (error) {
        if (error instanceof ReplayDocumentError) return false;
        throw error;
    }
    if (initial === MISSING_REPLAY_DOCUMENT_COLUMN) return false;

    ensureSessionMetaRow(db, sessionId);
    for (let attempt = 0; attempt < CAS_RETRY_LIMIT; attempt += 1) {
        let raw: string | null | undefined | typeof MISSING_REPLAY_DOCUMENT_COLUMN;
        try {
            raw = readRawReplayDocument(db, sessionId);
        } catch (error) {
            if (error instanceof ReplayDocumentError) return false;
            throw error;
        }
        if (raw === MISSING_REPLAY_DOCUMENT_COLUMN) return false;

        let doc: ReplayDocument;
        try {
            doc = parseReplayDocument(raw);
        } catch (error) {
            if (error instanceof ReplayDocumentError) return false;
            throw error;
        }
        if (!mutate(doc)) return true;

        const next = serializeReplayDocument(doc);
        if (next === raw) return true;
        const result = db
            .prepare(
                "UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ? AND trailing_blank_decisions IS ?",
            )
            .run(next, sessionId, raw);
        if (result.changes > 0) return true;
    }

    sessionLog(sessionId, `trailing_blank_decisions CAS: ${CAS_RETRY_LIMIT} retries exhausted`);
    return false;
}
