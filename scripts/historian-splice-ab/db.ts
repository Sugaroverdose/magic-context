import { Database } from "bun:sqlite";
import { CONTEXT_DB, HOST_DB } from "./paths";

export function openContextDbRo(): Database {
    return new Database(CONTEXT_DB, { readonly: true });
}

export function openHostDbRo(): Database {
    return new Database(HOST_DB, { readonly: true });
}

/** Raw non-summary message count for a session — same predicate as countRawSessionMessageOrdinalsFromDb. */
export function rawMessageCount(host: Database, sessionId: string): number {
    const row = host.query(
        `SELECT COUNT(*) AS c FROM message WHERE session_id = ?
         AND NOT (COALESCE(json_extract(data,'$.summary'),0)=1 AND COALESCE(json_extract(data,'$.finish'),'')='stop')`,
    ).get(sessionId) as { c: number };
    return row.c;
}

export interface SessionRow {
    id: string;
    title: string;
    directory: string;
    raw_count: number;
}

export function censusSessions(minCount: number): SessionRow[] {
    const host = openHostDbRo();
    try {
        const sessions = host
            .query(
                `SELECT s.id AS id, s.title AS title, s.directory AS directory
                 FROM session s WHERE s.parent_id IS NULL`,
            )
            .all() as Array<{ id: string; title: string; directory: string }>;
        const out: SessionRow[] = [];
        for (const s of sessions) {
            const c = rawMessageCount(host, s.id);
            if (c >= minCount) out.push({ ...s, raw_count: c });
        }
        out.sort((a, b) => b.raw_count - a.raw_count);
        return out;
    } finally {
        host.close();
    }
}
