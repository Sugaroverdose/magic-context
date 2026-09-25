//! With single-store off (the default this build ships), the module must not change
//! the host's `context.db`: not its bytes, and not its journal. The SHA-256 of the file
//! shows nothing was written to it, and an unchanged directory listing shows no `-wal`
//! or `-shm` sibling was left behind. Neither can see a read-only open that closes
//! cleanly; the `mode` assertion is what pins that the module stayed off.
//!
//! The file is found the way the module finds it in production, from the process
//! environment, so this test is ignored by default and run on its own with that
//! environment pointed at a throwaway root:
//!
//! ```text
//! MAGIC_CONTEXT_TEST_DATA_DIR=$TMPDIR/mc-b1-off XDG_DATA_HOME=$TMPDIR/mc-b1-off \
//!   cargo test -p mc-module --lib gate_b1_off -- --ignored
//! ```
//!
//! It refuses to run against a path outside the system temp directory, so a missing
//! environment can never point it at a real database.

use super::*;
use sha2::{Digest, Sha256};

fn file_digest(path: &Path) -> String {
    let bytes = std::fs::read(path).expect("read context.db");
    Sha256::digest(&bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn sibling_names(path: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(path.parent().expect("context.db has a parent"))
        .expect("list context.db directory")
        .map(|entry| {
            entry
                .expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "reads the process environment; run alone under a throwaway root (see module docs)"]
async fn off_leaves_context_db_byte_identical_with_no_journal_across_a_fold_and_status() {
    let path = crate::host_store::resolve_context_db_path();
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let parent = path.parent().expect("context.db has a parent");
    std::fs::create_dir_all(parent).expect("create context.db directory");
    let canonical_parent = parent
        .canonicalize()
        .expect("canonical context.db directory");
    assert!(
        canonical_parent.starts_with(&temp_root),
        "refusing to run: context.db resolves to {} outside the temp root {}",
        path.display(),
        temp_root.display()
    );

    // A host-shaped database: WAL journal, checkpointed and closed so no journal file
    // is left behind before the module gets its chance to create one.
    let _ = std::fs::remove_file(&path);
    {
        let conn = rusqlite::Connection::open(&path).expect("create context.db");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal journal");
        conn.execute_batch(
            "CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT);
             INSERT INTO memories (content) VALUES ('host row');",
        )
        .expect("seed context.db");
        conn.pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .expect("checkpoint");
    }
    let before_digest = file_digest(&path);
    let before_siblings = sibling_names(&path);
    assert_eq!(before_siblings, vec!["context.db".to_string()]);

    crate::host_store::set_mode(crate::host_store::SingleStoreMode::Off);

    let producer = Arc::new(ProducerState::default());
    let (handler, store, _dir, _project) =
        handler_with_store(Arc::clone(&producer), default_test_config());
    let fired = call_transform(&handler, big_messages()).await;
    assert_eq!(fired["historian"]["fired"], true, "{fired}");
    wait_for_count(&producer.starts, 1).await;
    wait_for_idle(&store).await;
    assert_eq!(
        store.load_compartments("ses").unwrap().len(),
        1,
        "a fold has to publish for the publish-side hook to have run"
    );
    let status = crate::host_store::status_value();
    assert_eq!(status["mode"], json!("off"), "{status}");

    assert_eq!(
        file_digest(&path),
        before_digest,
        "context.db bytes changed"
    );
    assert_eq!(
        sibling_names(&path),
        before_siblings,
        "something opened context.db and left a journal behind"
    );
}
