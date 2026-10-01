# ck-mc write amplification: measurements and design

Status: design for review. No product code changes with this note.

## Summary

- **The write is almost all one table.** In a 17-pass run of a real ck-mc on clones (run1, section 1), the session's `mc_cache_state` row, together with the copies of it that the next commit freed, took 94.5% of the `store.db` WAL frames: 15,362 of 16,252. The other two runs show the same shape.
- **Every new message rewrites the whole row, usually twice.** `commit_transform` rewrites the full row on any byte change. A new agent step always appends to `core_state.frozen_units`, and the historian's no-fire bookkeeping then commits the same full row a second time. On AFT's 8.0 MB row that is about 16.8 MB of WAL per pass and about 43 MB of disk writes once checkpoints and filesystem overhead are included, for roughly 200 bytes of real change.
- **Stable passes are cheap, but not free.** A stable defer pass with no new message writes no cache row at all. It still rewrites the per-session `mc_pass_trace` row three to five times, about 0.17 to 0.36 MB per pass on a 104 KB trace row.
- **A historian run is the worst single event.** Its claim, heartbeats and publish each `UPDATE` only `meta`, but `core_state` lives in the same SQLite record, so each one rewrites the whole row: six full rewrites per run.
- **The fix is a structural split.** Keep the small per-pass state in `mc_cache_state` under the same `row_version` compare-and-set (CAS). Move `frozen_units` and `resolved_compartment_boundaries` into fixed-size positional chunk rows, written only when a chunk's content differs from the loaded state. Move `tail_hygiene_baseline` into a hashed section row. Write all of it in the same transaction.
- **Projected effect.** On AFT, a new-message pass falls from about 16.8 MB to about 0.56 MB of WAL (around 30x), and a historian run from about 58 MB to about 0.5 MB.
- **Recommended in the same migration: ring rows for the pass trace.** Moving the scheduler and request histories out of their JSON arrays and into ring rows takes the new-message pass to about 0.08 MB (around 200x), because the 163 KB trace row is the largest thing left after the split.
- **The migration is v63** on both `master` and `alfonso/v93-merge-check`. It is a `store.db` fence move: older binaries refuse the store, and `scripts/place-ck-mc.sh` refuses a binary rollback.

## 1. Method

Sessions are named by the agent seat that owns them: AFT is `ses_313660571ffe…` (the largest cache row, 8.0 MB), ALF is `ses_227ce5788ffe…` (7.1 MB) and CEREB is `ses_0758f6ce7ffe…` (2.65 MB). "The brief" is the task that asked for this note; its live figures (36.4 GB written in 11 h 10 min; 46 commits and 370 MB in one 120 s window) were measured on the running module before this work started.

Nothing in this work opened a live store. The live `context.db`, `store.db` and `opencode.db` were read only through `cp -c` (APFS clones) into `$TMPDIR/magic-context/ckmc-writes/`. Every run used fresh clones of those clones. `lsof` on the probe `ck-mc` and `ck-subc` listed only files under the run directory: 17 regular files, all under `ckmc-writes/run4` for the committed scripts, and the same for the first run1. They were the binaries, the cloned `store.db` and `context.db` with their `-wal` and `-shm` files, the clone's lease, and the module and daemon logs. The tools are committed under `scripts/ckmc-write-probe/`, and its README has the exact commands.

The measurements come from three sources:

1. **A real module behind a real daemon.** `drive.ts` starts a private `ck-subc` and `ck-mc`. Both are copies of the installed binaries: `ck-mc 0.1.0 (3ebd5c0659…)`, whose `commit_transform` is unchanged up to this branch's base. The script drives the plugin's real Rust-mode transform (`createRustModeTransform`) with the session's real messages since its newest compaction. The session is CEREB, `ses_0758f6ce7ffe…`: 549 messages in the wire, a 2.65 MB cache row (`core_state` 2.15 MB, `meta` 0.50 MB) and a 104 KB pass-trace row.

   For each pass it records:
   - the module's own disk-write counter (`proc_pid_rusage`, `ri_diskio_byteswritten`);
   - the WAL frames appended to each store, and the table or index that owns every written page (`dbstat` over a clone);
   - each committed transaction's size (`walcommits.py`);
   - the SHA-256 of the served messages.

   Three runs are quoted below. run1 and run3 are pinned; run3 also had the historian producer answering, and its plan included a HARD pass and a historian run. run2 is unpinned. Runs used two modes:
   - **Pinned** (`PROBE_PIN=1`): a reader holds a snapshot so the WAL is never reset, and every frame is attributable.
   - **Unpinned:** the live configuration, where the write counter includes checkpoint copies.

   The historian ran against the hermetic Broca producer, `packages/e2e-tests/src/rust-runner/fake-broca.ts`.
