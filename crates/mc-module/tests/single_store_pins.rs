//! Tests for the properties the single-store writers must hold before `single_store` can
//! be turned on: a publish that is interrupted can be retried, the module and the host
//! leave a session with the same compartment rows, every transaction is held to a row
//! budget, a host migration refuses only the tables it changed, and a writer that loses
//! its busy timeout says so by name.
//!
//! Each test drives the real writer in `mc_module::host_store` against a fixture built
//! from the committed `context.db` schema snapshot. Interruptions are real: the kill test
//! re-executes this binary as a child and SIGKILLs it between two of its own commits.
//!
//! Production isolation: every database is created fresh under the system temp directory.
//! Nothing here opens a real `context.db`.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use mc_module::host_store::{
    self, FoldPublish, HostCompartment, HostCompartmentEvent, HostMemory, HostNote,
    HostPrimerCandidate, HostSessionFact, HostStore, HostUserObservation, SingleStoreMode,
    BUILT_CONTEXT_FENCE_VERSION, DOMAIN_TABLES,
};
use rusqlite::{params, Connection};

const SCHEMA_SNAPSHOT: &str = include_str!("fixtures/context-db-schema.sql");
const PROJECT: &str = "git:pins";
const NOW_MS: i64 = 1_700_000_000_000;

/// Tests that set the process-wide mode or environment cannot run beside each other.
fn env_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn fixture_db(dir: &Path, name: &str) -> PathBuf {
    let path = dir.join(name);
    let conn = Connection::open(&path).expect("open fixture");
    conn.execute_batch(SCHEMA_SNAPSHOT).expect("apply schema");
    // A real context.db is already in WAL. Leaving the fixture on the default journal
    // mode would make the module's own WAL pragma a write that needs exclusive access.
    conn.pragma_update(None, "journal_mode", "WAL")
        .expect("put the fixture in WAL");
    conn.execute(
        "INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES (1, 0)",
        [],
    )
    .expect("seed privilege row");
    // Managed, so the authority guards are live and every write has to take the bracket.
    conn.execute(
        "INSERT OR REPLACE INTO authority_managed(project_path, context_store_uuid, marked_at)
         VALUES (?1, 'pins', 1)",
        params![PROJECT],
    )
    .expect("mark the project managed");
    path
}

fn publish_of(session: &str, memories: usize, compartments: usize) -> FoldPublish {
    FoldPublish {
        session_id: session.to_string(),
        project_path: PROJECT.to_string(),
        harness: "opencode".to_string(),
        now_ms: NOW_MS,
        compartments: (0..compartments)
            .map(|index| HostCompartment {
                sequence: index as i64 + 1,
                start_message: index as i64 * 4 + 1,
                end_message: index as i64 * 4 + 4,
                start_message_id: format!("msg_{index}_a"),
                end_message_id: format!("msg_{index}_d"),
                title: format!("compartment {index}"),
                content: format!("body {index}"),
                p1: Some(format!("body {index}")),
                importance: Some(60),
                created_at: NOW_MS,
                ..HostCompartment::default()
            })
            .collect(),
        facts: vec![HostSessionFact {
            category: "Decisions".to_string(),
            content: format!("{session} decided something"),
        }],
        events: vec![HostCompartmentEvent {
            kind: "causal_incident".to_string(),
            at_compartment: Some(1),
            fields_json: "{}".to_string(),
        }],
        memories: (0..memories)
            .map(|index| HostMemory {
                category: "ARCHITECTURE".to_string(),
                content: format!("{session} memory {index} with enough prose to index"),
                source_session_id: Some(session.to_string()),
                ..HostMemory::default()
            })
            .collect(),
        notes: vec![HostNote {
            content: format!("{session} note"),
            anchor_ordinal: Some(4),
        }],
        primer_candidates: vec![HostPrimerCandidate {
            question: "How does the fence work?".to_string(),
            source_compartment_start: Some(1),
            source_compartment_end: Some(4),
            source_start_message_id: "msg_0_a".to_string(),
            source_end_message_id: "msg_0_d".to_string(),
            source_message_time: NOW_MS - 1_000,
            created_at: NOW_MS,
        }],
        user_observations: vec![HostUserObservation {
            content: "prefers terse answers".to_string(),
            source_compartment_start: Some(1),
            source_compartment_end: Some(4),
            created_at: NOW_MS,
        }],
        user_memories: Vec::new(),
        user_memory_collection_enabled: true,
    }
}

