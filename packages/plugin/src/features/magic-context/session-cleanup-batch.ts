import type { Database } from "../../shared/sqlite";
import { deleteChunkEmbedBackoffForCompartments } from "./compartment-chunk-embedding";
import { deleteSessionActivity } from "./session-activity";
import {
    type DeleteSessionScopedRowsOptions,
    SESSION_SCOPED_TABLES,
} from "./storage-session-tables";

export interface SessionCleanupBatchResult {
    rowsDeleted: number;
    completed: boolean;
    blocked: boolean;
}
const ROW_LIMIT = 25;
const primaryKeys = new WeakMap<Database, Map<string, string[]>>();
function keysFor(db: Database, table: string): string[] {
    let cache = primaryKeys.get(db);
    if (!cache) {
        cache = new Map();
        primaryKeys.set(db, cache);
    }
    let keys = cache.get(table);
    if (!keys) {
        const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(table) as {
            sql: string;
        };
        keys = /WITHOUT\s+ROWID/i.test(schema.sql)
            ? (
                  db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
                      name: string;
                      pk: number;
                  }>
              )
                  .filter(({ pk }) => pk > 0)
                  .sort((a, b) => a.pk - b.pk)
                  .map(({ name }) => name)
            : ["rowid"];
        cache.set(table, keys);
    }
    return keys;
}

/** Discover one table's small row slice without owning the writer. The returned
 * commit step must run inside BEGIN IMMEDIATE. The durable pending-cleanup row
 * stays until all eligible data is gone; no new schema or in-memory cursor is needed. */
export function prepareSessionCleanupBatch(
    db: Database,
    sessionId: string,
    harness?: string,
    options: DeleteSessionScopedRowsOptions = {},
): () => SessionCleanupBatchResult {
    const version = db.prepare("PRAGMA data_version").get() as { data_version: number };
    // Keep project coordinates until Rust acknowledgements and host cleanup have
    // completed. FTS rows and their locator map are removed together below.
    const tables = SESSION_SCOPED_TABLES.filter(
        ({ table }) =>
            ![
                "pending_session_cleanup",
                "message_history_fts",
                "session_projects",
                "lkg_slots",
            ].includes(table),
    );
    tables.push(...SESSION_SCOPED_TABLES.filter(({ table }) => table === "session_projects"));
    let selected:
        | {
              table: string;
              predicate: string;
              binds: Array<string>;
              keys: string[];
              rows: Array<Record<string, string | number>>;
          }
        | undefined;
    for (const definition of tables) {
        const predicates = ["session_id = ?"];
        const binds = [sessionId];
        if (definition.extraPredicate) predicates.push(definition.extraPredicate);
        if (harness !== undefined && definition.harnessScoped) {
            predicates.push("harness = ?");
            binds.push(harness);
        }
        const predicate = predicates.join(" AND ");
        const keys = keysFor(db, definition.table);
        const rows = db
            .prepare(`SELECT ${keys.map((key, i) => `${key} AS key_${i}`).join(",")}${definition.table === "session_projects" ? ", harness" : ""}
            FROM ${definition.table} WHERE ${predicate} LIMIT ${definition.table === "session_projects" ? ROW_LIMIT + 1 : ROW_LIMIT}`)
            .all(...binds) as Array<Record<string, string | number>>;
        if (rows.length) {
            selected = { table: definition.table, predicate, binds, keys, rows };
            break;
        }
    }
    return () => {
        const rust = db
            .prepare(`SELECT harness FROM pending_session_cleanup WHERE session_id=? AND harness LIKE '%:rust'
            ${harness === undefined ? "" : "AND harness=?"}`)
            .get(sessionId, ...(harness === undefined ? [] : [`${harness}:rust`])) as {
            harness: string;
        } | null;
        if (rust && !options.rustModuleCleanupAcknowledged)
            return { rowsDeleted: 0, completed: false, blocked: true };
        // Invalidate replay metadata before deleting any prefix or session rows.
        const invalidated = db
            .prepare("DELETE FROM lkg_slots WHERE session_id=?")
            .run(sessionId).changes;
        if (!selected) {
            // No external writer may insert rows between discovery and completion.
            const current = db.prepare("PRAGMA data_version").get() as { data_version: number };
            if (current.data_version !== version.data_version)
                return { rowsDeleted: invalidated, completed: false, blocked: false };
            db.prepare("DELETE FROM pending_session_cleanup WHERE session_id=?").run(sessionId);
            deleteSessionActivity(db, [sessionId]);
            return { rowsDeleted: invalidated, completed: true, blocked: false };
        }
        const { table, predicate, binds, keys } = selected;
        const finishing = table === "session_projects" && selected.rows.length <= ROW_LIMIT;
        if (finishing) {
            const current = db.prepare("PRAGMA data_version").get() as { data_version: number };
            if (current.data_version !== version.data_version)
                return { rowsDeleted: invalidated, completed: false, blocked: false };
        }
        // Never remove the Rust retry's project coordinate in a partial slice.
        const rows = selected.rows
            .filter(
                (row) =>
                    !rust ||
                    finishing ||
                    table !== "session_projects" ||
                    row.harness !== rust.harness.slice(0, -5),
            )
            .slice(0, ROW_LIMIT);
        const keyPredicate = rows
            .map(() => `(${keys.map((key) => `${key} = ?`).join(" AND ")})`)
            .join(" OR ");
        const keyBinds = rows.flatMap((row) => keys.map((_, i) => row[`key_${i}`]));
        if (table === "message_fts_rowid_map") {
            const locators = db
                .prepare(
                    `SELECT fts_rowid FROM message_fts_rowid_map WHERE (${keyPredicate}) AND ${predicate}`,
                )
                .all(...keyBinds, ...binds) as Array<{ fts_rowid: number }>;
            if (locators.length)
                db.prepare(
                    `DELETE FROM message_history_fts WHERE rowid IN (${locators.map(() => "?").join(",")}) AND session_id=?`,
                ).run(...locators.map(({ fts_rowid }) => fts_rowid), sessionId);
        }
        if (table === "compartments")
            deleteChunkEmbedBackoffForCompartments(
                db,
                rows.map((row) => Number(row.key_0)),
            );
        const deleted = db
            .prepare(`DELETE FROM ${table} WHERE (${keyPredicate}) AND ${predicate}`)
            .run(...keyBinds, ...binds).changes;
        if (finishing) {
            db.prepare("DELETE FROM pending_session_cleanup WHERE session_id=?").run(sessionId);
            deleteSessionActivity(db, [sessionId]);
        }
        return { rowsDeleted: invalidated + deleted, completed: finishing, blocked: false };
    };
}
