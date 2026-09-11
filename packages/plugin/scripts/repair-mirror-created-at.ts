#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { getMagicContextStorageDir } from "../src/shared/data-path";
import { Database, withPrivilegedWriter } from "../src/shared/sqlite";

export const CREATED_AT_READER_AUDIT =
    "memories.created_at reader audit: dreamer curate uses the whole active pool (no created_at age gate; 0 does not change eligibility); dreamer verify gates on memory_verifications.verified_at and git change times (0 created_at does not change scope); the dashboard list query selects created_at but sorts and labels rows by rank/updated_at, while memory detail renders created_at (0 renders 1970 but does not change list order); memory decay/expiry uses expires_at and creation-time category TTLs (0 created_at does not expire a row).";

type RepairDisposition = "repairable" | "missing-module-row" | "ambiguous-module-rows" | "invalid-module-created-at";

interface ContextMirrorTimestampRow {
    id: number;
    project_path: string;
    normalized_hash: string;
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    last_seen_at: number;
    classified_at: number | null;
    verified_at: number | null;
}

interface ModuleTimestampRow {
    id: number;
    project_path: string;
    normalized_hash: string;
    first_seen_at: number;
    created_at: number;
    updated_at: number;
    last_seen_at: number;
    classified_at: number | null;
    verified_at: number | null;
}

export interface MirrorCreatedAtRepairRow {
    contextId: number;
    projectPath: string;
    normalizedHash: string;
    contextCreatedAt: number;
    moduleRowIds: number[];
    moduleCreatedAt: number | null;
    disposition: RepairDisposition;
}

export interface MirrorCreatedAtRepairReport {
    apply: boolean;
    candidates: MirrorCreatedAtRepairRow[];
    repaired: number;
}

interface PlannedRepair {
    context: ContextMirrorTimestampRow;
    source: ModuleTimestampRow | null;
    report: MirrorCreatedAtRepairRow;
}

function loadRepairPlan(contextDb: Database, moduleDb: Database): PlannedRepair[] {
    const contextRows = contextDb
        .prepare(
            `SELECT m.id, m.project_path, m.normalized_hash, m.first_seen_at, m.created_at,
                    m.updated_at, m.last_seen_at, m.classified_at, m.verified_at
               FROM memories AS m
              WHERE m.created_at = 0
                AND EXISTS (
                    SELECT 1
                      FROM mirror_identity AS identity
                     WHERE identity.domain = 'memories'
                       AND identity.context_row_id = m.id
                )
              ORDER BY m.project_path, m.id`,
        )
        .all() as ContextMirrorTimestampRow[];
    const moduleMatches = moduleDb.prepare(
        `SELECT id, project_path, normalized_hash, first_seen_at, created_at, updated_at,
                last_seen_at, classified_at, verified_at
           FROM mc_memories
          WHERE project_path = ? AND normalized_hash = ?
          ORDER BY id`,
    );

    return contextRows.map((context) => {
        const matches = moduleMatches.all(context.project_path, context.normalized_hash) as ModuleTimestampRow[];
        const source = matches.length === 1 ? (matches[0] ?? null) : null;
        const disposition: RepairDisposition =
            matches.length === 0
                ? "missing-module-row"
                : matches.length > 1
                  ? "ambiguous-module-rows"
                  : !source || source.created_at <= 0
                    ? "invalid-module-created-at"
                    : "repairable";
        return {
            context,
            source,
            report: {
                contextId: context.id,
                projectPath: context.project_path,
                normalizedHash: context.normalized_hash,
                contextCreatedAt: context.created_at,
                moduleRowIds: matches.map((match) => match.id),
                moduleCreatedAt: source?.created_at ?? null,
                disposition,
            },
        };
    });
}

