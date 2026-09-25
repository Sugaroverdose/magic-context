//! With `single_store` off, nothing in the module may open the host's `context.db`,
//! not even read-only and briefly.
//!
//! A SHA-256 of the file cannot see a read-only open that closes cleanly, and lsof
//! sampling can miss one. A named pipe can see it: the module resolves
//! `context.db` exactly as in production, the test puts a FIFO at that path, and a
//! probe thread keeps trying to open the FIFO for writing without blocking. That
//! open only succeeds while some other descriptor holds the FIFO open, so a probe
//! success is proof that something opened `context.db`. When it succeeds the probe
//! writes junk and closes, which unblocks the opener with an unreadable file.
//!
//! The same sequence is then run in `shadow` mode, where `session.status` is meant to
//! open the file, so the probe is shown to fire when an open really happens.
//!
//! Reads the process environment, so it is ignored by default and run alone under a
//! throwaway root:
//!
//! ```text
//! MAGIC_CONTEXT_TEST_DATA_DIR=$TMPDIR/mc-b1-fifo XDG_DATA_HOME=$TMPDIR/mc-b1-fifo \
//!   cargo test -p mc-module --test single_store_off_opens_nothing -- --ignored --nocapture
//! ```

use mc_module::host_store::{
    resolve_context_db_path, set_mode, status_value, verify_publish_in_shadow, FoldPublish,
    SingleStoreMode,
};
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

#[cfg(target_os = "macos")]
const O_NONBLOCK: i32 = 0x0004;
#[cfg(target_os = "linux")]
const O_NONBLOCK: i32 = 0o4000;

/// Keep trying a non-blocking write-open of the FIFO; count the times it succeeded.
fn start_probe(
    path: PathBuf,
) -> (
    Arc<AtomicBool>,
    Arc<AtomicUsize>,
    std::thread::JoinHandle<()>,
) {
    let stop = Arc::new(AtomicBool::new(false));
    let hits = Arc::new(AtomicUsize::new(0));
    let (stop_probe, hits_probe) = (Arc::clone(&stop), Arc::clone(&hits));
    let handle = std::thread::spawn(move || {
        while !stop_probe.load(Ordering::Relaxed) {
            if let Ok(mut writer) = std::fs::OpenOptions::new()
                .write(true)
                .custom_flags(O_NONBLOCK)
                .open(&path)
            {
                hits_probe.fetch_add(1, Ordering::Relaxed);
                let _ = writer.write_all(b"not a sqlite database, written by the fifo probe");
            }
            // No sleep: an open that fails fast lasts microseconds.
            std::thread::yield_now();
        }
    });
    (stop, hits, handle)
}

fn empty_publish() -> FoldPublish {
    FoldPublish {
        session_id: "ses-fifo".to_string(),
        project_path: "git:fifo".to_string(),
        harness: "opencode".to_string(),
        now_ms: 1_758_000_000_000,
        compartments: Vec::new(),
        facts: Vec::new(),
        events: Vec::new(),
        memories: Vec::new(),
        notes: Vec::new(),
        primer_candidates: Vec::new(),
        user_observations: Vec::new(),
        user_memories: Vec::new(),
        user_memory_collection_enabled: false,
    }
}

fn exercise(mode: SingleStoreMode, path: &Path) -> usize {
    let (stop, hits, probe) = start_probe(path.to_path_buf());
    set_mode(mode);
    // The two places a running module can reach context.db: the fold publish hook and
    // the status surface. Each is called from its own thread so an open that blocks
    // on the FIFO cannot hang the test before the probe releases it.
    let publish = std::thread::spawn(|| {
        let _ = verify_publish_in_shadow(&empty_publish());
    });
    let status = std::thread::spawn(status_value);
    publish.join().expect("publish hook thread");
    let status = status.join().expect("status thread");
    std::thread::sleep(Duration::from_millis(100));
    stop.store(true, Ordering::Relaxed);
    probe.join().expect("probe thread");
    eprintln!(
        "mode={mode:?} probe_hits={} status={status}",
        hits.load(Ordering::Relaxed)
    );
    hits.load(Ordering::Relaxed)
}

#[test]
#[ignore = "reads the process environment; run alone under a throwaway root (see module docs)"]
fn single_store_off_never_opens_context_db_and_shadow_does() {
    let path = resolve_context_db_path();
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    let parent = path.parent().expect("context.db has a parent");
    std::fs::create_dir_all(parent).expect("create context.db directory");
    assert!(
        parent.canonicalize().unwrap().starts_with(&temp_root),
        "refusing to run: context.db resolves to {} outside {}",
        path.display(),
        temp_root.display()
    );
    let _ = std::fs::remove_file(&path);
    let made = std::process::Command::new("mkfifo")
        .arg(&path)
        .status()
        .expect("mkfifo");
    assert!(made.success());

    let off_hits = exercise(SingleStoreMode::Off, &path);
    let shadow_hits = exercise(SingleStoreMode::Shadow, &path);
    let _ = std::fs::remove_file(&path);

    assert_eq!(off_hits, 0, "single_store off opened context.db");
    assert!(
        shadow_hits > 0,
        "the probe never saw the shadow-mode open, so it could not have seen one in off mode either"
    );
}
