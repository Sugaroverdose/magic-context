#!/usr/bin/env node
// Apply the module-store half of a repair-mirror-created-at plan to store.db.
//
// store.db guards mc_memories with BEFORE INSERT/UPDATE/DELETE triggers that call
// the SQLite functions mc_facade_authority_domain() and mc_facade_authority_route().
// The module registers those on its own connection; any other connection fails
// with "no such function". Outside a facade scope the module's functions return
// the empty string, so registering stubs that return "" gives this connection
// exactly the module's non-facade semantics: the triggers evaluate their WHEN to
// false and ordinary writes proceed. bun:sqlite cannot register functions, hence
// node:sqlite here.
//
// Usage: node apply-module-store-timestamps.mjs <plan.json> [--apply]
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [planPath, ...flags] = process.argv.slice(2);
if (!planPath) {
    console.error("usage: apply-module-store-timestamps.mjs <plan.json> [--apply]");
    process.exit(2);
}
const apply = flags.includes("--apply");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const db = new DatabaseSync(plan.moduleDbPath, { readOnly: !apply });
db.function("mc_facade_authority_domain", () => "");
db.function("mc_facade_authority_route", () => "");
db.function("mc_note_caller_project", () => "");
db.exec("PRAGMA busy_timeout = 5000");

const pending = db.prepare("SELECT COUNT(*) AS n FROM mc_memories WHERE created_at <= 0").get().n;
console.log(`module store: ${pending} rows with created_at <= 0; plan carries ${plan.rows.length}`);
if (!apply) {
    console.log("dry-run; rerun with --apply");
    db.close();
    process.exit(0);
}

const update = db.prepare(
    `UPDATE mc_memories
        SET first_seen_at = CASE WHEN first_seen_at <= 0 THEN ? ELSE first_seen_at END,
            created_at = ?,
            updated_at = CASE WHEN updated_at <= 0 THEN ? ELSE updated_at END,
            last_seen_at = CASE WHEN last_seen_at <= 0 THEN ? ELSE last_seen_at END
      WHERE rowid = ? AND created_at <= 0`,
);
db.exec("BEGIN IMMEDIATE");
let changed = 0;
try {
    for (const row of plan.rows) {
        const r = update.run(row.createdAt, row.createdAt, row.createdAt, row.createdAt, row.rowid);
        changed += Number(r.changes);
    }
    db.exec("COMMIT");
} catch (error) {
    db.exec("ROLLBACK");
    throw error;
}
const remaining = db.prepare("SELECT COUNT(*) AS n FROM mc_memories WHERE created_at <= 0").get().n;
console.log(`module store: updated ${changed} rows; ${remaining} still at created_at <= 0`);
db.close();