fn count(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

/// Every row a publish can leave behind for one session, as comparable text.
///
/// Ids are excluded: they are assigned by the database, so a row that was written once
/// and a row that was written, deleted and written again differ only there.
fn session_rows(path: &Path, session: &str) -> Vec<String> {
    let conn = Connection::open(path).unwrap();
    let mut rows = Vec::new();
    let queries: &[(&str, &str)] = &[
        (
            "compartments",
            "SELECT sequence || '|' || title || '|' || content || '|' || harness
               FROM compartments WHERE session_id = ?1 ORDER BY sequence",
        ),
        (
            "session_facts",
            "SELECT category || '|' || content FROM session_facts
              WHERE session_id = ?1 ORDER BY category, content",
        ),
        (
            "compartment_events",
            "SELECT e.kind || '|' || COALESCE(e.at_compartment, '') || '|' ||
                    COALESCE((SELECT sequence FROM compartments c WHERE c.id = e.compartment_id), 'none')
               FROM compartment_events e WHERE e.session_id = ?1 ORDER BY e.kind, e.at_compartment",
        ),
        (
            "memories",
            "SELECT content || '|seen=' || seen_count FROM memories
              WHERE source_session_id = ?1 ORDER BY content",
        ),
        (
            "notes",
            "SELECT content || '|' || created_at FROM notes WHERE session_id = ?1 ORDER BY content",
        ),
        (
            "primer_candidates",
            "SELECT normalized_question || '|' || harness FROM primer_candidates
              WHERE session_id = ?1 ORDER BY normalized_question",
        ),
        (
            "user_memory_candidates",
            "SELECT content || '|' || created_at FROM user_memory_candidates
              WHERE session_id = ?1 ORDER BY content",
        ),
    ];
    for (table, sql) in queries {
        let mut statement = conn.prepare(sql).unwrap();
        let values = statement
            .query_map(params![session], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        for value in values {
            rows.push(format!("{table}: {value}"));
        }
    }
    rows
}

// ── Retry after an interrupted publish ──────────────────────────────────────

const CHILD_DB_ENV: &str = "SINGLE_STORE_PINS_CHILD_DB";
const CHILD_KILL_AFTER_ENV: &str = "SINGLE_STORE_PINS_CHILD_KILL_AFTER";
const CHILD_SESSION: &str = "ses_killed";
const CHILD_MEMORIES: usize = 10;
const CHILD_BUDGET: usize = 4;

/// The publish the kill test interrupts. Ignored so it never runs as part of the suite:
/// it is a program the kill test executes, not a claim of its own.
///
/// After the chunk named by the environment commits, it prints a marker line and parks,
/// so the parent's SIGKILL lands between two commits rather than at a guessed instant.
#[test]
#[ignore = "re-executed as a child process by the kill test"]
fn child_publish_for_the_kill_test() {
    use std::io::Write;
    let db = PathBuf::from(std::env::var(CHILD_DB_ENV).expect("child database path"));
    let kill_after: usize = std::env::var(CHILD_KILL_AFTER_ENV)
        .expect("chunk to stop after")
        .parse()
        .expect("chunk index");
    let mut store = HostStore::open(&db).expect("child opens the fixture");
    store.set_chunk_budget(CHILD_BUDGET);
    let publish = publish_of(CHILD_SESSION, CHILD_MEMORIES, 2);
    let _ = store.publish_fold_observed(&publish, &mut |chunk| {
        if chunk.index == kill_after {
            let mut out = std::io::stdout().lock();
            writeln!(out, "CHUNK_COMMITTED {}", chunk.index).unwrap();
            out.flush().unwrap();
            loop {
                std::thread::sleep(Duration::from_secs(60));
            }
        }
    });
    panic!("the child finished its publish instead of parking after chunk {kill_after}");
}

/// A publish SIGKILLed between two of its chunks, then retried, ends with exactly the
/// rows one uninterrupted publish leaves: no duplicated note or observation, no memory
/// seen twice, and a fold that becomes visible.
///
/// The kill is placed after every staged chunk in turn, so the retry meets each shape of
/// leftover: some memories only, all memories, and every standalone row with no fold.
#[test]
fn a_publish_killed_between_chunks_is_resumed_by_the_retry_without_duplicates() {
    let exe = std::env::current_exe().expect("test binary path");
    let reference_dir = tempfile::tempdir().unwrap();
    let reference = fixture_db(reference_dir.path(), "context.db");
    {
        let mut store = HostStore::open(&reference).unwrap();
        store.set_chunk_budget(CHILD_BUDGET);
        store
            .publish_fold(&publish_of(CHILD_SESSION, CHILD_MEMORIES, 2))
            .unwrap();
    }
    let expected = session_rows(&reference, CHILD_SESSION);
    assert!(expected.iter().any(|row| row.starts_with("notes:")));

    // With a four-row budget and ten memories the staged chunks are
    // [4 memories] [4 memories] [2 memories + note + primer + observation].
    for kill_after in 0..3 {
        let dir = tempfile::tempdir().unwrap();
        let path = fixture_db(dir.path(), "context.db");
        let mut child = std::process::Command::new(&exe)
            .arg("--exact")
            .arg("child_publish_for_the_kill_test")
            .arg("--ignored")
            .arg("--nocapture")
            .arg("--test-threads=1")
            .env(CHILD_DB_ENV, &path)
            .env(CHILD_KILL_AFTER_ENV, kill_after.to_string())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn the child publisher");
        let stdout = child.stdout.take().unwrap();
        let mut reached = false;
        for line in BufReader::new(stdout).lines() {
            let line = line.unwrap();
            // libtest prints the test name on the same line before the marker.
            if line.contains("CHUNK_COMMITTED") {
                reached = true;
                break;
            }
        }
        assert!(reached, "the child never reported chunk {kill_after}");
        // Child::kill is SIGKILL on Unix: no destructor, no rollback hook, no flush.
        child.kill().expect("SIGKILL the child");
        child.wait().unwrap();

        {
            let conn = Connection::open(&path).unwrap();
            assert_eq!(
                count(
                    &conn,
                    &format!("SELECT COUNT(*) FROM compartments WHERE session_id = '{CHILD_SESSION}'")
                ),
                0,
                "a kill after staged chunk {kill_after} left a visible fold"
            );
            assert!(
                count(
                    &conn,
                    &format!(
                        "SELECT COUNT(*) FROM memories WHERE source_session_id = '{CHILD_SESSION}'"
                    )
                ) > 0,
                "the kill after chunk {kill_after} landed before anything was staged"
            );
        }

        let mut store = HostStore::open(&path).unwrap();
        store.set_chunk_budget(CHILD_BUDGET);
        store
            .publish_fold(&publish_of(CHILD_SESSION, CHILD_MEMORIES, 2))
            .unwrap_or_else(|error| {
                panic!("the retry after a kill after chunk {kill_after} failed: {error}")
            });
        assert_eq!(
            session_rows(&path, CHILD_SESSION),
            expected,
            "the retry after a kill after chunk {kill_after} did not converge on one publish's rows"
        );
    }
}

/// Retrying a publish whose visibility chunk already committed changes nothing: the
/// same rows, the same seen counts, and no constraint error.
#[test]
fn retrying_a_publish_that_already_completed_leaves_the_same_rows() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    let publish = publish_of("ses_twice", 6, 2);

    let mut store = HostStore::open(&path).unwrap();
    store.set_chunk_budget(4);
    store.publish_fold(&publish).unwrap();
    let once = session_rows(&path, "ses_twice");

    let mut again = HostStore::open(&path).unwrap();
    again.set_chunk_budget(4);
    again
        .publish_fold(&publish)
        .unwrap_or_else(|error| panic!("the retry failed: {error} ({})", error.code()));
    assert_eq!(session_rows(&path, "ses_twice"), once);
}

/// A later publish is not a retry: a memory the module already wrote is seen again at a
/// new instant, exactly as before this fix.
#[test]
fn a_later_publish_of_the_same_memory_still_counts_as_seen_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    let mut store = HostStore::open(&path).unwrap();
    let first = publish_of("ses_seen", 1, 1);
    store.publish_fold(&first).unwrap();

    let mut later = publish_of("ses_seen", 1, 0);
    later.now_ms = NOW_MS + 60_000;
    later.notes.clear();
    later.user_observations.clear();
    later.primer_candidates.clear();
    later.facts = first.facts.clone();
    store.publish_fold(&later).unwrap();

    let conn = Connection::open(&path).unwrap();
    let (seen, last_seen): (i64, i64) = conn
        .query_row(
            "SELECT seen_count, last_seen_at FROM memories WHERE source_session_id = 'ses_seen'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(seen, 2);
    assert_eq!(last_seen, NOW_MS + 60_000);
}

// ── One compartment contract for both writers ───────────────────────────────

/// The module's visibility chunk leaves the session with the row set the host's
/// `replaceAllCompartmentState` leaves when handed the kept prefix plus this publish:
/// rows below the publish's first sequence stay, rows at or above it are replaced, and
/// the events that pointed at a replaced row go with it.
///
/// It does not touch `session_meta`. A historian publish must never originate a cache
/// bust; the host's own incremental fold (`appendCompartments`) clears nothing either, and
/// the new rows reach m0/m1 through the compartment marker on the next busting pass.
#[test]
fn a_republish_replaces_the_sessions_compartments_from_its_first_sequence() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    let session = "ses_replace";
    {
        let conn = Connection::open(&path).unwrap();
        for (sequence, title) in [(1, "kept"), (2, "stale two"), (3, "stale three")] {
            conn.execute(
                "INSERT INTO compartments
                   (session_id, sequence, start_message, end_message, title, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1)",
                params![session, sequence, sequence * 4 - 3, sequence * 4, title],
            )
            .unwrap();
        }
        let stale_id: i64 = conn
            .query_row(
                "SELECT id FROM compartments WHERE session_id = ?1 AND sequence = 2",
                params![session],
                |row| row.get(0),
            )
            .unwrap();
        let kept_id: i64 = conn
            .query_row(
                "SELECT id FROM compartments WHERE session_id = ?1 AND sequence = 1",
                params![session],
                |row| row.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO compartment_events (session_id, compartment_id, kind, at_compartment, created_at)
             VALUES (?1, ?2, 'stale_event', 1, 1), (?1, ?3, 'kept_event', 1, 1)",
            params![session, stale_id, kept_id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_meta (session_id, cached_m0_bytes, cached_m1_bytes, cached_m0_system_hash,
                                       cached_m0_max_compartment_seq, memory_block_cache)
             VALUES (?1, X'6d30', X'6d31', 'sys-hash', 3, 'block')",
            params![session],
        )
        .unwrap();
    }
    let meta_before = session_meta_row(&path, session);

    let mut publish = publish_of(session, 0, 2);
    for (index, compartment) in publish.compartments.iter_mut().enumerate() {
        compartment.sequence = index as i64 + 2;
        compartment.title = format!("new {}", index + 2);
    }
    publish.notes.clear();
    publish.primer_candidates.clear();
    publish.user_observations.clear();
    let mut store = HostStore::open(&path).unwrap();
    store
        .publish_fold(&publish)
        .unwrap_or_else(|error| panic!("the republish failed: {error} ({})", error.code()));

    let conn = Connection::open(&path).unwrap();
    let titles: Vec<(i64, String)> = conn
        .prepare("SELECT sequence, title FROM compartments WHERE session_id = ?1 ORDER BY sequence")
        .unwrap()
        .query_map(params![session], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        titles,
        vec![
            (1, "kept".to_string()),
            (2, "new 2".to_string()),
            (3, "new 3".to_string())
        ]
    );
    let kinds: Vec<String> = conn
        .prepare("SELECT kind FROM compartment_events WHERE session_id = ?1 ORDER BY kind")
        .unwrap()
        .query_map(params![session], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(
        kinds,
        vec!["causal_incident".to_string(), "kept_event".to_string()],
        "the event that pointed at a replaced compartment must go with it"
    );
    assert_eq!(
        session_meta_row(&path, session),
        meta_before,
        "a historian publish must not touch the session's cached m0/m1"
    );
}

fn session_meta_row(path: &Path, session: &str) -> String {
    let conn = Connection::open(path).unwrap();
    conn.query_row(
        "SELECT quote(cached_m0_bytes) || quote(cached_m1_bytes) || quote(cached_m0_system_hash)
                || quote(cached_m0_max_compartment_seq) || quote(memory_block_cache)
           FROM session_meta WHERE session_id = ?1",
        params![session],
        |row| row.get(0),
    )
    .unwrap()
}

// ── The visibility chunk is bounded ─────────────────────────────────────────

/// A fold whose compartments, facts and events together exceed the visibility budget is
/// refused before its first chunk, so nothing of it is staged.
#[test]
fn a_visibility_chunk_over_its_budget_is_refused_before_anything_is_written() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    let mut store = HostStore::open(&path).unwrap();
    let mut publish = publish_of("ses_huge", 3, 400);
    publish.facts = (0..400)
        .map(|index| HostSessionFact {
            category: "Decisions".to_string(),
            content: format!("fact {index}"),
        })
        .collect();

    let error = store
        .publish_fold(&publish)
        .expect_err("an unbounded visibility chunk must be refused");
    assert_eq!(error.code(), "single_store_chunk_budget_exceeded");

    let conn = Connection::open(&path).unwrap();
    assert_eq!(count(&conn, "SELECT COUNT(*) FROM compartments"), 0);
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memories"),
        0,
        "a publish refused for its visibility chunk staged rows first"
    );
}

