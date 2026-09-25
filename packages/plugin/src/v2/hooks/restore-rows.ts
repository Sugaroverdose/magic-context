import type { StoreRow, V2StoreReader } from "../store-reader";

/** The reader surface the restore needs: 100-row pages plus an undecoded span check. */
export type RestoreRowReader = Pick<V2StoreReader, "page" | "spanFingerprint">;

interface CachedSpan {
    after: number;
    through: number;
    fingerprint: string;
    rows: StoreRow[];
}

/**
 * Keeps the rows an OpenCode 2 host checkpoint hid from the context draft, so each
 * pass decodes only the rows it has not seen yet.
 *
 * After a host checkpoint the draft starts at the checkpoint, and every pass has to put
 * back the rows between the last Magic Context boundary and the checkpoint. With no
 * boundary yet (a long session before its first compartment) that span is the whole
 * history before the checkpoint, and reading it again on every pass decoded the whole
 * session every turn. Rows before a completed checkpoint do not change once written,
 * so the decoded span is kept per session and only the part past the kept span is read,
 * one 100-row page at a time. Before reusing a kept span its row count, seq sum and
 * newest update time are checked with one aggregate query that decodes nothing; a host
 * revert or edit inside the span changes that fingerprint and forces a fresh read. The
 * rows handed back are the same rows a full read would return, so what the transform
 * serves does not change.
 */
export class RestoredRowCache {
    private readonly spans = new Map<string, CachedSpan>();

    constructor(private readonly capacity = 16) {}

    /** Rows with `after < seq <= through`, ascending by seq. */
    rows(reader: RestoreRowReader, sessionID: string, after: number, through: number): StoreRow[] {
        if (through <= after) return [];
        const cached = this.spans.get(sessionID);
        let rows: StoreRow[];
        if (
            cached &&
            cached.after <= after &&
            after <= cached.through &&
            cached.fingerprint === reader.spanFingerprint(sessionID, cached.after, cached.through)
        ) {
            const kept = cached.rows.filter((row) => row.seq > after && row.seq <= through);
            rows =
                through > cached.through
                    ? kept.concat(readPages(reader, sessionID, cached.through, through))
                    : kept;
        } else {
            rows = readPages(reader, sessionID, after, through);
        }
        this.spans.delete(sessionID);
        this.spans.set(sessionID, {
            after,
            through,
            fingerprint: reader.spanFingerprint(sessionID, after, through),
            rows,
        });
        // Keep only the most recently restored sessions; an evicted one reads cold once.
        while (this.spans.size > this.capacity) {
            const oldest = this.spans.keys().next().value;
            if (oldest === undefined) break;
            this.spans.delete(oldest);
        }
        // Restored messages share objects with their row's data, and the transform edits
        // the messages it is handed, so each pass gets its own copy of the kept rows.
        return structuredClone(rows);
    }

    forget(sessionID: string): void {
        this.spans.delete(sessionID);
    }

    clear(): void {
        this.spans.clear();
    }
}

function readPages(
    reader: RestoreRowReader,
    sessionID: string,
    after: number,
    through: number,
): StoreRow[] {
    const rows: StoreRow[] = [];
    let cursor = after;
    while (cursor < through) {
        const page = reader.page(sessionID, { after: cursor, through, limit: 100 });
        rows.push(...page.rows);
        if (page.rows.length < 100 || page.cursor === undefined) break;
        cursor = page.cursor;
    }
    return rows;
}