2. **An SQL-level replay on AFT's real row** (`sqlexp.py`). It runs the statements `commit_transform` issues, with a ck-mc connection's pragmas, on per-scenario clones of `store.db`, for both today's layout and the proposed one. AFT's row is 7,986,384 bytes, and a full replay through the plugin is impractical: 135,273 messages and 1.45 GB of parts.
3. **Live evidence without touching the live store:**
   - 24 clones of `store.db` taken 10 s apart, diffed field by field (`sampler.sh`, `diffsamples.py`);
   - the live module's write counter compared with commits counted between two clones (`reconcile.sh`).

The clone runs used one setup step: the copied `cortexkit_fence` epoch was reset to 0 in the clone. A clone at a new path gets a new lease file starting at epoch 1, and the live writer's epoch (347) would otherwise fence the probe out.

### SQLite settings

| Setting | Value | Source |
|---|---|---|
| `page_size` | 4096 | the store file |
| `journal_mode` | WAL | `cortexkit_store::open_sqlite` (`commons/crates/cortexkit-store/src/lib.rs:305-367`) |
| `wal_autocheckpoint` | 1000 pages (SQLite default) | not set by `open_sqlite` or by mc-store |
| `synchronous` | FULL (SQLite default) | not set by `open_sqlite`; the bundled `libsqlite3-sys 0.30.1` build passes no `SQLITE_DEFAULT_*SYNCHRONOUS` |
| `auto_vacuum` | NONE | the store file |
| store size | 957 MB, 234,253 pages, 1,949 free | the store file |

Largest b-trees in `store.db`, from `dbstat` on the clone:

| B-tree | Size |
|---|---|
| `mc_tags` | 443 MB |
| `mc_chunk_transcripts` | 161 MB |
| `mc_block_identities` | 104 MB |
| `mc_cache_state` | 98 MB |
| `mc_served_output_fingerprints` | 41 MB |
| `mc_pass_trace` | 13 MB |

## 2. Where the bytes go

### 2.1 Live evidence

**Which fields change.** Across 24 clones over 303 s there were 46 cache commits: AFT 6, ALF 2, and 38 on small sessions of about 50 KB. Every one of them changed the same fields:

- `core.frozen_units`: 1 to 5 units appended, with the stored prefix unchanged;
- `meta.last_committed_pass_at_ms`;
- `meta.last_usage.current_total_input_tokens`;
- `meta.newest_live_block_id` and `meta.newest_live_ordinal`;
- on AFT and ALF, also `meta.historian.recent_decisions` and `meta.historian.last_no_fire`.

`meta.tail_hygiene_baseline` (AFT 0.92 MB) and `meta.resolved_compartment_boundaries` (AFT 1.06 MB) did not change in any sampled commit. AFT's `row_version` advanced by 2 for most new-message passes, which is the second commit described in section 3.3.

**Write rate.** The live module's counter read 38,153,654,272 bytes at 09:19, against 36.4 GB in the brief. In a separate 181 s window in which AFT and ALF happened to be idle, it wrote 16.6 MB for 37 commits, all on rows under 60 KB. That is 449 KB per commit, about nine times the rows' own bytes: the pass trace and the WAL plus checkpoint double write make up the rest.

### 2.2 A real module, per pass type (CEREB, 2.65 MB row)

All numbers are measured. "Commits" is the number of `row_version` steps in the pass. WAL bytes come from pinned runs. "Written, live config" is the unpinned module counter, which includes checkpoints.