// ── The fence is per table ──────────────────────────────────────────────────

/// A host migration that touches no domain table moves the lane past this binary and
/// leaves every domain table writable: the fingerprints are what say a table changed.
#[test]
fn a_migration_that_touches_no_domain_table_leaves_every_domain_table_writable() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO schema_migrations (version, description, applied_at)
               VALUES ({}, 'unrelated', 0);
             CREATE TABLE dashboard_widgets (id INTEGER PRIMARY KEY, name TEXT);
             CREATE INDEX idx_pending_ops_extra ON pending_ops(session_id);",
            BUILT_CONTEXT_FENCE_VERSION + 1
        ))
        .unwrap();
    }
    let mut store = HostStore::open(&path).unwrap();
    assert_eq!(
        store.fence().persisted_version,
        BUILT_CONTEXT_FENCE_VERSION + 1
    );
    assert!(store.fence().lane_ahead());
    assert_eq!(
        store.writable_tables(),
        DOMAIN_TABLES.to_vec(),
        "an unrelated migration refused a domain table"
    );
    store
        .publish_fold(&publish_of("ses_unrelated", 3, 1))
        .unwrap_or_else(|error| panic!("{error} ({})", error.code()));
}

/// A host migration that alters one domain table fails that table closed with a typed
/// state and leaves the others writable. A publish that does not write the altered table
/// still lands; one that does is refused by that table's name.
#[test]
fn a_migration_that_alters_one_domain_table_fails_only_that_table_closed() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(&format!(
            "INSERT INTO schema_migrations (version, description, applied_at)
               VALUES ({}, 'notes gain a column', 0);
             ALTER TABLE notes ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;",
            BUILT_CONTEXT_FENCE_VERSION + 1
        ))
        .unwrap();
    }
    let mut store = HostStore::open(&path).unwrap();
    let writable = store.writable_tables();
    assert!(!writable.contains(&"notes"));
    assert_eq!(writable.len(), DOMAIN_TABLES.len() - 1);

    let health = store.health_value(SingleStoreMode::Shadow);
    assert_eq!(health["tables"]["notes"]["writable"], false);
    assert_eq!(
        health["tables"]["notes"]["error_code"],
        "single_store_fingerprint_mismatch"
    );
    assert_eq!(health["tables"]["memories"]["writable"], true);

    let mut without_notes = publish_of("ses_no_notes", 3, 1);
    without_notes.notes.clear();
    store
        .publish_fold(&without_notes)
        .unwrap_or_else(|error| panic!("{error} ({})", error.code()));

    let error = store
        .publish_fold(&publish_of("ses_with_notes", 3, 1))
        .expect_err("a publish writing the altered table must be refused");
    assert_eq!(error.code(), "single_store_fingerprint_mismatch");
    assert!(error.to_string().contains("notes"), "{error}");
}

