# Background writer contention investigation

## Investigation before changes

The host must refuse a busy turn when it cannot replay a previously reduced request, rather than sending unreduced history. The reporter's supplied stack does not identify whether this was a first turn: there is no session ID, replay diagnostic, or saved-request state in the supplied stack. `completeness=partial` describes missing token accounting, not absence of an LKG slot. Pi attempts to replay the last-known-good (LKG) reduced request if snapshot preparation succeeded, compaction is enabled, and emergency recovery is not armed. Replay can also decline for missing anchors or tail identity. A first turn without a saved request is one possible explanation, not an established fact.

There is no `pi-write-transaction.ts` at this revision. Pi registers its handler via `pi-context-refusal.ts`. Unlike OpenCode, that registration does not establish `withSqliteTransformPass`. Thus Pi does not get the shared 250 ms wait for each write-lock acquisition during a turn: it inherits the connection timeout instead (background-scoped writes get a short 25 ms attempt). Neither host reruns partially executed callbacks. OpenCode's async privileged admission can retry acquisition alone for 16.5 seconds; its synchronous in-pass acquisition is 250 ms. A 3.2 second hold exceeds the latter. Pi's catch attempts LKG and then a size-checked raw fallback; that raw fallback on *storage busy* conflicts with the project's stricter replay-or-refuse policy and will be removed for busy errors (ordinary non-storage errors are separate).

`session_project_backfill` logs lease acquisition, reading or updating the one lease-state row for the harness, **not** a transaction covering discovery or the whole backfill. Its timer starts before BEGIN, so reported `held=3208.9ms` can include waiting for somebody else's lock. Discovery, filesystem identity resolution, and pagination are already outside transactions. Each session binding/repair commits separately (100 repaired chunks maximum), with yields during discovery. The attribution needs to time from successful BEGIN.

Embedding registration performs DISTINCT legacy-model discovery and an unbounded mis-scoped chunk update while holding the writer. GC limits deleted vectors to 250 but has no limit on empty identities and does legacy-model/existence discovery under the writer. A row limit alone is not a time bound for expensive scans or large vectors.

## Copy and initial measurements

Only `cp -c ~/.local/share/cortexkit/magic-context/context.db*` touched the live store, making APFS copy-on-write clones of the database and sidecars. All SQLite opens target `$TMPDIR/magic-context/bg_be8470c204b69cdd/`. The clone passes `PRAGMA quick_check`. It is 7.04 GiB (1,845,547 4096-byte pages), larger than the reporter's store; 384,868 free pages (~1.47 GiB) can be reused but do not shrink the file without vacuuming. No vacuum or migration is proposed.

Actual exported maintenance calls were measured with BEGIN-to-COMMIT instrumentation using `packages/plugin/scripts/benchmark-background-writers.ts`. Initial observed holds (ms):

| Site | Initial hold | Work |
| --- | ---: | --- |
| session_project_backfill | 4.98 | One lease row; empty discovery source |
| message_fts_rowid_backfill | 0.33 | Already completed; requires a reset for non-empty proof |
| message_time_backfill | no transaction | Already completed; requires a reset for non-empty proof |
| git_sweep_lease | 0.96 | One lease row |
| lease-guarded-write | 0.12 | One lease check and keyed state update |
| embedding_identity_record | 213.92 / 84.60 / 210.45 | Three largest commit projects; legacy discovery and repair |
| embedding_stale_gc | 47.53 / 86.21 / 88.05 | 250 vectors total; real commit/memory vectors |
| LKG prune (previously unlabelled) | 96.40 | No eligible slots; scan alone approaches the 100 ms hold target |

These are local macOS/APFS observations, not reproductions of Windows/NTFS timing. The benchmark creates no provider and makes no network or model calls.

## Site inventory