| Pass | Commits | store.db WAL | Written, live config |
|---|---|---|---|
| Stable defer, no new message | 0 | 0.17 to 0.35 MB, 5 txns, all pass-trace | 0.26 to 0.36 MB |
| New message, historian decision unchanged | 1 | 2.7 to 3.2 MB | 12.6 MB (one sample) |
| New message, historian no-fire changed (the common case) | 2 | 5.7 to 6.0 MB | 15.4 MB (mean of 5) |
| Execute (usage 80%, coverage fold) | 2 | 6.7 MB; `meta` grew 96 KB | 18.1 MB (85% run) |
| HARD rebuild (model switch) | 2 | 6.0 MB: 777 + 611 frames, the first with 134 served-fingerprint pages | (pinned only) |
| Historian run and publish during a pass | 7 | 15.5 MB, 13 txns | 18.8 MB, with deferred checkpoints |
| First pass after a module restart | 3 to 8 | 8.6 MB without a historian run, 19.7 MB with one | 18.1 MB |

The ratio of live-config bytes to WAL bytes is 2.6. The CEREB two-commit pass gives 15.44 / 5.99 = 2.58, and the AFT SQL replay gives 21.30 / 8.23 = 2.59. Each page is written once to the WAL and once more at checkpoint, and the rest is fsync and filesystem overhead.

Transaction breakdown of the historian pass, from `walcommits.py` (frames per transaction):

| Frames | What it is |
|---|---|
| 1, 28 | trace received |
| 653 | transform commit, with chunk transcripts |
| 613 | no-fire record |
| 1, 28 | trace completed |
| 604, 604, 604 | claim and heartbeat meta updates, each a full record |
| 4 | a same-length meta update, done in place |
| 631 | publish, with 36 chunk-transcript pages |
| 2 | single-store pending-publish row |

**What `ck-mc` writes to `context.db`.** Within a pass, the module's own write counter matched its `store.db` WAL to within 0.1 to 0.2 MB. Its only `context.db` writes were the historian publish (`compartments`: 4 frames plus 6 index frames).

Both runs also show 2 to 3 MB per pass of `context.db` writes to `session_meta` and `lkg_slots`. Those came from the plugin process, not from ck-mc. They belong to a separate investigation, but they are the same pattern: about 1 MB per pass for this session.

Per-table attribution across a whole pinned run (run1, 17 passes, 16,252 frames):

| B-tree | Frames | Share |
|---|---|---|
| `mc_cache_state` and the copies of it freed by later commits | 15,362 | 94.5% |
| `mc_pass_trace` | 409 | 2.5% |
| `mc_served_output_fingerprints` and its index | 204 | 1.3% |
| `mc_tags` and its indexes | 106 | 0.7% |
| `sqlite_schema` (page 1, once per transaction) | 58 | 0.4% |
| `mc_block_identities` and its index | 43 | 0.3% |
| `mc_cache_state_digest` | 21 | 0.1% |
| `mc_transform_session_roots` | 12 | 0.1% |

`mc_chunk_transcripts` appears only on historian runs: 587 frames in run3.

### 2.3 AFT's row, SQL-level replay

Per commit, ten commits per scenario:

| Scenario | WAL frames | WAL bytes | Written, live config |
|---|---|---|---|
| Today, new-message commit: two units appended, pass scalars moved, with digest and pass-trace upsert | 1,997 | 8.23 MB | 21.3 MB |
| Today, same-length `meta`-only update | 2 | 8 KB | 18 KB |
| Today, byte-identical state (the commit is skipped) | 0 | 0 | 0 |
| Split layout, frozen units in 64-unit chunks | 46.7 | 192 KB | 212 KB |
| Split layout, one row per frozen unit | 47.5 | 196 KB | 218 KB |
| Split layout plus pass-trace ring rows | 7.7 | 32 KB | 53 KB |

In the split rows, about 40 of the 47 frames are the 163 KB pass-trace row's JSON append. That is why section 4.3 recommends ring rows.

## 3. Why unchanged fields are rewritten

### 3.1 The commit writes the whole record whenever any byte differs

