//! Host ordinals and module block IDs cached for rendering shared compartments.
//! The summaries and their stored raw IDs remain in context.db and are never rewritten here.
use crate::{CompartmentBoundary, McStore, McStoreError, StoredCompartment};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Split the module's `<raw-message-id>#<block-index>` into the shared table's two columns.
pub fn canonical_boundary_parts(id: &str) -> rusqlite::Result<(&str, Option<i64>)> {
    match crate::split_flat_block_id(id) {
        Some((raw, block)) => Ok((
            raw,
            Some(i64::try_from(block).map_err(|_| {
                rusqlite::Error::InvalidParameterName(
                    "compartment block index exceeds SQLite INTEGER".into(),
                )
            })?),
        )),
        None => Ok((id, None)),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResolvedContextBoundary {
    pub sequence: i64,
    pub source_start_message: i64,
    pub source_end_message: i64,
    pub source_start_message_id: String,
    pub source_end_message_id: String,
    #[serde(default)]
    pub source_start_block_index: Option<i64>,
    #[serde(default)]
    pub source_end_block_index: Option<i64>,
    #[serde(default)]
    pub source_row_identity: String,
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
}

/// Hash the complete compartment row: changing its summary without moving its
/// message boundaries must still invalidate cached host-to-module coordinates.
fn row_identity(row: &StoredCompartment) -> Result<String, McStoreError> {
    let bytes = serde_json::to_vec(row).map_err(|error| McStoreError::Serde(error.to_string()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

impl ResolvedContextBoundary {
    pub(crate) fn preserves_source_ids(&self) -> bool {
        [
            (
                &self.source_start_message_id,
                self.source_start_block_index,
                &self.start_message_id,
            ),
            (
                &self.source_end_message_id,
                self.source_end_block_index,
                &self.end_message_id,
            ),
        ]
        .into_iter()
        .all(|(source, source_index, resolved)| {
            crate::split_flat_block_id(resolved).is_some_and(|(mid, block)| {
                // Older shared rows can omit an endpoint ID entirely. The host
                // then resolves a real message from its proven ordinal range;
                // there is no source ID to preserve, but an explicit block index
                // still forbids substitution. Row matching retains the empty
                // source identity so cache reuse cannot mask a later repair.
                (mid == source || (source.is_empty() && source_index.is_none()))
                    && source_index.is_none_or(|index| i64::try_from(block) == Ok(index))
            })
        })
    }

    pub(crate) fn matches(&self, row: &StoredCompartment) -> bool {
        self.sequence == row.sequence
            && self.source_start_message == row.start_message
            && self.source_end_message == row.end_message
            && matches_canonical_id(
                &self.source_start_message_id,
                self.source_start_block_index,
                &row.start_message_id,
            )
            && matches_canonical_id(
                &self.source_end_message_id,
                self.source_end_block_index,
                &row.end_message_id,
            )
    }

    pub(crate) fn bind_to_row(&mut self, row: &StoredCompartment) -> Result<(), McStoreError> {
        self.source_row_identity = row_identity(row)?;
        Ok(())
    }

    pub(crate) fn identifies(&self, row: &StoredCompartment) -> Result<bool, McStoreError> {
        Ok(!self.source_row_identity.is_empty()
            && self.matches(row)
            && self.source_row_identity == row_identity(row)?)
    }

    pub(crate) fn apply(&self, row: &mut StoredCompartment) {
        row.start_message = self.start_message;
        row.end_message = self.end_message;
        row.start_message_id.clone_from(&self.start_message_id);
        row.end_message_id.clone_from(&self.end_message_id);
        row.start_date.clone_from(&self.start_date);
        row.end_date.clone_from(&self.end_date);
    }

    pub(crate) fn matches_boundary(&self, row: &CompartmentBoundary) -> bool {
        self.sequence == row.sequence
            && self.source_start_message == row.start_message
            && self.source_end_message == row.end_message
            && matches_canonical_id(
                &self.source_end_message_id,
                self.source_end_block_index,
                &row.end_message_id,
            )
    }
}

fn matches_canonical_id(raw: &str, index: Option<i64>, module_id: &str) -> bool {
    match index {
        Some(index) => crate::split_flat_block_id(module_id)
            .is_some_and(|(mid, block)| mid == raw && i64::try_from(block) == Ok(index)),
        None => raw == module_id,
    }
}

impl McStore {
    /// Whether every shared row has exact block indices or matching cached host
    /// coordinates, so reconnecting need not scan the raw messages again.
    pub fn context_boundaries_resolved(
        &self,
        session: &str,
        cached: &[ResolvedContextBoundary],
    ) -> Result<bool, McStoreError> {
        for row in self.load_raw_context_compartments(session)? {
            // Fully indexed rows need no host-coordinate overlay. Every other
            // row requires the fingerprint of this exact shared row, including
            // its summary, before a stored coordinate may be reused.
            if crate::split_flat_block_id(&row.start_message_id).is_some()
                && crate::split_flat_block_id(&row.end_message_id).is_some()
            {
                continue;
            }
            let mut matched = false;
            for boundary in cached
                .iter()
                .filter(|boundary| boundary.sequence == row.sequence)
            {
                if boundary.identifies(&row)? {
                    matched = true;
                    break;
                }
            }
            if !matched {
                return Ok(false);
            }
        }
        Ok(true)
    }

    pub(crate) fn cached_context_boundaries(
        &self,
        session: &str,
    ) -> Result<Vec<ResolvedContextBoundary>, McStoreError> {
        let json: Option<String> = self.inner.with_conn(|conn| {
            conn.query_row("SELECT COALESCE(json_extract(meta, '$.resolved_compartment_boundaries'), '[]') FROM mc_cache_state WHERE session_id=?1", params![session], |row| row.get(0)).optional()
        })?;
        let cached: Vec<ResolvedContextBoundary> = json
            .map(|value| {
                serde_json::from_str(&value).map_err(|error| McStoreError::Serde(error.to_string()))
            })
            .transpose()?
            .unwrap_or_default();
        if cached.is_empty() {
            return Ok(cached);
        }
        let rows = self.load_raw_context_compartments(session)?;
        let mut valid = Vec::new();
        for boundary in cached {
            if let Some(row) = rows.iter().find(|row| row.sequence == boundary.sequence) {
                if boundary.identifies(row)? {
                    valid.push(boundary);
                }
            }
        }
        Ok(valid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::single_store_domain::{ContextDomain, SqliteContextDomain};
    use crate::ModuleStateSyncRequest;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
    use rusqlite::{Connection, Transaction};
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    struct RewriteAfterSnapshot {
        inner: SqliteContextDomain,
        writer: Mutex<Connection>,
        fired: AtomicBool,
    }

    impl ContextDomain for RewriteAfterSnapshot {
        fn read(
            &self,
            callback: &mut dyn FnMut(&Connection) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.read(callback)?;
            if !self.fired.swap(true, Ordering::SeqCst) {
                self.writer.lock().unwrap().execute_batch("BEGIN IMMEDIATE; UPDATE compartments SET end_message=3, end_message_id='m2' WHERE session_id='raw'; COMMIT;").unwrap();
            }
            Ok(())
        }
        fn write(
            &self,
            tables: &[&str],
            callback: &mut dyn FnMut(&Transaction<'_>) -> rusqlite::Result<()>,
        ) -> Result<(), McStoreError> {
            self.inner.write(tables, callback)
        }
    }

    fn install_snapshot_race(store: &McStore, dir: &std::path::Path) {
        let path = dir.join("context.db");
        store.install_context_domain(Arc::new(RewriteAfterSnapshot {
            inner: SqliteContextDomain::open(&path).unwrap(),
            writer: Mutex::new(Connection::open(&path).unwrap()),
            fired: AtomicBool::new(false),
        }));
    }

    fn descriptor(path: &std::path::Path) -> StorageDescriptor {
        StorageDescriptor {
            module_id: "magic-context".into(),
            storage_namespace: "magic-context".into(),
            isolation: Isolation::Module,
            backend: StorageBackend::Sqlite {
                path: path.join("store.db").to_string_lossy().into_owned(),
            },
        }
    }
    fn boundary() -> ResolvedContextBoundary {
        ResolvedContextBoundary {
            sequence: 0,
            source_start_message: 2,
            source_end_message: 5,
            source_start_message_id: "m1".into(),
            source_end_message_id: "m4".into(),
            source_start_block_index: None,
            source_end_block_index: None,
            source_row_identity: String::new(),
            start_message: 1,
            end_message: 4,
            start_message_id: "m1#0".into(),
            end_message_id: "m4#0".into(),
            start_date: Some("1970-01-01".into()),
            end_date: Some("1970-01-01".into()),
        }
    }
    fn request(rows: &[ResolvedContextBoundary], seq: u64) -> ModuleStateSyncRequest<'_> {
        ModuleStateSyncRequest {
            resolved_compartment_boundaries: rows,
            session_id: "raw",
            project_path: "project",
            shadow_generation: 0,
            expected_shadow_seq: seq,
            seed_boundary_id: Some("m4#0"),
            drop_seeds: &[],
            drop_seed_skipped: 0,
            pending_agent_drops: &[],
            pending_agent_drops_skipped: 0,
            user_hint_seeds: &[],
            auto_search_hint_skipped: 0,
            note_nudge_anchors: None,
            todo_synthetic_anchor: None,
            todo_synthetic_anchor_present: false,
            emergency_latches: None,
            pending_compaction_marker: None,
            deferred_execute_state: None,
            channel2_nudge_state: None,
            strip_seeds: &[],
            strip_seed_skipped: 0,
            reasoning_cleared_through_tag: None,
            last_todo_state: None,
            acked_watermarks: serde_json::json!({}),
        }
    }
    fn seed(store: &McStore) {
        store.with_context_conn_for_test(|conn| conn.execute_batch("INSERT INTO compartments(session_id, sequence, start_message, end_message, start_message_id, end_message_id, title, content, created_at) VALUES ('raw', 0, 2, 5, 'm1', 'm4', 'summary', 'body', 1)")).unwrap();
    }
    #[test]
    fn empty_legacy_source_id_accepts_host_resolution_without_rewriting_shared_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
            "UPDATE compartments SET start_message_id='', end_block_index=3 WHERE session_id='raw'"
        )
            })
            .unwrap();
        let mut resolved = boundary();
        resolved.source_start_message_id.clear();
        resolved.source_end_block_index = Some(3);
        resolved.end_message_id = "m4#3".into();
        let rows = [resolved];
        let mut sync = request(&rows, 0);
        sync.seed_boundary_id = None;
        store.apply_authority_state_sync(sync).unwrap();
        let raw = store.load_raw_context_compartments("raw").unwrap();
        assert_eq!(raw[0].start_message_id, "");
        assert_eq!(raw[0].end_message_id, "m4#3");
        let rendered = store.load_compartments("raw").unwrap();
        assert_eq!(rendered[0].start_message_id, "m1#0");
        assert_eq!(rendered[0].end_message_id, "m4#3");
        assert!(store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET start_message_id='repaired' WHERE session_id='raw'",
                )
            })
            .unwrap();
        assert!(!store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
    }

    #[test]
    fn empty_source_resolution_requires_unindexed_source_and_valid_flat_id() {
        let mut resolved = boundary();
        resolved.source_start_message_id.clear();
        assert!(resolved.preserves_source_ids());
        resolved.source_start_block_index = Some(0);
        assert!(!resolved.preserves_source_ids());
        resolved.source_start_block_index = None;
        resolved.start_message_id = "#0".into();
        assert!(!resolved.preserves_source_ids());
        resolved.start_message_id = "m1#0".into();
        resolved.source_start_message_id = "known".into();
        assert!(!resolved.preserves_source_ids());
    }

    #[test]
    fn cache_coordinates_survive_restart_without_rewriting_shared_rows() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        assert!(!store.context_boundaries_resolved("raw", &[]).unwrap());
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        let rows = store.load_compartments("raw").unwrap();
        assert_eq!((rows[0].start_message, rows[0].end_message), (1, 4));
        assert_eq!(rows[0].end_message_id, "m4#0");
        let raw = store.load_raw_context_compartments("raw").unwrap();
        assert_eq!((raw[0].start_message, raw[0].end_message), (2, 5));
        assert_eq!(raw[0].end_message_id, "m4");
        drop(store);
        let reopened = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        assert_eq!(
            reopened.load_compartments("raw").unwrap()[0].end_message_id,
            "m4#0"
        );
        assert!(reopened
            .context_boundaries_resolved("raw", &reopened.cached_context_boundaries("raw").unwrap())
            .unwrap());
        // On reconnect the host omits compartment coordinates already cached here.
        reopened
            .apply_authority_state_sync(request(&[], 1))
            .unwrap();
        assert_eq!(
            reopened.load_compartments("raw").unwrap()[0].end_message_id,
            "m4#0"
        );
    }
    #[test]
    fn a_host_recompaction_can_shorten_shared_coverage_without_rewriting_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store.with_context_conn_for_test(|conn| conn.execute_batch("UPDATE compartments SET end_message_id='m2', end_message=3 WHERE session_id='raw'")).unwrap();
        let mut shortened = boundary();
        shortened.source_end_message_id = "m2".into();
        shortened.source_end_message = 3;
        shortened.end_message = 2;
        shortened.end_message_id = "m2#0".into();
        let rows = [shortened];
        let mut update = request(&rows, 1);
        update.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(update).unwrap();
        let state = store.load("raw").unwrap();
        assert_eq!(state.meta.coverage_ordinal, Some(2));
        assert!(state.meta.bootstrap_seed_fold_pending);
        assert_eq!(
            store.load_raw_context_compartments("raw").unwrap()[0].end_message_id,
            "m2"
        );
    }

    #[test]
    fn module_publication_keeps_shared_ids_raw_and_roundtrips_block_indices() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        let mut row = store.load_compartments("raw").unwrap().remove(0);
        row.start_message_id = "m1#1".into();
        row.end_message_id = "m4#2".into();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch("DELETE FROM compartments WHERE session_id='raw'")
            })
            .unwrap();
        store.append_compartments_now("raw", &[row]).unwrap();
        let stored: (String, String, Option<i64>, Option<i64>) = store.with_context_conn_for_test(|conn| conn.query_row("SELECT start_message_id, end_message_id, start_block_index, end_block_index FROM compartments WHERE session_id='raw'", [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)))).unwrap();
        assert_eq!(stored, ("m1".into(), "m4".into(), Some(1), Some(2)));
        let read = store.load_compartments("raw").unwrap();
        assert_eq!(read[0].start_message_id, "m1#1");
        assert_eq!(read[0].end_message_id, "m4#2");
        assert!(store.context_boundaries_resolved("raw", &[]).unwrap());
    }

    #[test]
    fn snapshot_then_host_rewrite_must_not_commit_stale_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        install_snapshot_race(&store, dir.path());
        let outcome = store.apply_authority_state_sync(request(&[boundary()], 0));
        assert_eq!(
            store.load_raw_context_compartments("raw").unwrap()[0].end_message_id,
            "m2"
        );
        let cached = store.cached_context_boundaries("raw").unwrap();
        assert!(
            outcome.is_err() || cached.is_empty(),
            "stale snapshot committed to store.db: {cached:?}"
        );
    }

    #[test]
    fn rewrite_between_module_passes_invalidates_overlay_and_recovers_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store.with_context_conn_for_test(|tx| tx.execute_batch("UPDATE compartments SET end_message=3, end_message_id='m2' WHERE session_id='raw'")).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2"
        );
        assert!(store.apply_authority_state_sync(request(&[], 1)).is_err());
        let mut changed = boundary();
        changed.source_end_message = 3;
        changed.source_end_message_id = "m2".into();
        changed.end_message = 2;
        changed.end_message_id = "m2#0".into();
        let rows = [changed];
        let mut update = request(&rows, 1);
        update.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(update).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
        let mut defer = request(&[], 2);
        defer.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(defer).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
    }

    #[test]
    fn host_rewrite_before_snapshot_is_rejected_and_next_pass_adopts_new_row() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store.with_context_conn_for_test(|tx| tx.execute_batch("UPDATE compartments SET end_message=3, end_message_id='m2' WHERE session_id='raw'")).unwrap();
        assert!(store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
        let mut updated = boundary();
        updated.source_end_message = 3;
        updated.source_end_message_id = "m2".into();
        updated.end_message = 2;
        updated.end_message_id = "m2#0".into();
        let rows = [updated];
        let mut sync = request(&rows, 0);
        sync.seed_boundary_id = Some("m2#0");
        store.apply_authority_state_sync(sync).unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
        store
            .apply_authority_state_sync({
                let mut next = request(&[], 1);
                next.seed_boundary_id = Some("m2#0");
                next
            })
            .unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m2#0"
        );
    }

    #[test]
    fn same_count_rewrite_and_reconnect_do_not_serve_old_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store.with_context_conn_for_test(|conn| conn.execute_batch(
            "UPDATE compartments SET start_message=3, start_message_id='m2', end_message=5, end_message_id='m4' WHERE session_id='raw'"
        )).unwrap();
        assert!(!store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
        let served = store.load_compartments("raw").unwrap();
        assert_eq!(
            (served[0].start_message, served[0].start_message_id.as_str()),
            (3, "m2")
        );
        let mut replacement = boundary();
        replacement.source_start_message = 3;
        replacement.source_start_message_id = "m2".into();
        replacement.start_message = 2;
        replacement.start_message_id = "m2#0".into();
        store
            .apply_authority_state_sync(request(&[replacement], 1))
            .unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].start_message_id,
            "m2#0"
        );
        drop(store);
        let reopened = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        reopened
            .apply_authority_state_sync(request(&[], 2))
            .unwrap();
        assert_eq!(
            reopened.load_compartments("raw").unwrap()[0].start_message_id,
            "m2#0"
        );
    }

    #[test]
    fn coordinate_rebase_to_an_indexed_end_invalidates_old_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET end_block_index=1 WHERE session_id='raw'",
                )
            })
            .unwrap();
        let cached = store.cached_context_boundaries("raw").unwrap();
        assert!(cached.is_empty());
        assert!(!store
            .context_boundaries_resolved("raw", &[boundary()])
            .unwrap());
        let served = store.load_compartments("raw").unwrap();
        assert_eq!(served[0].end_message_id, "m4#1");
        assert_eq!(served[0].end_message, 5);
        assert!(store
            .apply_authority_state_sync(request(&[boundary()], 1))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
    }

    #[test]
    fn same_coordinates_with_rewritten_content_invalidate_cached_row_identity() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        let previously_cached = store.cached_context_boundaries("raw").unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET content='rewritten summary' WHERE session_id='raw'",
                )
            })
            .unwrap();
        assert!(!store
            .context_boundaries_resolved("raw", &previously_cached)
            .unwrap());
        assert!(store.cached_context_boundaries("raw").unwrap().is_empty());
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].content,
            "rewritten summary"
        );
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m4"
        );
    }

    #[test]
    fn removed_tail_never_reappears_from_coordinate_cache() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch("DELETE FROM compartments WHERE session_id='raw'")
            })
            .unwrap();
        assert!(store.load_compartments("raw").unwrap().is_empty());
        assert!(store
            .load_raw_context_compartments("raw")
            .unwrap()
            .is_empty());
        assert!(store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
    }

    #[test]
    fn changed_shared_boundaries_do_not_reuse_or_adopt_stale_cache_coordinates() {
        let dir = tempfile::tempdir().unwrap();
        let store = McStore::open_for_test(&descriptor(dir.path())).unwrap();
        seed(&store);
        store
            .apply_authority_state_sync(request(&[boundary()], 0))
            .unwrap();
        store
            .with_context_conn_for_test(|conn| {
                conn.execute_batch(
                    "UPDATE compartments SET end_message_id='m5' WHERE session_id='raw'",
                )
            })
            .unwrap();
        assert_eq!(
            store.load_compartments("raw").unwrap()[0].end_message_id,
            "m5"
        );
        assert!(!store
            .context_boundaries_resolved("raw", &store.cached_context_boundaries("raw").unwrap())
            .unwrap());
        assert!(store
            .apply_authority_state_sync(request(&[boundary()], 1))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
        assert_eq!(store.load("raw").unwrap().meta.shadow_seq, 1);
    }
}