The attribution test also lists foreground/materialization writers (`opencode_materialize_cache`, `opencode_soft_refresh_cache`, `pi_materialize_cache`, `pi_soft_refresh_cache`, `pi_compaction_queue`, `ctx_memory_mutation`, `apply_pending_operations`, note nudges), explicit clone/migration jobs, and atomic historian publish/recomp (`historian-publish`, `historian-publish:recomp`, `pi_historian_publish`, `compartment_state_replace`, `recomp_staging_promote`). These are not interchangeable with background maintenance: publication must remain atomic. Workspace epoch bumps write the member identity set. Wrapup acquire/update/release operate on one lease row; expiry cleanup deletes expired wrapup state. Smart-note commit compares and updates one note after external checks have completed; lease-guarded callbacks depend on their caller's work. Message-index orphan sweep selects 200 sessions and consults host authority before taking the writer, but deletion of all session-owned history can still be much larger than 200 rows. These paths need workload-specific measurement, not a claim that the site label or bounded session count proves a short hold.

## Store growth

On the copy, dbstat's largest objects are FTS content (1.21 GB), git embeddings (760 MB), FTS index data (729 MB), tags (362 MB), source contents (309 MB), message-history source (285 MB), memory embeddings (254 MB), LKG chunks (251 MB), and compartment vectors (225 MB). Tags have several additional large indexes. There are 4031 LKG chunks containing 248,286,034 characters; 794 chunks / 47,960,373 characters belong to slots captured over 24 hours ago.

Schema migration v94 drops pre-upgrade saved-request slots captured over 24 hours ago while splitting recent prefixes. It therefore reduces *occupied pages*, not physical database bytes. This copy is already on the split schema; v94 cannot be reapplied and its historical pre-upgrade savings cannot be reconstructed. The remaining over-24-hour data is a possible retention saving, not an estimate of the reporter's v94 savings. Recurring maintenance uses a seven-day rule and retains recently bound sessions. Embeddings, tag/index history, source/FTS duplicates and per-message replay decisions still grow independently of LKG. No schema change is needed for shorter transactions.

## Implemented changes and final measurements

Registration now discovers historical model IDs and incorrect project assignments **before** taking the writer. It inserts at most 25 missing model markers per scope and repairs at most 25 chunk assignments per registration. Further registrations resume from the remaining database rows. Repair rechecks session ownership under the write lock. GC commits at most 25 vectors and examines at most 25 expired identities per timer invocation, including empty identities; it rechecks a marker's activity after acquisition. Memory/commit selection uses the existing embedding primary-key index through parent IDs rather than reading vector-bearing rows to filter by project. Each sweep returns to the timer, yielding before subsequent batches.

The non-empty FTS-map batch measured 103.89 ms for the original 500-row default. It now caps even explicit oversized requests at 100, keeps the bounded FTS selection, mappings and cursor in one transaction. Reading FTS owners under the writer prevents rowid reuse between discovery and recording. Its existing asynchronous drain yields between commits.

For LKG, a simulated future retention cutoff on the *real* prefix backlog made 377 slots eligible. The old deletion statements took **6600.37 ms** before rollback (excluding rollback time). The new maintenance call removes at most one stale metadata row and 25 prefix slices, revalidating retention and absence of a live slot under the writer. Removing metadata first means no partial prefix is replayable; later timer ticks reclaim orphan slices. It is safe to capture a new slot while cleanup is in progress: cleanup never deletes chunks owned by a live slot. The seven-day retention policy is unchanged. The previously unlabelled writer now reports `lkg_stale_gc`.

Final BEGIN-to-COMMIT holds on the clone:

