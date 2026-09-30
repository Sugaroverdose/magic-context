# Rust planning after the single-store migration

## Result

ALF is the orchestration session `ses_227ce5788ffeRPA9THoPLOQreO`; AFT is the tool
session `ses_313660571ffeZTsf4koSJwk50Q`. Repeated passes that replay cached output
without recomposing the prefix (`SOFT+` defers), run on paired APFS clones,
returned to tens of milliseconds. The problem was **compartment coordinate validation**, not token
estimation, memory rendering, or the date cache. Both planning and the historian
trigger repeatedly loaded and fingerprinted every historical summary to validate
otherwise unchanged host-coordinate overlays.

The final release binary and a release binary using the original read implementations served
byte-identical CK **and OpenCode-native** output for all 15 matched inputs per
session. Nonce-only defer replays were byte-identical within each run as well.

## Incident log check

Read `magic-context.2026-09-30.log` in place; did not copy it. Selected
`mc-pass-timing` lines, which record per-request phase durations,
with the two exact session IDs and `action=SOFT+`, using timestamps before 17:30Z
and at/after 19:45Z. These are the medians observed when starting this investigation
(milliseconds):

| Session | Window | n | total | planning | trigger_ms | finalize | build_output | store_commit |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ALF | pre | 163 | 1078.30 | 19.30 | 245.80 | 262.40 | 209.60 | 260.40 |
| ALF | post | 12 | 1402.85 | 573.55 | 538.45 | 189.25 | 134.50 | 188.00 |
| AFT | pre | 168 | 1126.30 | 31.05 | 213.70 | 279.65 | 183.95 | 274.05 |
| AFT | post | 15 | 1123.30 | 475.20 | 393.90 | 230.70 | 137.40 | 229.30 |

The independently calculated medians show an approximately 30x ALF / 15x AFT
planning regression, despite the small post-migration sample.

## Isolation and reproduction

- Checked `df -h` before cloning: 152 GiB available; 148 GiB after the paired
  context/store clones, 143 GiB after also cloning the raw OpenCode input database.
  All remain above the required 20 GiB reserve.
- Used `cp -c` on database files and each existing `-wal`/`-shm` file. No SQLite
  connection, profiler, or module opened a live store. The raw OpenCode database was
  also APFS-cloned before querying it.
- All data, binaries, fixtures, response captures and logs stayed under
  `$TMPDIR/magic-context/perf-planning/pool-1198/`. No private payload or profile is
  committed. Each daemon/module pair is owned by the test and terminated on exit.
- The real-daemon probe runs `lsof -p` for the daemon and module processes and asserts that every
  database path is under its canonical throwaway root. The final read-profile
  helper performs the same assertion for its process.
- The context clone is about 7.0 GiB, the cache clone about 885 MiB. ALF has 1771
  accepted coordinate overlays; AFT has 1995. Their host-wire tails contain 581
  and 422 messages, starting at absolute ordinals 121942 and 134085 respectively.
- Used the installed `ck-subc` binary with an empty isolated module configuration,
  isolated HOME/config/runtime/data homes, and explicit release `ck-mc --subc`.
  The daemon never connects to production. Historian model chains are empty, so
  trigger preparation/evaluation executes but no model production occurs.

The writer fence rejects writes from a lease whose epoch is older than the last
accepted writer. The clone retains production epoch 347, but the new temporary
path's lease starts with a lower epoch; it therefore rejects otherwise valid writes.
Reset `cortexkit_fence.epoch` to zero **only on clones**. Raw host input differs
from the historical transformed block-identity pins, so removed the two sessions'
`mc_block_identities` **only on the initial clone**, allowed a normalization pass,
and then made identical before/after clones of that normalized foundation. Shared
compartments and their summary bodies were not deleted or rewritten. This measures
real planning at historical scale, not an exact continuation of the live host's
in-memory ingress state.

Fixtures use `readRawSeedTailFromDb` on the cloned OpenCode database, retaining
parts and absolute ordinals. The test uses the Rust OpenCode codec to construct CortexKit's canonical wire
representation (CK),
sets the stored render/provider/model/system inputs, and requests `serve_native`.
Every third request appends an ordinary user message with a new ID/ordinal; the
other requests change only the nonce. These are full-tail requests, not the host's
transport-level delta protocol. Both runs receive identical sequences.

Reproduction entry points:

