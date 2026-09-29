//! Host ordinals and module block IDs cached for rendering shared compartments.
//! The summaries and their stored raw IDs remain in context.db and are never rewritten here.
use crate::{CompartmentBoundary, McStore, McStoreError, StoredCompartment};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

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
    pub start_message: i64,
    pub end_message: i64,
    pub start_message_id: String,
    pub end_message_id: String,
    pub start_date: Option<String>,
    pub end_date: Option<String>,
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
                mid == source && source_index.is_none_or(|index| i64::try_from(block) == Ok(index))
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
        self.context_read(|conn| {
            let mut stmt = conn.prepare_cached("SELECT sequence, start_message, end_message, COALESCE(start_message_id, ''), COALESCE(end_message_id, ''), start_block_index, end_block_index FROM compartments WHERE session_id=?1")?;
            let rows = stmt.query_map(params![session], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<i64>>(5)?, row.get::<_, Option<i64>>(6)?)))?;
            for row in rows {
                let (sequence, start, end, start_id, end_id, start_block, end_block) = row?;
                if start_block.is_some() && end_block.is_some() { continue; }
                if !cached.iter().any(|b| b.sequence == sequence && b.source_start_message == start && b.source_end_message == end && b.source_start_message_id == start_id && b.source_end_message_id == end_id && b.source_start_block_index == start_block && b.source_end_block_index == end_block) { return Ok(false); }
            }
            Ok(true)
        })
    }

    pub(crate) fn cached_context_boundaries(
        &self,
        session: &str,
    ) -> Result<Vec<ResolvedContextBoundary>, McStoreError> {
        let json: Option<String> = self.inner.with_conn(|conn| {
            conn.query_row("SELECT COALESCE(json_extract(meta, '$.resolved_compartment_boundaries'), '[]') FROM mc_cache_state WHERE session_id=?1", params![session], |row| row.get(0)).optional()
        })?;
        json.map(|value| {
            serde_json::from_str(&value).map_err(|error| McStoreError::Serde(error.to_string()))
        })
        .transpose()
        .map(Option::unwrap_or_default)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ModuleStateSyncRequest;
    use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};

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
        assert!(!store.context_boundaries_resolved("raw", &cached).unwrap());
        let served = store.load_compartments("raw").unwrap();
        assert_eq!(served[0].end_message_id, "m4#1");
        assert_eq!(served[0].end_message, 5);
        assert!(store
            .apply_authority_state_sync(request(&cached, 1))
            .unwrap_err()
            .to_string()
            .contains("snapshot changed"));
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