| Site / workload | Before (ms) | After (ms) |
| --- | ---: | ---: |
| session_project_backfill / one lease | 4.98 | 4.00 |
| embedding_identity_record / three largest commit projects | 213.92 / 84.60 / 210.45 | 0.29 / 1.10 / 0.24 |
| embedding_stale_gc / real vectors | 47.53 / 86.21 / 88.05 | 14.01 / 16.39 / 12.88 |
| message_fts_rowid_backfill / non-empty first range | 103.89 (500 rows) | 25.24 (100 rows, atomic read and write) |
| message_time_backfill / 500 rows, no host timestamps | 0.23 | 0.21 |
| git_sweep_lease / one row | 0.96 | 0.77 |
| lease-guarded-write / one checked update | 0.12 | 0.12 |
| LKG / eligible real backlog | 6600.37 (377 slots, rolled back) | 19.22 / 38.58 / 2.85 (three committed ticks) |

Read-only registration still takes 107–234 ms wall time on these projects, but does not exclude sibling writers for that scan. Cold pages, checkpoints, filesystem latency and vector sizes mean a fixed row cap is not a hard real-time guarantee. These sequential runs reused a clone, deleting some vectors between samples; they are not matched cold-cache Windows benchmarks. `before.jsonl`, `after.jsonl`, `final.jsonl`, and `final-atomic-fts.jsonl` are retained beneath the throwaway root; the intermediate run exposed lock-held repair discovery and prompted moving it outside the transaction too.

Pi now establishes the same foreground SQLite scope as OpenCode. Acquisition waits up to 250 ms without rerunning the handler or a partially executed callback. Existing last-good replay remains the recovery for longer contention. Busy errors with no valid replay now always refuse rather than serving size-checked raw input. Tests that checked the old raw-fit diagnostic still assert the same refusal but now expect the direct replay-miss reason. The GC regression's 250-row expectations become 25-row expectations with repeated resumable calls; this changes maintenance throughput, not which vectors may be deleted.

The new Pi test runs three first turns with no saved request, each against a real separate-process writer holding the lock for 80 ms. Removing foreground admission produces **3/3 refusals**; with admission there are **0/3 refusals**. Existing real-lock LKG tests also remain green. This demonstrates the admission gap independently of saved-request availability; it does not establish the reporter's session history.

## Coverage limits

The copy is already upgraded, so a before-v94 size comparison is unavailable. Actual smart-note checks and historian publications require their real note/check/host work; a keyed lease callback alone does not benchmark those callbacks. Orphan sweeping needs an authoritative copied host database and can delete arbitrarily large session histories despite a bounded session count. No copied host store was supplied here, and these workloads were inventoried but not exercised. The tests and timings cover changed background sites, not a proof that every possible publication, orphan deletion, wrapup expiry or arbitrary lease callback is below 100 ms. These remain follow-up measurement targets, not certified short transactions. No live host/store was opened, no migration was added, and no fail-open path was added.

## Verification

- Plugin focused maintenance tests: 70 passed; attribution tests: 31 passed.
- Pi full suite: 1413 passed, 3 skipped, 0 failed (127 files). An earlier parallel run failed the unrelated test requiring memoized 250k-token hygiene walks to be cheaper than cold walks; that test passed when isolated and in the final full run.
- Plugin full suite was run twice. The first run had 6348 passes and one Windows subprocess-policy failure in the new Pi fixture; adding `windowsHide: true` fixed it and its isolated gate passes. The final full run had 6347 passes, 4 skips and two unrelated 30-second timeouts (`author-palace` category spill and the non-git directory smoke test). Both affected files passed in isolation (19 tests). No claim is made that the final all-at-once plugin command exited successfully.
- Plugin and Pi `bun run typecheck` and `bun run lint` pass. Lint retains pre-existing non-null assertion warnings (and an existing template-style info in the plugin).
- Root `bun run build` passes. No manifest or lockfile changes were required; the suite scripts ran frozen installs in this worktree.
- Safe staged mutations independently reddened the named bounds tests for legacy identity registration, chunk repair, stale vector GC, FTS mapping, LKG cleanup, and Pi admission. Every mutation was restored from the staged implementation before live gates/build. The GC test's initial over-specific test filter matched nothing; the corrected filter executed and reddened the intended test only.