- **The pass commits on any change.** `run_transform` sets `state_changed = core != loaded.core || meta != loaded.meta` (`crates/mc-module/src/transform.rs:6487`). It then stamps `meta.last_committed_pass_at_ms` (`:6489`) and calls `store.commit_transform` (`:6501-6535`). The compaction-off path (`:3325-3361`) and the two pending-rewrite pass-through paths (`:3875-3905`, `:3992-4021`) follow the same pattern.
- **Both blobs are serialized whole.** `McStore::commit_transform` (`crates/mc-store/src/lib.rs:10332`) serializes the entire `CoreState` and `ModuleMeta` to JSON (`:10384-10388`).
- **The CAS check comes first.** Inside the fenced transaction it compares `row_version` against `expected` (`:10426-10441`).
- **Byte-identical state is the only skip.** It compares the stored blobs byte for byte (`cache_state_blobs_unchanged`, `:16323-16337`). If anything differs, it upserts `core_state` and `meta` together (`:10487-10500`).
- **SQLite then rewrites the full record.** It writes a record in place only when the new record is exactly as long as the old one (the overwrite optimisation that makes the same-length replay cost 2 frames). Otherwise it frees the old overflow chain and writes a new one of about 1,950 pages for AFT.
- **Appending a frozen unit always changes the record length**, so every new-message pass pays for the whole record, including `tail_hygiene_baseline` and `resolved_compartment_boundaries`, which did not change.

### 3.2 The large fields ride along as passengers

| Field (AFT) | Size | When it actually changes |
|---|---|---|
| `core.frozen_units` | 6.0 MB, 32,383 units averaging 184 B; unit 0 (`m0`) is 383 KB | Units are appended on every new message; all are re-minted on HARD |
| `meta.resolved_compartment_boundaries` | 1.06 MB, 1,995 entries | When a historian publish or state sync adds or truncates a boundary |
| `meta.tail_hygiene_baseline` | 0.92 MB, nearly all `baseline_parts` | On a bust pass, or when its prefix no longer matches (`transform.rs:5924-5986`) |
| Everything else | 11.6 KB of `meta`, about 100 B of `core` | Every pass |

### 3.3 Three more writers rewrite the same record outside the transform commit

- **The historian no-fire record.** `record_no_fire` (`crates/mc-module/src/lib.rs:6821-6858`, called from 13 sites at `:6054-6574`) commits `loaded.core` together with a `meta` whose `historian.recent_decisions` and `last_no_fire` changed. It goes through `McStore::commit` (`crates/mc-store/src/lib.rs:10286`), which calls `commit_transform`. This is the second full rewrite on most new-message passes, both live (AFT `row_version` +2 per pass) and in the probe.
- **Historian claim, heartbeat and publish.** `historian_claim.rs` `store_meta` (`:312-335`, called by `publish_pending_historian_run` `:363`, `claim_historian_run` `:563`, `heartbeat_historian_run` `:645` and `expire_historian_claims` `:1027`) and `publish_historian_chunk` (`crates/mc-store/src/lib.rs:13427-13443`) issue `UPDATE mc_cache_state SET row_version = ?, meta = ?`. Only `meta` changes, but `core_state` lives in the same record, so each update rewrites the whole record whenever `meta` changes length. That is six of the seven commits in the historian pass above.
- **The pass trace, written even on stable passes.** `trace_pass_received` (`lib.rs:8571-8606`) and `trace_pass_completed` (`:8683-8718`) each upsert `mc_pass_trace` and then rewrite `scheduler_interesting_history` through `mutate_pass_request_history` (`:3753-3776`), which re-serializes the whole JSON array. `trace_pass_stable` (`:8611-8678`), or the upsert inside `commit_transform` (`:10512-10581`), appends to `scheduler_history` with `json_insert`. Each statement is its own autocommit transaction, and the row is 104 KB for CEREB and 163 KB for AFT.

## 4. Proposed change

### 4.1 Layout (store.db migration 63)