export function repairMirrorCreatedAt(
    contextDb: Database,
    moduleDb: Database,
    options: { apply: boolean },
): MirrorCreatedAtRepairReport {
    const plan = loadRepairPlan(contextDb, moduleDb);
    if (!options.apply) {
        return { apply: false, candidates: plan.map((entry) => entry.report), repaired: 0 };
    }

    let repaired = 0;
    withPrivilegedWriter(contextDb, () => {
        const update = contextDb.prepare(
            `UPDATE memories
                SET first_seen_at = CASE WHEN first_seen_at = 0 THEN ? ELSE first_seen_at END,
                    created_at = ?,
                    updated_at = CASE WHEN updated_at = 0 THEN ? ELSE updated_at END,
                    last_seen_at = CASE WHEN last_seen_at = 0 THEN ? ELSE last_seen_at END,
                    classified_at = CASE WHEN COALESCE(classified_at, 0) = 0 THEN ? ELSE classified_at END,
                    verified_at = CASE WHEN COALESCE(verified_at, 0) = 0 THEN ? ELSE verified_at END
              WHERE id = ? AND created_at = 0`,
        );
        for (const entry of plan) {
            if (entry.report.disposition !== "repairable" || !entry.source) continue;
            const result = update.run(
                entry.source.first_seen_at,
                entry.source.created_at,
                entry.source.updated_at,
                entry.source.last_seen_at,
                entry.source.classified_at,
                entry.source.verified_at,
                entry.context.id,
            );
            if (Number(result.changes) > 0) repaired += 1;
        }
    });

    return { apply: true, candidates: plan.map((entry) => entry.report), repaired };
}

export function formatMirrorCreatedAtRepairReport(report: MirrorCreatedAtRepairReport): string {
    const lines = [
        `mode: ${report.apply ? "apply" : "dry-run"}`,
        CREATED_AT_READER_AUDIT,
        "context id | project | normalized hash | module ids | module created_at | disposition",
        "---: | --- | --- | --- | ---: | ---",
    ];
    if (report.candidates.length === 0) {
        lines.push("(none) | (none) | (none) | (none) | (none) | no candidates");
    } else {
        for (const row of report.candidates) {
            lines.push(
                `${row.contextId} | ${row.projectPath} | ${row.normalizedHash} | ${row.moduleRowIds.join(",") || "(none)"} | ${row.moduleCreatedAt ?? "(none)"} | ${row.disposition}`,
            );
        }
    }
    lines.push(`candidates: ${report.candidates.length}`);
    lines.push(`repaired: ${report.repaired}`);
    if (!report.apply) lines.push("no writes performed; rerun with --apply to repair these rows");
    return `${lines.join("\n")}\n`;
}

function parseArgs(argv: string[]): {
    apply: boolean;
    contextDbPath: string;
    moduleDbPath: string;
} {
    let apply = false;
    let explicitDryRun = false;
    let contextDbPath: string | undefined;
    let moduleDbPath: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--apply") {
            apply = true;
            continue;
        }
        if (arg === "--dry-run") {
            explicitDryRun = true;
            continue;
        }
        if (arg === "--context-db" || arg === "--module-db") {
            const value = argv[index + 1];
            if (!value || value.startsWith("--")) throw new Error(`${arg} requires a path`);
            if (arg === "--context-db") contextDbPath = resolve(value);
            else moduleDbPath = resolve(value);
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    if (apply && explicitDryRun) throw new Error("Choose either --dry-run or --apply, not both");
    const storageDir = getMagicContextStorageDir();
    return {
        apply,
        contextDbPath: contextDbPath ?? join(storageDir, "context.db"),
        moduleDbPath: moduleDbPath ?? join(storageDir, "store.db"),
    };
}

if (import.meta.main) {
    try {
        const args = parseArgs(process.argv.slice(2));
        if (!existsSync(args.contextDbPath)) {
            throw new Error(`context database not found: ${args.contextDbPath}`);
        }
        if (!existsSync(args.moduleDbPath)) {
            throw new Error(`module database not found: ${args.moduleDbPath}`);
        }
        const contextDb = new Database(args.contextDbPath, args.apply ? undefined : { readonly: true });
        const moduleDb = new Database(args.moduleDbPath, { readonly: true });
        try {
            const report = repairMirrorCreatedAt(contextDb, moduleDb, { apply: args.apply });
            process.stdout.write(formatMirrorCreatedAtRepairReport(report));
        } finally {
            moduleDb.close();
            contextDb.close();
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`repair-mirror-created-at: ${message}`);
        process.exitCode = 1;
    }
}
