//! Workspace CRUD and schema-readiness for migration v34+.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use crate::db::{self, ProjectRow};
use crate::project_identity::{basename, normalize_stored_project_path};

pub const WORKSPACE_SCHEMA_VERSION: i64 = 34;

static WORKSPACE_READY_CACHE: OnceLock<Mutex<Option<bool>>> = OnceLock::new();

pub fn clear_workspace_schema_ready_cache_for_tests() {
    if let Some(m) = WORKSPACE_READY_CACHE.get() {
        if let Ok(mut g) = m.lock() {
            *g = None;
        }
    }
}

fn workspace_ready_cache() -> &'static Mutex<Option<bool>> {
    WORKSPACE_READY_CACHE.get_or_init(|| Mutex::new(None))
}

pub fn workspace_schema_ready(conn: &Connection) -> Result<bool, rusqlite::Error> {
    // Only a `true` verdict is cached: schemas never un-migrate, but a `false`
    // verdict can flip the moment a v34 plugin process migrates the shared DB
    // while the dashboard stays open — so not-ready must re-probe every call
    // (two sqlite_master lookups + one MAX(version), negligible).
    if let Ok(guard) = workspace_ready_cache().lock() {
        if *guard == Some(true) {
            return Ok(true);
        }
    }
    let ready = compute_workspace_schema_ready(conn)?;
    if ready {
        if let Ok(mut guard) = workspace_ready_cache().lock() {
            *guard = Some(true);
        }
    }
    Ok(ready)
}

fn compute_workspace_schema_ready(conn: &Connection) -> Result<bool, rusqlite::Error> {
    let has_migrations: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
        [],
        |row| row.get(0),
    )?;
    if has_migrations == 0 {
        return Ok(false);
    }
    let has_workspaces: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'",
        [],
        |row| row.get(0),
    )?;
    if has_workspaces == 0 {
        return Ok(false);
    }
    let max_version: i64 = conn.query_row(
        "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
        [],
        |row| row.get(0),
    )?;
    Ok(max_version >= WORKSPACE_SCHEMA_VERSION)
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceMemberView {
    pub project_path: String,
    pub display_name: String,
    pub display_path: String,
    pub memory_count: i64,
    pub added_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceListItem {
    pub id: i64,
    pub name: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub members: Vec<WorkspaceMemberView>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceSummary {
    pub id: i64,
    pub name: String,
}

pub fn list_workspaces(conn: &Connection) -> Result<Vec<WorkspaceListItem>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, updated_at FROM workspaces ORDER BY name ASC",
    )?;
    let rows: Vec<(i64, String, i64, i64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    let mut out = Vec::with_capacity(rows.len());
    for (id, name, created_at, updated_at) in rows {
        let members = list_workspace_members(conn, id)?;
        out.push(WorkspaceListItem {
            id,
            name,
            created_at,
            updated_at,
            members,
        });
    }
    Ok(out)
}

pub fn list_workspace_summaries(conn: &Connection) -> Result<Vec<WorkspaceSummary>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare("SELECT id, name FROM workspaces ORDER BY name ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(WorkspaceSummary {
            id: row.get(0)?,
            name: row.get(1)?,
        })
    })?;
    rows.collect()
}

fn list_workspace_members(
    conn: &Connection,
    workspace_id: i64,
) -> Result<Vec<WorkspaceMemberView>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT project_path, display_name, display_path, added_at
         FROM workspace_members WHERE workspace_id = ?1 ORDER BY display_name ASC",
    )?;
    let raw: Vec<(String, String, String, i64)> = stmt
        .query_map(params![workspace_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut members = Vec::with_capacity(raw.len());
    for (project_path, display_name, display_path, added_at) in raw {
        let count = db::count_memories_matching_identity(conn, &project_path)?;
        members.push(WorkspaceMemberView {
            project_path,
            display_name,
            display_path,
            memory_count: count,
            added_at,
        });
    }
    Ok(members)
}

pub fn workspace_member_identities(
    conn: &Connection,
    workspace_id: i64,
) -> Result<HashSet<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(HashSet::new());
    }
    let mut stmt =
        conn.prepare("SELECT project_path FROM workspace_members WHERE workspace_id = ?1")?;
    let rows = stmt.query_map(params![workspace_id], |row| row.get(0))?;
    rows.collect()
}

pub fn workspace_member_identities_for_project(
    conn: &Connection,
    identity: &str,
) -> Result<HashSet<String>, rusqlite::Error> {
    if identity.is_empty() || !workspace_schema_ready(conn)? {
        let mut s = HashSet::new();
        if !identity.is_empty() {
            s.insert(identity.to_string());
        }
        return Ok(s);
    }
    let workspace_id: Option<i64> = conn
        .query_row(
            "SELECT workspace_id FROM workspace_members WHERE project_path = ?1",
            params![identity],
            |row| row.get(0),
        )
        .optional()?;
    let Some(ws_id) = workspace_id else {
        let mut s = HashSet::new();
        s.insert(identity.to_string());
        return Ok(s);
    };
    workspace_member_identities(conn, ws_id)
}