```sql
-- The small row keeps the CAS. section_index records, per section, what the chunk and
-- section rows must contain: length, chunk count, and a content digest.
ALTER TABLE mc_cache_state ADD COLUMN section_index TEXT NOT NULL DEFAULT '';

-- Ordered, append-mostly lists, stored as fixed-size positional chunks.
CREATE TABLE mc_cache_chunks (
    session_id TEXT    NOT NULL,
    section    TEXT    NOT NULL,   -- 'frozen_units' | 'resolved_compartment_boundaries'
    chunk      INTEGER NOT NULL,   -- position / CHUNK_LEN
    body       TEXT    NOT NULL,   -- JSON array of up to CHUNK_LEN elements
    PRIMARY KEY (session_id, section, chunk)
);

-- Values that are replaced wholesale when they change.
CREATE TABLE mc_cache_sections (
    session_id   TEXT NOT NULL,
    section      TEXT NOT NULL,    -- 'tail_hygiene_baseline'
    content_hash TEXT NOT NULL,
    body         TEXT NOT NULL,
    PRIMARY KEY (session_id, section)
);
```

`CHUNK_LEN` is 64. On AFT that gives 506 chunks of about 12 KB, so an append rewrites one chunk of three to four pages.

The data move follows migration 55, which moved `meta.block_identity_by_mid` and `meta.served_output_fingerprint` into rows in SQL (`crates/mc-store/src/lib.rs:2852-2910`):

- `json_each` over `$.frozen_units` and `$.resolved_compartment_boundaries`, grouped by `key / 64` with `json_group_array(value ORDER BY key)`;
- `json_extract` of `$.tail_hygiene_baseline` into the section row;
- `json_remove` of the three keys from the blobs;
- `section_index` written with the digests marked untrusted, for the reason given under "Restart and crash" in section 4.4.

On AFT's real row, `json_extract`, `json_remove` and `json_each` round-trip to values equal to the serde-parsed originals: all 32,383 units, both sections, and the remaining `meta`. That includes the `\u0000`-bearing keys in `baseline_parts`.

Measured on a clone of the whole store (1,398 rows, 84.5 MB of `core_state` and 11.9 MB of `meta`):

| | Value |
|---|---|
| Disk written by the migration | 220 MB |
| Time | 10 to 12 s, with the machine's 1-minute load average around 40 |
| `mc_cache_chunks` (frozen units) | 88.8 MB |
| `mc_cache_sections` | 8.0 MB |
| `mc_cache_state` | 5.5 MB, down from 97.6 MB |

The file does not shrink (`auto_vacuum` is NONE). The freed pages are reused by later writes.

### 4.2 The code split

The split stays inside mc-store's row codec, so the transform logic and the in-memory `CoreState` and `ModuleMeta` keep their shapes. `CoreState` comes from `cortexkit-cache-core` in `commons`, and this change does not need to touch it.

- **Encoding.** `encode_row(core, meta)` produces the small `core_state` and `meta` JSON with the three fields omitted, plus the chunk vectors and the section.
- **Decoding.** `decode_row(small, chunks, sections)` reassembles the full state.
- **The commit.** `commit_transform` gains the base it loaded at the expected `row_version` (`TransformCommit::base`). Under that CAS the stored rows equal the base, so the diff is exact without reading them back:
  - upsert each chunk whose elements differ from the base chunk;
  - delete chunks beyond the new length;
  - upsert the section only when its hash differs from the one recorded in `section_index`.

  Comparing chunk slices costs nothing new: `transform.rs:6487` already compares the whole vectors.
- **`record_no_fire` and other `McStore::commit` callers** pass `loaded.core` unchanged, so they write the small row and no chunk.
- **Meta-only writers write the small row only.** These are `historian_claim::store_meta`, `publish_historian_chunk`, `abandon_historian_run_if_matching_with_publish_failure` and `record_historian_publish_failure_if_matching` (`lib.rs:13147`, `:13204`), `truncate_compartments_for_revert` (`:12496`), and the single-store JSON editors (`single_store_schema.rs:260`, `single_store_repair.rs:972`). None of them changes the three fields today, so they need no section write, but each must serialize `meta` through the codec. A plain `serde_json::to_string(&meta)` would write the defaults of the moved fields back into the blob.

  The decoder treats `section_index` as authoritative: a moved field present in the blob is ignored and stripped on the next codec write. A test pins the list of `mc_cache_state` writers, so a new writer cannot bypass the codec unnoticed.