/// A migration that alters a domain table can land between two of the module's chunks.
/// The chunks after it are refused, the staged rows before it stay, and once the module
/// matches the schema again the retry completes them instead of writing them twice.
///
/// The "rebuilt module" is stood in for by reverting the trigger the migration added: the
/// property under test is what the retry does with the leftovers, not the rebuild.
#[test]
fn a_migration_landing_between_chunks_is_completed_by_the_retry() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    let publish = publish_of("ses_mid_migration", 10, 2);
    let reference_dir = tempfile::tempdir().unwrap();
    let reference = fixture_db(reference_dir.path(), "context.db");
    {
        let mut store = HostStore::open(&reference).unwrap();
        store.set_chunk_budget(4);
        store.publish_fold(&publish).unwrap();
    }

    let mut store = HostStore::open(&path).unwrap();
    store.set_chunk_budget(4);
    let migrator = Connection::open(&path).unwrap();
    let error = store
        .publish_fold_observed(&publish, &mut |chunk| {
            if chunk.index == 0 {
                migrator
                    .execute_batch(
                        "CREATE TRIGGER compartments_audit AFTER INSERT ON compartments
                         BEGIN SELECT 1; END;",
                    )
                    .unwrap();
            }
        })
        .expect_err("the visibility chunk must refuse the altered table");
    assert_eq!(error.code(), "single_store_fingerprint_mismatch");
    let conn = Connection::open(&path).unwrap();
    assert!(
        count(
            &conn,
            "SELECT COUNT(*) FROM memories WHERE source_session_id = 'ses_mid_migration'"
        ) > 0,
        "the migration was meant to land after rows were staged"
    );
    assert_eq!(
        count(
            &conn,
            "SELECT COUNT(*) FROM compartments WHERE session_id = 'ses_mid_migration'"
        ),
        0
    );

    migrator
        .execute_batch("DROP TRIGGER compartments_audit")
        .unwrap();
    let mut retry = HostStore::open(&path).unwrap();
    retry.set_chunk_budget(4);
    retry
        .publish_fold(&publish)
        .unwrap_or_else(|error| panic!("the retry failed: {error} ({})", error.code()));
    assert_eq!(
        session_rows(&path, "ses_mid_migration"),
        session_rows(&reference, "ses_mid_migration")
    );
}

