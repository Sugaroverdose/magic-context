use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use magic_context_dashboard_lib::db;
use magic_context_dashboard_lib::workspaces;
use rusqlite::{params, Connection};

static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

fn make_db_v34() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (34);
         CREATE TABLE memories (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             project_path TEXT NOT NULL,
             category TEXT NOT NULL DEFAULT 'CONSTRAINTS',
             content TEXT NOT NULL,
             normalized_hash TEXT NOT NULL DEFAULT '',
             status TEXT DEFAULT 'active',
             created_at INTEGER DEFAULT 0,
             updated_at INTEGER DEFAULT 0,
             first_seen_at INTEGER DEFAULT 0,
             last_seen_at INTEGER DEFAULT 0,
             source_session_id TEXT,
             source_type TEXT DEFAULT 'test',
             seen_count INTEGER DEFAULT 1,
             retrieval_count INTEGER DEFAULT 0,
             last_retrieved_at INTEGER,
             expires_at INTEGER,
             verification_status TEXT DEFAULT 'unverified',
             verified_at INTEGER,
             superseded_by_memory_id INTEGER,
             merged_from TEXT,
             metadata_json TEXT
         );
         CREATE TABLE project_state (
             project_path TEXT PRIMARY KEY,
             project_memory_epoch INTEGER NOT NULL DEFAULT 0,
             project_user_profile_version INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL DEFAULT 0
         );
         CREATE TABLE workspaces (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL UNIQUE,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
         );
         CREATE TABLE workspace_members (
             workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
             project_path TEXT NOT NULL,
             display_name TEXT NOT NULL,
             display_path TEXT NOT NULL,
             added_at INTEGER NOT NULL,
             PRIMARY KEY (workspace_id, project_path)
         );
         CREATE UNIQUE INDEX idx_workspace_member_unique ON workspace_members(project_path);
         CREATE UNIQUE INDEX idx_workspace_member_name ON workspace_members(workspace_id, display_name);
         CREATE TABLE memory_embeddings (
             memory_id INTEGER PRIMARY KEY,
             embedding BLOB NOT NULL,
             model_id TEXT
         );",
    )
    .expect("schema");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    conn
}

fn make_db_pre_v34() -> Connection {
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY);
         INSERT INTO schema_migrations (version) VALUES (33);
         CREATE TABLE memories (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             project_path TEXT NOT NULL,
             category TEXT NOT NULL,
             content TEXT NOT NULL,
             normalized_hash TEXT NOT NULL,
             status TEXT DEFAULT 'active',
             created_at INTEGER DEFAULT 0,
             updated_at INTEGER DEFAULT 0,
             first_seen_at INTEGER DEFAULT 0,
             last_seen_at INTEGER DEFAULT 0,
             source_session_id TEXT,
             source_type TEXT DEFAULT 'test',
             seen_count INTEGER DEFAULT 1,
             retrieval_count INTEGER DEFAULT 0,
             last_retrieved_at INTEGER,
             expires_at INTEGER,
             verification_status TEXT DEFAULT 'unverified',
             verified_at INTEGER,
             superseded_by_memory_id INTEGER,
             merged_from TEXT,
             metadata_json TEXT
         );
         CREATE TABLE project_state (
             project_path TEXT PRIMARY KEY,
             project_memory_epoch INTEGER NOT NULL DEFAULT 0,
             project_user_profile_version INTEGER NOT NULL DEFAULT 0,
             updated_at INTEGER NOT NULL DEFAULT 0
         );",
    )
    .expect("schema");
    workspaces::clear_workspace_schema_ready_cache_for_tests();
    conn
}

fn seed_epoch(conn: &Connection, project: &str, epoch: i64) {
    conn.execute(
        "INSERT INTO project_state (project_path, project_memory_epoch, project_user_profile_version, updated_at)
         VALUES (?1, ?2, 0, 0)",
        params![project, epoch],
    )
    .expect("seed");
}

fn epoch(conn: &Connection, project: &str) -> i64 {
    conn.query_row(
        "SELECT project_memory_epoch FROM project_state WHERE project_path = ?1",
        params![project],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

#[test]
fn workspace_schema_ready_false_before_v34() {
    let _g = env_lock();
    let conn = make_db_pre_v34();
    assert!(!workspaces::workspace_schema_ready(&conn).unwrap());
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn workspace_schema_ready_true_at_v34() {
    let _g = env_lock();
    let conn = make_db_v34();
    assert!(workspaces::workspace_schema_ready(&conn).unwrap());
}

#[test]
fn workspace_crud_round_trip() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    let id = workspaces::create_workspace(&mut conn, "  team-alpha  ").expect("create");
    let list = workspaces::list_workspaces(&conn).expect("list");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "team-alpha");
    assert_eq!(list[0].id, id);

    workspaces::rename_workspace(&mut conn, id, "team-beta").expect("rename");
    let list = workspaces::list_workspaces(&conn).expect("list");
    assert_eq!(list[0].name, "team-beta");

    workspaces::delete_workspace(&mut conn, id).expect("delete");
    assert!(workspaces::list_workspaces(&conn).unwrap().is_empty());
}

#[test]
fn remove_member_epochs_old_and_new_union() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    seed_epoch(&conn, "git:aaa", 1);
    seed_epoch(&conn, "git:bbb", 2);
    seed_epoch(&conn, "git:ccc", 3);

    let ws = workspaces::create_workspace(&mut conn, "pool").unwrap();
    workspaces::add_workspace_member(
        &mut conn,
        ws,
        "git:aaa".into(),
        "svc-a".into(),
        "/a".into(),
    )
    .unwrap();
    workspaces::add_workspace_member(
        &mut conn,
        ws,
        "git:bbb".into(),
        "svc-b".into(),
        "/b".into(),
    )
    .unwrap();
    assert_eq!(epoch(&conn, "git:aaa"), 3);
    assert_eq!(epoch(&conn, "git:bbb"), 3);

    workspaces::remove_workspace_member(&mut conn, ws, "git:bbb").unwrap();
    assert_eq!(epoch(&conn, "git:aaa"), 4);
    assert_eq!(epoch(&conn, "git:bbb"), 4);
}

