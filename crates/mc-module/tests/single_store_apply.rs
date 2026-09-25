//! Apply one fold publish to a `context.db` through the module's single-store writers.
//!
//! This is the module half of the cross-implementation golden: the TypeScript half runs
//! the host's own writers over the same publish on a second copy of the same fixture, and
//! `scripts/single-store-golden.ts` diffs the two databases column for column. Driving it
//! as a test rather than a binary keeps the writers out of any shipped executable.
//!
//! Ignored by default because it needs its inputs handed to it:
//!
//!   SINGLE_STORE_GOLDEN_DB=<path to context.db copy> \
//!   SINGLE_STORE_GOLDEN_PUBLISH=<path to the publish JSON> \
//!   cargo test -p mc-module --test single_store_apply -- --ignored --nocapture

use std::path::PathBuf;

use mc_module::host_store::{FoldPublish, HostStore};

#[test]
#[ignore = "driven by scripts/single-store-golden.ts with an explicit fixture"]
fn apply_publish_from_env() {
    let db_path = PathBuf::from(
        std::env::var("SINGLE_STORE_GOLDEN_DB").expect("SINGLE_STORE_GOLDEN_DB must be set"),
    );
    let publish_path = PathBuf::from(
        std::env::var("SINGLE_STORE_GOLDEN_PUBLISH")
            .expect("SINGLE_STORE_GOLDEN_PUBLISH must be set"),
    );

    // Refuse to touch anything outside a throwaway fixture. The golden runs against a
    // copy, and a mistyped path that reached a real database would be silent corruption
    // rather than a failed test.
    let resolved = db_path.canonicalize().expect("fixture database must exist");
    let temp_root = std::env::temp_dir()
        .canonicalize()
        .unwrap_or_else(|_| std::env::temp_dir());
    assert!(
        resolved.starts_with(&temp_root),
        "the golden fixture must live under {}, got {}",
        temp_root.display(),
        resolved.display()
    );

    let publish: FoldPublish = serde_json::from_str(
        &std::fs::read_to_string(&publish_path).expect("publish JSON must be readable"),
    )
    .expect("publish JSON must match the FoldPublish shape");

    let mut store = HostStore::open(&resolved).expect("fixture must pass the schema fence");
    if let Ok(budget) = std::env::var("SINGLE_STORE_GOLDEN_CHUNK_ROWS") {
        if let Ok(rows) = budget.parse::<usize>() {
            store.set_chunk_budget(rows);
        }
    }
    let outcome = store.publish_fold(&publish).expect("publish must succeed");
    println!(
        "module publish: chunks={:?} durations_us={:?} compartments={:?} memories={:?} watermark={}",
        outcome.chunk_rows,
        outcome.chunk_durations_us,
        outcome.compartment_ids,
        outcome.memory_ids,
        outcome.embedding_watermark
    );
}