// ── A lost busy timeout is typed ────────────────────────────────────────────

/// A publish that cannot take the write lock within the busy timeout fails with its own
/// code, not the catch-all SQLite one, so a health reader can count seat refusals.
#[test]
fn a_lost_busy_timeout_is_a_typed_refusal() {
    let dir = tempfile::tempdir().unwrap();
    let path = fixture_db(dir.path(), "context.db");
    let mut store = HostStore::open(&path).unwrap();

    let refusals_before = host_store::busy_refusal_count();
    let blocker = Connection::open(&path).unwrap();
    blocker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let started = Instant::now();
    let outcome = store.publish_fold(&publish_of("ses_busy", 3, 1));
    let waited = started.elapsed();
    blocker.execute_batch("ROLLBACK").unwrap();

    let error = outcome.expect_err("the publish must fail when it cannot take the write lock");
    assert!(waited >= Duration::from_millis(4_500), "gave up after {waited:?}");
    assert_eq!(error.code(), "single_store_busy", "{error}");
    assert!(!error.is_schema_refusal());
    assert!(
        host_store::busy_refusal_count() > refusals_before,
        "the lost busy timeout was not counted"
    );
    let status = host_store::status_value();
    assert!(status["busy_refusals"].as_u64().unwrap() > refusals_before);
}