pub fn display_name_for_memory_in_workspace(
    conn: &Connection,
    workspace_id: i64,
    memory_project_path: &str,
) -> Result<Option<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(None);
    }
    let memory_identity = normalize_stored_project_path(memory_project_path);
    let mut stmt = conn.prepare(
        "SELECT display_name, project_path FROM workspace_members WHERE workspace_id = ?1",
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![workspace_id], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    for (display_name, member_path) in rows {
        if normalize_stored_project_path(&member_path) == memory_identity
            || member_path == memory_project_path
        {
            return Ok(Some(display_name));
        }
    }
    Ok(None)
}

pub fn resolve_workspace_filter_paths(
    conn: &Connection,
    workspace_id: i64,
) -> Result<Vec<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let identities = workspace_member_identities(conn, workspace_id)?;
    let mut paths = HashSet::new();
    for identity in identities {
        let resolved = db::resolve_paths_for_memory_filter(conn, &identity)?;
        for p in resolved {
            paths.insert(p);
        }
    }
    let mut v: Vec<String> = paths.into_iter().collect();
    v.sort();
    Ok(v)
}

pub fn workspace_member_identities_union(
    old_members: &HashSet<String>,
    new_members: &HashSet<String>,
) -> HashSet<String> {
    old_members.union(new_members).cloned().collect()
}

pub fn bump_epochs_for_identities(
    tx: &Transaction<'_>,
    identities: &HashSet<String>,
) -> Result<(), rusqlite::Error> {
    for identity in identities {
        db::bump_project_memory_epoch_for_identity_pub(tx, identity)?;
    }
    Ok(())
}

pub fn bump_epochs_for_workspace_mutation(
    tx: &Transaction<'_>,
    old_members: &HashSet<String>,
    new_members: &HashSet<String>,
) -> Result<(), rusqlite::Error> {
    let union = workspace_member_identities_union(old_members, new_members);
    bump_epochs_for_identities(tx, &union)
}

pub fn bump_epochs_for_memory_identity(
    tx: &Transaction<'_>,
    conn: &Connection,
    identity: &str,
) -> Result<(), rusqlite::Error> {
    let set = workspace_member_identities_for_project(conn, identity)?;
    bump_epochs_for_identities(tx, &set)
}

pub fn workspace_member_picker_rows(conn: &Connection) -> Result<Vec<ProjectRow>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(Vec::new());
    }
    let mut stmt = conn.prepare(
        "SELECT project_path, display_name, display_path FROM workspace_members",
    )?;
    let rows: Vec<(String, String, String)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows
        .into_iter()
        .map(|(identity, display_name, display_path)| ProjectRow {
            identity: identity.clone(),
            display_name: if display_name.is_empty() {
                basename(&display_path)
            } else {
                display_name
            },
            primary_path: display_path,
            harnesses: Vec::new(),
            session_count: 0,
        })
        .collect())
}

pub fn extra_workspace_member_identities(conn: &Connection) -> Result<HashSet<String>, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Ok(HashSet::new());
    }
    let mut stmt = conn.prepare("SELECT DISTINCT project_path FROM workspace_members")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn validate_display_name(name: &str) -> Result<(), rusqlite::Error> {
    if name.trim().is_empty() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some("Display name cannot be empty.".to_string()),
        ));
    }
    Ok(())
}

fn display_name_taken_in_workspace(
    tx: &Transaction<'_>,
    workspace_id: i64,
    display_name: &str,
    exclude_project_path: Option<&str>,
) -> Result<bool, rusqlite::Error> {
    let existing: Option<String> = if let Some(exclude) = exclude_project_path {
        tx.query_row(
            "SELECT display_name FROM workspace_members
             WHERE workspace_id = ?1 AND display_name = ?2 AND project_path != ?3 LIMIT 1",
            params![workspace_id, display_name, exclude],
            |row| row.get(0),
        )
        .optional()?
    } else {
        tx.query_row(
            "SELECT display_name FROM workspace_members
             WHERE workspace_id = ?1 AND display_name = ?2 LIMIT 1",
            params![workspace_id, display_name],
            |row| row.get(0),
        )
        .optional()?
    };
    Ok(existing.is_some())
}

fn members_of_workspace(
    tx: &Transaction<'_>,
    workspace_id: i64,
) -> Result<HashSet<String>, rusqlite::Error> {
    let mut stmt =
        tx.prepare("SELECT project_path FROM workspace_members WHERE workspace_id = ?1")?;
    let rows = stmt.query_map(params![workspace_id], |row| row.get(0))?;
    rows.collect()
}