```sh
cargo build --release --locked -j 2 -p mc-module --bin ck-mc
MC_PLANNING_CLONE="$clone_root" \
MC_PLANNING_FIXTURES="$fixtures_json" \
MC_PLANNING_MODULE="$release_binary" \
MC_PLANNING_DAEMON="$isolated_daemon_binary" \
cargo test --locked -j 2 -p mc-module --test real_daemon \
  planning_clones_through_real_daemon -- --ignored --nocapture

MC_PLANNING_CLONE="$clone_root" \
cargo test --locked -j 2 -p mc-store cloned_boundary_validation_profile \
  -- --ignored --nocapture
```

`fixtures_json` is an array of objects with session/render/provider/model/system
fields copied from the persisted cache metadata (to reproduce the same rendering
configuration, provider/model identity and system-prompt hash), and `raw_messages`: OpenCode `{info:{id,role,time},parts,absolute_ordinal}`
records from the cloned boundary-inclusive tail. The root is required to be under
`$TMPDIR/magic-context/perf-planning/`. Recreate destination WAL/SHM files as a pair
when repeating a clone; do not leave a prior run's WAL beside a newly copied main
file. One exploratory run with an old destination WAL failed as malformed and was
discarded before the matched measurements.

## Profile and cause

Neither `samply` nor `cargo-flamegraph` was installed. Used the real module's phase
spans and a timed store-path helper rather than claiming sampled CPU stacks.

The expensive chain is:

- Planning: `apply_once -> detect_boundary_divergence_candidate ->
  max_compartment_end_ordinal / load_compartment_boundaries ->
  cached_context_boundaries -> load_raw_context_compartments ->
  ResolvedContextBoundary::identifies -> row_identity`.
- Historian: trigger preparation calls `max_compartment_end_ordinal`, reaching
  exactly the same validation chain. `boundary_messages` and trigger evaluation
  themselves were approximately 0.5–1.1 ms in the matched release runs, not the
  dominant cost.

Before the fix, each `cached_context_boundaries` call read the overlay JSON from
`store.db`, parsed it, selected all wide `compartments` rows for that session from
`context.db`, found each row by linear sequence search, serialized its entire
summary-containing record, and SHA-256 hashed it. `max_compartment_end_ordinal`
validated once to choose its branch and again inside `load_compartment_boundaries`.
When the cache records which compartments its frozen prefix covers, planning
also independently loads structural boundaries (sequences, ordinals and end IDs):
**three wide body reads in planning, two in the historian**, on an ordinary stable
pass. Structural overlay matching introduced another quadratic search.

The isolated debug-profile helper measures two validation calls and one max-end
call (four validations). Original warm medians were 2424.780 ms ALF / 2563.132 ms
AFT; cached warm medians were 24.000 / 40.297 ms. These debug numbers isolate the
read/validation chain; they are not release-pass latency claims. Cold cached bundles
still pay the required validation, 1258.801 / 1417.992 ms in that debug run.

Other cheap per-pass context reads remain uncached so classification immediately
sees new revision heads and publication signals: `load_m1_revision_snapshot`
reads workspace membership, visible memory/mutation maxima, compartment sequence,
note update maximum, project epoch, m0 mutation head and global profile version
inside one snapshot. Structural boundary queries still read sequence/ordinals/end
ID, not summaries. Pending drops and tag baselines remain cache-store inputs;
historian token priming reuses the pass's hydrated tag snapshot. Compartment date
cache reads are a rendering input, not the repeated defer-path body scan.

## Fix and freshness

Cache only the **validated coordinate list**, not the history or memory bodies.
The cache key includes session, exact persisted overlay JSON, the context domain
identity, and SQLite `PRAGMA data_version` from the stable reader connection. On a
miss, the version and source rows are read in the same transaction. Both production
and plain SQLite domains use one reader distinct from all writers; custom domains
must explicitly opt into that guarantee or they always reload. Replacing the
domain clears the cache under the same mutex.

An external commit, including a direct SQL summary repair with unchanged count and
maximum sequence, changes `data_version` and forces validation before reuse. A
cache-store-only coordinate change invalidates by JSON identity. Failed reads are
not cached. Retain at most eight sessions, with recency updates; retained entries
contain coordinates and source JSON, never summary bodies. Sequence maps remove
the repeated linear matching loops.