// ── The embedding watermark reaches the file the host drains ─────────────

/// Point the module's `context.db` resolution at `data_home` for the length of `run`,
/// with the mode set to `mode`, and put both back afterwards.
fn with_context_db_at<T>(data_home: &Path, mode: SingleStoreMode, run: impl FnOnce() -> T) -> T {
    let previous_test_dir = std::env::var("MAGIC_CONTEXT_TEST_DATA_DIR").ok();
    let previous_xdg = std::env::var("XDG_DATA_HOME").ok();
    std::env::set_var("MAGIC_CONTEXT_TEST_DATA_DIR", data_home);
    std::env::remove_var("XDG_DATA_HOME");
    host_store::set_mode(mode);
    let result = run();
    host_store::set_mode(SingleStoreMode::Off);
    match previous_test_dir {
        Some(value) => std::env::set_var("MAGIC_CONTEXT_TEST_DATA_DIR", value),
        None => std::env::remove_var("MAGIC_CONTEXT_TEST_DATA_DIR"),
    }
    if let Some(value) = previous_xdg {
        std::env::set_var("XDG_DATA_HOME", value);
    }
    result
}

fn context_db_under(data_home: &Path) -> PathBuf {
    let storage = data_home.join("cortexkit").join("magic-context");
    std::fs::create_dir_all(&storage).unwrap();
    fixture_db(&storage, "context.db")
}