fn workspace_not_ready_error() -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(
        rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
        Some(
            "Workspaces are not available until the Magic Context plugin is updated.".to_string(),
        ),
    )
}

pub fn create_workspace(conn: &mut Connection, name: &str) -> Result<i64, rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some("Workspace name cannot be empty.".to_string()),
        ));
    }
    let now = now_millis();
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO workspaces (name, created_at, updated_at) VALUES (?1, ?2, ?2)",
        params![trimmed, now],
    )?;
    let id = tx.last_insert_rowid();
    tx.commit()?;
    Ok(id)
}

pub fn rename_workspace(
    conn: &mut Connection,
    workspace_id: i64,
    new_name: &str,
) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let trimmed = new_name.trim();
    if trimmed.is_empty() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some("Workspace name cannot be empty.".to_string()),
        ));
    }
    let now = now_millis();
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // No epoch bump: the workspace NAME is not rendered into m[0]/m[1] (only
    // member `display_name` affects the `source=` attribution), so renaming the
    // workspace must not force a hard m[0] re-fold in every member session.
    tx.execute(
        "UPDATE workspaces SET name = ?1, updated_at = ?2 WHERE id = ?3",
        params![trimmed, now, workspace_id],
    )?;
    tx.commit()?;
    Ok(())
}

pub fn delete_workspace(conn: &mut Connection, workspace_id: i64) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let old_members = members_of_workspace(&tx, workspace_id)?;
    tx.execute("DELETE FROM workspaces WHERE id = ?1", params![workspace_id])?;
    bump_epochs_for_workspace_mutation(&tx, &old_members, &HashSet::new())?;
    tx.commit()?;
    Ok(())
}

pub fn add_workspace_member(
    conn: &mut Connection,
    workspace_id: i64,
    project_path: String,
    display_name: String,
    display_path: String,
) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let identity = normalize_stored_project_path(&project_path);
    validate_display_name(&display_name)?;
    let now = now_millis();
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let old_members = members_of_workspace(&tx, workspace_id)?;
    if display_name_taken_in_workspace(&tx, workspace_id, &display_name, None)? {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some(format!(
                "Display name \"{}\" is already used in this workspace.",
                display_name
            )),
        ));
    }
    let existing_ws: Option<i64> = tx
        .query_row(
            "SELECT workspace_id FROM workspace_members WHERE project_path = ?1",
            params![identity],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(other) = existing_ws {
        if other != workspace_id {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
                Some("This project already belongs to another workspace.".to_string()),
            ));
        }
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some("This project is already a member of this workspace.".to_string()),
        ));
    }
    tx.execute(
        "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![workspace_id, identity, display_name, display_path, now],
    )?;
    tx.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![now, workspace_id],
    )?;
    let mut new_members = old_members.clone();
    new_members.insert(identity);
    bump_epochs_for_workspace_mutation(&tx, &old_members, &new_members)?;
    tx.commit()?;
    Ok(())
}

pub fn remove_workspace_member(
    conn: &mut Connection,
    workspace_id: i64,
    project_path: &str,
) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    let identity = normalize_stored_project_path(project_path);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let old_members = members_of_workspace(&tx, workspace_id)?;
    tx.execute(
        "DELETE FROM workspace_members WHERE workspace_id = ?1 AND project_path = ?2",
        params![workspace_id, identity],
    )?;
    let now = now_millis();
    tx.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![now, workspace_id],
    )?;
    let mut new_members = old_members.clone();
    new_members.remove(&identity);
    bump_epochs_for_workspace_mutation(&tx, &old_members, &new_members)?;
    tx.commit()?;
    Ok(())
}

pub fn set_member_display_name(
    conn: &mut Connection,
    workspace_id: i64,
    project_path: &str,
    display_name: String,
) -> Result<(), rusqlite::Error> {
    if !workspace_schema_ready(conn)? {
        return Err(workspace_not_ready_error());
    }
    validate_display_name(&display_name)?;
    let identity = normalize_stored_project_path(project_path);
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let old_members = members_of_workspace(&tx, workspace_id)?;
    if display_name_taken_in_workspace(&tx, workspace_id, &display_name, Some(&identity))? {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_CONSTRAINT),
            Some(format!(
                "Display name \"{}\" is already used in this workspace.",
                display_name
            )),
        ));
    }
    let updated = tx.execute(
        "UPDATE workspace_members SET display_name = ?1
         WHERE workspace_id = ?2 AND project_path = ?3",
        params![display_name, workspace_id, identity],
    )?;
    if updated == 0 {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTFOUND),
            Some("Workspace member not found.".to_string()),
        ));
    }
    let now = now_millis();
    tx.execute(
        "UPDATE workspaces SET updated_at = ?1 WHERE id = ?2",
        params![now, workspace_id],
    )?;
    bump_epochs_for_workspace_mutation(&tx, &old_members, &old_members)?;
    tx.commit()?;
    Ok(())
}
