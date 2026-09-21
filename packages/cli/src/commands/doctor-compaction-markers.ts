import type { Database } from "@magic-context/core/shared/sqlite";

export interface OpenCodeCompactionMarkerConversionReport {
    missingBefore: number;
    missingAfter: number;
    repaired: number;
    migrationCompleted: boolean;
    migratedV2Schema: boolean;
    unmatchedConvertedMarkers: number;
    recoveryRequired: boolean;
}

function safeData(column = "data"): string {
    return `CASE WHEN json_valid(${column}) THEN ${column} ELSE '{}' END`;
}

function mcMarkerPredicate(column = "data"): string {
    const data = safeData(column);
    return `
        json_extract(${data}, '$.role') = 'assistant'
        AND json_extract(${data}, '$.summary') = 1
        AND json_extract(${data}, '$.providerID') = 'magic-context'`;
}

function tableExists(db: Pick<Database, "prepare">, table: string): boolean {
    return (
        db
            .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
            .get(table) != null
    );
}

function countMissingCompleted(db: Database): number {
    if (!tableExists(db, "message")) return 0;
    const row = db
        .prepare(
            `SELECT COUNT(*) AS count
               FROM message
              WHERE ${mcMarkerPredicate()}
                AND json_type(${safeData()}, '$.time.completed') IS NULL`,
        )
        .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
}

function migrationV1ToV2Completed(db: Database): boolean {
    if (!tableExists(db, "kv")) return false;
    const columns = db.prepare("PRAGMA table_info(kv)").all() as Array<{ name?: unknown }>;
    const names = new Set(
        columns.flatMap((column) => (typeof column.name === "string" ? [column.name] : [])),
    );
    if (!names.has("key") || !names.has("value")) return false;
    const row = db.prepare("SELECT value FROM kv WHERE key = 'migration.v1-v2' LIMIT 1").get() as
        | { value?: unknown }
        | undefined;
    if (typeof row?.value !== "string") return false;
    try {
        const parsed = JSON.parse(row.value) as { phase?: unknown };
        return parsed.phase === "completed";
    } catch {
        return false;
    }
}

function countUnmatchedConvertedMarkers(db: Database, migratedV2Schema: boolean): number {
    if (!migratedV2Schema || !tableExists(db, "message")) return 0;
    const row = db
        .prepare(
            `SELECT COUNT(DISTINCT json_extract(${safeData("marker.data")}, '$.parentID')) AS count
               FROM message marker
              WHERE ${mcMarkerPredicate("marker.data")}
                AND typeof(json_extract(${safeData("marker.data")}, '$.parentID')) = 'text'
                AND NOT EXISTS (
                    SELECT 1
                      FROM session_message converted
                     WHERE converted.id = json_extract(${safeData("marker.data")}, '$.parentID')
                       AND converted.type = 'compaction'
                )`,
        )
        .get() as { count?: number } | undefined;
    return Number(row?.count ?? 0);
}

/**
 * Check, and optionally repair, v1 compaction-summary rows before OpenCode 2 converts them.
 * Only summaries with Magic Context's provider identity are eligible; summaries written by
 * OpenCode itself keep their original data.
 */
export function checkOpenCodeCompactionMarkerConversion(
    db: Database,
    options: { fix?: boolean } = {},
): OpenCodeCompactionMarkerConversionReport {
    const missingBefore = countMissingCompleted(db);
    let repaired = 0;

    if (options.fix && missingBefore > 0 && tableExists(db, "message")) {
        repaired = db.transaction(() => {
            const result = db
                .prepare(
                    `UPDATE message
                        SET data = json_set(
                            data,
                            '$.time.completed',
                            json_extract(${safeData()}, '$.time.created')
                        )
                      WHERE ${mcMarkerPredicate()}
                        AND json_type(${safeData()}, '$.time.completed') IS NULL`,
                )
                .run() as { changes?: number };
            return Number(result.changes ?? 0);
        })();
    }

    const missingAfter = countMissingCompleted(db);
    const migratedV2Schema = tableExists(db, "session_v2") && tableExists(db, "session_message");
    const migrationCompleted = migrationV1ToV2Completed(db);
    const unmatchedConvertedMarkers = countUnmatchedConvertedMarkers(db, migratedV2Schema);

    return {
        missingBefore,
        missingAfter,
        repaired,
        migrationCompleted,
        migratedV2Schema,
        unmatchedConvertedMarkers,
        recoveryRequired: migrationCompleted && migratedV2Schema && unmatchedConvertedMarkers > 0,
    };
}

export function formatOpenCodeCompactionMarkerConversion(
    report: OpenCodeCompactionMarkerConversionReport,
): string {
    return `OpenCode compaction markers are convertible to OpenCode 2: before=${report.missingBefore} missing time.completed; after=${report.missingAfter}`;
}

export function formatOpenCodeV2ReconversionRecipe(databasePath: string): string[] {
    return [
        "OpenCode 2 already completed its v1→v2 conversion, but one or more Magic Context markers are absent from session_message.",
        "Recovery (with every OpenCode host stopped): clear only the kv.migration.v1-v2 marker, then restart the host once so it reconverts the v1 rows. Do not edit session_v2 or session_message by hand.",
        `Database: ${databasePath}`,
        "In sqlite3, run: DELETE FROM kv WHERE key = 'migration.v1-v2';",
        "Large-store conversion can take several minutes. `opencode service start` may kill the server as unresponsive while it runs; start `opencode serve --port N` by hand instead.",
        'Wait until `SELECT value FROM kv WHERE key = \'migration.v1-v2\';` reads `{"phase":"completed"}` before stopping that manual server (see note #3157).',
    ];
}