- **Writers that create or copy state go through the codec in full.** These are `apply_state_sync` (`:11051`), `descend_lineage` (`:11569`, `:11660`, `:11740`, `:12020`, `:12033`) and `reset_session_for_recomp` (`:12336`).
- **Session deletion needs no change.** `delete_session` deletes from every table with a `session_id` column (`lib.rs:8108-8135`), so it already covers the new tables.
- **Explicit clears.** An empty `frozen_units` when chunk rows exist is refused unless the caller uses the explicit clear. This is the same rule `refuse_unhydrated_block_identities_tx` (`:16281-16291`) applies to block identities, and it stops an unhydrated state from silently deleting a session's frame.

### 4.3 Also in migration 63: the pass-trace histories as ring rows

`scheduler_history`, `scheduler_interesting_history` and the request history inside it become rows in `mc_pass_trace_history(session_id, kind, slot, entry)`, with `slot = sequence % 256`, capped exactly as today. The counters stay in `mc_pass_trace`. Receive and complete then write one ring slot and one small row each, instead of re-serializing about 160 KB.

Measured on AFT, this takes the split-layout commit from 46.7 frames to 7.7. It changes nothing about cache state or the CAS, because these writes are already outside the cache transaction. It belongs in the same migration so the fleet takes one fence move, not two.

### 4.4 Loading, restart and crash

**Loading an existing session after the migration.** `load_transform_snapshot` (`lib.rs:8248-8296`) already reads the row and hydrates the row-stored meta inside one read transaction (`:8253-8280`). It will also read the chunks for each section in `chunk` order and the section rows, then reassemble.

Reading AFT's 506 chunks takes 3.6 ms on a warm cache, against 5.0 ms for today's single blob and 37 ms for one row per unit. That is why positional chunks beat per-unit rows, even though their write cost is the same (46.7 against 47.5 frames).

The decoder checks each section's length and chunk count against `section_index`. When the digest is trusted it checks that too, using the 128-bit `row_state_hash_128` that is already in use (`:16405-16439`).

**Restart and crash.** The small row, the chunks and the section are written in the one `with_conn_fenced` transaction that holds the CAS, so after a crash SQLite holds either all of the pass or none of it. After a restart, the first load rebuilds the full state from rows committed together.

The digest follows the rule `mc_cache_state_digest` already uses (`lib.rs:2864-2867`, `:16441-16463`): it is trusted only when it records the current `row_version`. The meta-only writers in 4.2 bump `row_version` without rewriting sections, so an untrusted digest is recomputed at the next load and written back by the next commit, and is never treated as proof of a mismatch. A mismatch against a trusted digest is a corruption signal. The pass then fails closed, so the session takes a HARD rebuild from the messages rather than serving from those sections.

**The module's per-session state.** ck-mc keeps no per-session cache state across restarts beyond what `load_transform_snapshot` reads, so restoring it is the load path above. The output cache (`transform.rs:6540`) is in memory, keyed by session, and rebuilt on demand.

### 4.5 Interactions

- **LKG.** The plugin's last-known-good replay lives in `context.db` (`lkg_slots`, written by the plugin, as seen in section 2.2) and is keyed on the served prefix. Pi keeps its own digests (`pi-lkg.ts`). Neither reads `store.db`'s layout. The split changes no served bytes, so the LKG prefix match is unaffected.
- **B2 single-store rules.** `store.db` stays a rebuildable cache, and domain rows stay in `context.db` (`docs/architecture/single-store-b2-offline.md:1-12`). The new tables are cache state, so they must not join the moved-table set that `first_populated_moved_table` checks before migration 61 (`lib.rs:7547-7562`). Migration 63 runs after 61 in the ordinary chain.

  The two single-store `meta` editors (`reset_cache_state_for_single_store`, and the repair at `single_store_repair.rs:956-975`) edit the small `meta` JSON in place and keep unknown keys. Neither changes the moved fields, and `section_index` is a separate column they do not touch.