#[test]
fn display_name_unique_within_workspace() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    workspaces::add_workspace_member(
        &mut conn,
        ws,
        "git:a".into(),
        "dup".into(),
        "/a".into(),
    )
    .unwrap();
    let err = workspaces::add_workspace_member(
        &mut conn,
        ws,
        "git:b".into(),
        "dup".into(),
        "/b".into(),
    )
    .unwrap_err();
    assert!(err.to_string().contains("already used"));
}

#[test]
fn memory_status_restore_widens_epoch_fan_out() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    seed_epoch(&conn, "git:a", 5);
    seed_epoch(&conn, "git:b", 7);
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    workspaces::add_workspace_member(&mut conn, ws, "git:a".into(), "a".into(), "/a".into())
        .unwrap();
    workspaces::add_workspace_member(&mut conn, ws, "git:b".into(), "b".into(), "/b".into())
        .unwrap();

    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:a', 'CONSTRAINTS', 'x', 'h1', 'archived', 1, 1, 1, 1)",
        [],
    )
    .unwrap();
    let mid = conn.last_insert_rowid();

    db::update_memory_status(&mut conn, mid, "active").expect("restore");
    assert_eq!(epoch(&conn, "git:a"), 8);
    assert_eq!(epoch(&conn, "git:b"), 9);
}

#[test]
fn enumerate_memory_projects_includes_workspace_only_member() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    workspaces::add_workspace_member(
        &mut conn,
        ws,
        "git:zero-mem".into(),
        "zero".into(),
        "/zero".into(),
    )
    .unwrap();

    let rows = db::enumerate_memory_projects(&conn).expect("enum");
    assert!(rows.iter().any(|r| r.identity == "git:zero-mem"));
}

#[test]
fn workspace_filter_paths_union_members() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    let ws = workspaces::create_workspace(&mut conn, "w").unwrap();
    workspaces::add_workspace_member(&mut conn, ws, "git:x".into(), "x".into(), "/x".into())
        .unwrap();
    workspaces::add_workspace_member(&mut conn, ws, "git:y".into(), "y".into(), "/y".into())
        .unwrap();
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:x', 'C', 'one', 'h1', 'active', 1, 1, 1, 1),
                ('git:y', 'C', 'two', 'h2', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();

    let paths = workspaces::resolve_workspace_filter_paths(&conn, ws).unwrap();
    assert!(paths.contains(&"git:x".to_string()));
    assert!(paths.contains(&"git:y".to_string()));

    let mems = db::get_memories(&conn, None, Some(ws), None, None, None, 50, 0).unwrap();
    assert_eq!(mems.len(), 2);
}

#[test]
fn empty_workspace_filter_returns_no_memories_or_stats() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    // A workspace with ZERO members. There ARE global memories in the DB.
    let ws = workspaces::create_workspace(&mut conn, "empty").unwrap();
    conn.execute(
        "INSERT INTO memories (project_path, category, content, normalized_hash, status, created_at, updated_at, first_seen_at, last_seen_at)
         VALUES ('git:somewhere', 'C', 'global', 'h1', 'active', 1, 1, 1, 1),
                ('git:elsewhere', 'C', 'other', 'h2', 'active', 1, 1, 1, 1)",
        [],
    )
    .unwrap();

    // Filtering by the empty workspace must NOT leak global memories/stats.
    let mems = db::get_memories(&conn, None, Some(ws), None, None, None, 50, 0).unwrap();
    assert_eq!(mems.len(), 0, "empty workspace must not surface global memories");

    let stats = db::get_memory_stats(&conn, None, Some(ws)).unwrap();
    assert_eq!(stats.active, 0, "empty workspace stats must be zero");
    assert_eq!(stats.archived, 0);
    assert_eq!(stats.permanent, 0);

    // Sanity: no filter still sees the globals (the gate is filter-specific).
    let all = db::get_memories(&conn, None, None, None, None, None, 50, 0).unwrap();
    assert_eq!(all.len(), 2);
}

#[test]
fn rename_workspace_does_not_bump_member_epochs() {
    let _g = env_lock();
    let mut conn = make_db_v34();
    let ws = workspaces::create_workspace(&mut conn, "before").unwrap();
    workspaces::add_workspace_member(&mut conn, ws, "git:m".into(), "m".into(), "/m".into())
        .unwrap();
    let epoch_before: i64 = conn
        .query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:m'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);

    workspaces::rename_workspace(&mut conn, ws, "after").unwrap();

    let epoch_after: i64 = conn
        .query_row(
            "SELECT project_memory_epoch FROM project_state WHERE project_path = 'git:m'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    assert_eq!(
        epoch_before, epoch_after,
        "renaming the workspace must not fold member m[0] (name is not rendered)"
    );
}

#[test]
fn workspace_member_identities_union_helper() {
    let old: HashSet<String> = ["git:a".into(), "git:b".into()].into_iter().collect();
    let new: HashSet<String> = ["git:b".into(), "git:c".into()].into_iter().collect();
    let u = workspaces::workspace_member_identities_union(&old, &new);
    assert_eq!(u.len(), 3);
}