Invalidation is intentionally conservative: **any context.db commit** invalidates
the validation, even one unrelated to compartments. A workload continuously writing
unrelated context rows may still pay miss cost. No schema migration or assumption
that all writers maintain semantic mutation logs is introduced. This preserves
freshness even for maintenance tools writing directly to SQLite.

## Matched release measurements and exact bytes

Baseline restores the original master validation and structural-matching methods
in the staged implementation, builds a release binary, then restores the index
before building the final binary. Added inactive cache fields/counters do not alter
baseline behavior. Both binaries were built with `--locked -j 2` in this worktree.
The existing lock correction was cherry-picked from master commit `282445eeff` because
base Cargo.lock did not match sibling `subc-client-rs` 0.23.4.

Fifteen passes per session per binary; medians below use passes 3–14 (12 confirmed
`SOFT+` defers). Timings are milliseconds:

| Session | Binary | total | planning | trigger_ms | native_attach |
| --- | --- | ---: | ---: | ---: | ---: |
| ALF | original | 171.167 | 101.807 | 72.986 | 65.303 |
| ALF | final | 99.518 | 17.923 | 18.397 | 79.435 |
| AFT | original | 169.115 | 113.240 | 81.612 | 42.885 |
| AFT | final | 84.059 | 19.107 | 19.826 | 51.292 |

The clones reproduce the expensive read chain, not the live log's exact 475–574 ms
wall times: release clone baselines were 102–113 ms. No exact reproduction of the
live 15–30x multiplier is claimed. Final planning is below the observed pre-window
medians, and trigger time is below both observed pre-window medians.

Compared actual serialized `{ck_messages,native_messages}` bytes, not a proxy
fingerprint or a response containing null native output. The probe asserts native
output is an array. All 30 baseline/final pairs were equal; each run also asserts
nonce-only replay equality. Final pass bytes:

- ALF: 2,884,951 bytes; SHA-256
  `f110db4a2dda76feb0a02093d3fa30411504d544accf92c87972485d861ddd05`.
- AFT: 1,787,054 bytes; SHA-256
  `d9bc460b2d44e2928f8c8c104f60ef87e934a8503c0eef3397c25ed05f78e5fa`.

## Gates and guard evidence

- AFT `aft_inspect` scoped Rust diagnostics: zero errors/warnings for all five
  changed source files.
- `cargo clippy --locked -j 2 -p mc-module -p mc-store --all-targets -- -D warnings`:
  passed.
- `cargo build --release --locked -j 2 -p mc-module --bin ck-mc`: passed.
- `cargo test --locked -j 2 -p mc-module -p mc-store`: hit the 300-second execution
  cap under default test concurrency; no test failure had been printed.
- Retried with `-- --test-threads=2`: all 1437 module library tests passed (17
  ignored), along with the completed integration targets. The existing
  `mc_pipe_only_supervision_through_real_daemon` failed, and failed again in an
  isolated retry: its supervised module is never provisioned with context.db.
  Its throwaway module log says `context_db_missing: no context.db ... run ...
  doctor store init`. The ordinary real-daemon spine and hostless-init tests passed.
  This unrelated fixture provisioning failure is not changed by this fix.
- `cargo test --locked -j 2 -p mc-store -- --test-threads=2`: all 178 store tests
  passed (one opt-in clone profile ignored), plus doc tests.
- New read-bound/freshness regression measures actual wide SELECT invocations:
  twelve stable passes add zero body reads; a second SQLite connection rewrites
  content with unchanged row count/sequence, then publishes a newer block. The
  next reads reject stale coordinates, serve repaired content, and observe new end
  ordinal 9. A separate test changes only overlay JSON and observes new coordinates.
  Existing module tests `first_compartment_published_after_empty_bootstrap_hard_folds_and_mints_boundary`
  and `an_in_place_compartment_rewrite_by_another_writer_is_an_eager_hard_input`
  also passed: they verify that the next transform observes publication/body changes
  and takes the required HARD fold, rather than continuing to serve old content.
- Safe stage/mutate/restore controls: restoring the original per-call validation
  failed only `stable_boundary_validation_reads_bodies_once_and_reloads_external_publications`
  (39 body reads versus 3); ignoring `data_version` failed the same named test at
  the external-repair assertion. Each exact run filtered 178 unrelated tests.
  Both controls had nonempty diffs while applied and empty diffs after restore.
- Comment review: no unclear comments flagged. No mutation marker remains.