- **Pi and Claude Code.** One `ck-mc` serves every serializer profile (`opencode-aisdk`, `pi`, `claude-code-anthropic`; `docs/architecture/rust-module.md:78`) from one `store.db` behind one writer lease. Their rows share `mc_cache_state`, keyed by session id, including the `shadow:` rows. The migration and the codec are profile-agnostic: there is no per-profile path.
- **Readers outside the module.**
  - `packages/dashboard/src-tauri/src/db.rs:3579-3591` reads only `session_id`.
  - `packages/plugin/scripts/cache-parity-baseline.ts:719-726` reads `meta.last_model_key` and `last_provider_id`.
  - The e2e tests read or `json_set` small `meta` keys: `last_render_config`, `historian.last_no_fire`, `row_version`.

  All of these stay in the small row.

### 4.6 Alternatives considered

| Alternative | Verdict |
|---|---|
| One row per frozen unit | Same write cost as chunks, but a load ten times slower (37 ms) and 8% more storage |
| Keep the blob and pad it to a constant length, to get SQLite's in-place overwrite | The overwrite skips unchanged pages only at equal length. `frozen_units` grows without bound, so the padding would have to be re-sized and the whole record rewritten anyway. Fragile. |
| Compress the blobs | Still a whole-record rewrite each pass, at a CPU cost on every pass |
| Fold `record_no_fire` into the transform commit | Halves today's cost but leaves 8 MB per pass. After the split, the second commit costs about 6 frames, so this is not needed. |
| `synchronous=NORMAL`, or a larger `wal_autocheckpoint` | Trims the 2.6x multiplier, not the 8 MB. Full-record rewrites allocate new pages, so a larger checkpoint window coalesces little. Not a substitute. |

## 5. Invariants and how each will be proven

1. **No wire change.** The change is store-internal, and the transform computes from the same in-memory state.
   - **Proof:** run `drive.ts` against the same golden clone with the same plan under today's binary and the new one. The `served_sha256` of every pass must be equal. The pinned historian run (run3 in section 1) already shows the comparison works: the defer pass after HARD served the same hash as the HARD pass.
   - Add a round-trip property test: `decode_row(encode_row(core, meta)) == (core, meta)` over fixtures that include pre-migration rows, AFT-shaped rows with `\u0000` keys, and empty sessions.
2. **Defer passes stay byte-identical.** The stable-pass skip (`transform.rs:6487-6538`) is unchanged. The probe's `defer` passes must keep the same served hash across binaries and must still produce no cache commit (`row_version` unchanged, as measured today).
   - Existing tests in the transform suite that assert stable passes do not commit must pass unchanged.
3. **The CAS conflict behaviour is unchanged.** `row_version` stays in the small row, and the `expected` check stays the first statement in the fenced transaction, returning before any write (`lib.rs:10426-10441`).
   - **Proof:** the existing CAS tests in `crates/mc-store` (for example `tests/gate_a1_b0.rs`) pass unchanged.
   - A new test commits a conflicting pass that carries chunk and section changes and asserts that every `mc_cache_chunks` and `mc_cache_sections` row is byte-identical afterwards.
4. **No stale section is ever served after a restart or crash.** Atomicity comes from the single transaction. Staleness is caught by `section_index` (length, chunk count, digest).
   - A test kills the writer between statements, using the existing `#[cfg(test)]` attempt hook pattern (`transform.rs:6503`), and asserts that the reload equals the pre-commit state.
   - A test corrupts one chunk and asserts the next pass fails closed into a HARD rebuild rather than serving from it.
   - A test runs a meta-only writer between two commits and asserts the untrusted digest is recomputed, not reported as a mismatch.

The before and after byte claims are re-measured with the same probe: `PROBE_PIN=1` for the per-table split and `PROBE_PIN=0` for live-config bytes, on the CEREB clone and through `sqlexp.py` on AFT's row.

## 6. Expected result per pass

AFT's row is 7.99 MB. One full-row commit is 8.23 MB of WAL (measured), and one pass-trace rewrite is about 41 frames (163 KB row). Live-config bytes are WAL × 2.6 (measured). The "after" column is the split; the last column adds the trace ring rows.