fn watermark(path: &Path) -> Option<(i64, i64)> {
    let conn = Connection::open(path).unwrap();
    host_store::read_embedding_watermark(&conn, PROJECT).unwrap()
}

/// With single-store on, a publish lands in the real `context.db` together with the
/// watermark that tells the host's drain which memories to embed.
#[test]
fn with_single_store_on_the_watermark_reaches_the_real_context_db() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let data_home = dir.path().join("data");
    let path = context_db_under(&data_home);

    let outcome = with_context_db_at(&data_home, SingleStoreMode::On, || {
        assert_eq!(host_store::resolve_context_db_path(), path);
        host_store::apply_publish_for_mode(&publish_of("ses_on", 3, 1))
    });
    let Some(host_store::ModePublish::Written(outcome)) = outcome else {
        panic!("single-store on did not write the publish: {outcome:?}");
    };
    let highest = *outcome.memory_ids.iter().max().unwrap();
    assert_eq!(watermark(&path), Some((highest, 0)));
    let conn = Connection::open(&path).unwrap();
    assert_eq!(
        count(&conn, "SELECT COUNT(*) FROM memories WHERE source_session_id = 'ses_on'"),
        3
    );
}

/// A shadow run writes the watermark, and every other row, only into its scratch copy:
/// the real file is byte-identical afterwards once its WAL is checkpointed, and carries
/// no watermark.
#[test]
fn a_shadow_run_writes_nothing_to_the_live_context_db() {
    let _guard = env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let data_home = dir.path().join("data");
    let path = context_db_under(&data_home);
    let checkpoint = |path: &Path| {
        let conn = Connection::open(path).unwrap();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
    };
    checkpoint(&path);
    let before = sha256_of(&path);

    let report = with_context_db_at(&data_home, SingleStoreMode::Shadow, || {
        host_store::apply_publish_for_mode(&publish_of("ses_shadow", 3, 1))
    });
    let Some(host_store::ModePublish::Shadow(report)) = report else {
        panic!("the shadow run did not report: {report:?}");
    };
    let scratch = PathBuf::from(&report.scratch_path);
    assert_ne!(scratch, path);
    assert!(
        watermark(&scratch).is_some(),
        "the shadow writers did not run: the scratch copy has no watermark"
    );

    checkpoint(&path);
    assert_eq!(before, sha256_of(&path), "a shadow run changed the live context.db");
    assert_eq!(watermark(&path), None);
}

fn sha256_of(path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(std::fs::read(path).expect("read database file"));
    format!("{:x}", hasher.finalize())
}