| Pass (AFT) | Today: WAL / written | After split: WAL / written | Split + ring trace: WAL |
|---|---|---|---|
| Stable defer, no new message | about 0.5 MB / about 1.3 MB (trace only) | same | about 20 KB |
| New message, historian decision unchanged (1 commit) | 8.5 MB / 22 MB | 0.53 MB / 1.4 MB | about 0.06 MB |
| New message, no-fire changed (2 commits, the common case) | 16.8 MB / 43 MB | 0.56 MB / 1.45 MB | about 0.08 MB |
| Execute with baseline refresh | about 17 MB / 44 MB | about 1.5 MB / 3.9 MB (baseline 0.92 MB, one or two chunks) | about 1.0 MB |
| HARD rebuild | about 16.5 MB / 43 MB | at most 7.3 MB / 19 MB (every chunk plus baseline; less where re-minted chunks are byte-identical) | at most 7.1 MB |
| Historian run and publish (7 commits) | about 58 MB / 150 MB | about 0.5 MB / 1.3 MB (small-row updates, one boundary chunk, transcripts) | about 0.25 MB |

For the CEREB session the probe measured the "today" column directly: 15.4 MB written per common new-message pass. The after column scales by the same factor: about 0.4 MB, or 0.07 MB with ring rows.

Applied to the brief's live window (370 MB in 120 s, 46 commits), and assuming roughly 17 large-row commits at 21.3 MB plus 29 small ones at 0.45 MB, as observed:

- **After the split:** about 17 × 0.73 + 29 × 0.45 ≈ 26 MB, around 14x less.
- **With ring rows:** 17 × about 0.2 MB + 29 × about 0.1 MB ≈ 6 MB, around 60x less. The 0.1 MB for a small session assumes about 10 frames per commit (the small row, one chunk, ring slots) × 4,120 B × 2.6; that figure is projected, not measured.

The large-session share is what changes most. Small sessions are dominated by the trace, which is why section 4.3 is part of the proposal.

## 7. Rollout

- **The fence.** `store.db` goes from 62 to 63. Migration 63 is the next number on both `master` and `alfonso/v93-merge-check` (`window/b0-v92-v93` is at 60). If another `store.db` migration lands first, renumber at merge time. `context.db` is untouched, so its fence (92) and the v93 window do not interact.
- **Placement.**
  - Take `scripts/backup-live-stores.sh` first. A rollback is the previous binary together with both stores from the same backup (`docs/architecture/rust-module.md:57`).
  - `scripts/place-ck-mc.sh` accepts the staged binary because staged 63 ≥ live 62 (`:57-79`). After placement it refuses any binary whose fence is below 63.
  - The first open runs the migration inside `McStore::open`. Each migration is one transaction with its version record (`cortexkit-store` `migrate`). That took 10 to 12 s and 220 MB on a clone of the live store under heavy load, and the store is unavailable for that time.
  - Place in a quiet window. During it, every profile sees the module as unavailable, exactly as during any ck-mc restart: OpenCode transforms take the plugin's existing reconnect path ("Magic Context's engine is reconnecting"). No state is lost, because the migration commits or rolls back as one transaction.
  - Check `ck health magic-context` afterwards, plus a probe pass on a clone of the migrated store.
- **An older ck-mc against the new schema** refuses to open. `McStore::open` returns `StoreAheadOfBinary { db_version: 63, binary_max: 62 }` before reading or writing a row (`lib.rs:7563-7581`), and health reports `open_refused_store_ahead` (`docs/architecture/rust-module.md:59-65`). It never sees a `core_state` without `frozen_units`, so it cannot mistake a migrated session for an empty one.
- **Order of slices.**
  1. The codec and migration 63, with the round-trip, CAS and crash tests.
  2. The pass-trace ring rows, in the same migration but a separate commit.
  3. The probe evidence: equal served hashes and the before and after bytes, attached to the review.

## 8. Not covered here

- **The plugin's `context.db` writes** to `session_meta` and `lkg_slots`, about 1 MB each per pass for CEREB, seen in section 2.2. They come from the plugin process and need their own note.
- **AFT was not driven through a real module.** Its numbers come from the SQL replay of the exact commit statements. The pass mix and commit counts come from CEREB through a real module and from the live samples, which show the same `row_version` +2 per new-message pass on AFT.
- **The HARD "after" figure is an upper bound.** How many re-minted chunks come out byte-identical is not measured.
