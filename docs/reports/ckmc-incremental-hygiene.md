# ck-mc production-mode breakdown: copy-only prerequisite missing

| Step 1 fixture (requested messages) | Production-equivalent thread CPU / wall medians | Result |
| --- | --- | --- |
| ALF (7,500 + provisional assistant) | Not measured — no stage samples | Scrubbed backups unavailable |
| CEREB-sized (1,875 + provisional assistant) | Not measured — no stage samples | Scrubbed backups unavailable |
| Small (568 + provisional assistant) | Not measured — no stage samples | Scrubbed backups unavailable |

**Partial delivery: the references-off harness is implemented, but Step 1's
measurements are blocked. No incremental hygiene implementation or production
cost ranking is claimed.** The existing scrubbed backup directory
`$TMPDIR/magic-context/ckmc-perf/backups/` was absent in this worker's environment.
Checking readability of the two required files returned exit 1; no backup or live
database was opened, copied, recreated, or removed. The verification gates used
their normal isolated test stores, not profiling or live databases. In particular
no live context, store, or OpenCode database was opened. Restore an already-scrubbed
archived backup pair to that directory (read-only) to resume; do not copy the live
stores.

## Harness-only scoped override

The existing ignored `copied_sessions_per_pass_cost` test now accepts
`MC_PER_PASS_REFERENCES=off`. The default, or explicit `on`, retains both full
correctness references. Other values are rejected rather than silently profiling
the wrong mode. The setting is read only by this harness, not by production or
other tests. A private, thread-bound RAII guard suppresses the two predicates only
on the current-thread harness runtime, including normalization and warmups, and
restores the previous setting on scope exit or unwind. Concurrent tests on other
threads retain their default references. The meanings of
`MC_PREFIX_PROJECTION_DIFFERENTIAL` and `MC_NATIVE_ATTACHMENT_DIFFERENTIAL` are
unchanged; all override code is under `cfg(test)`.

`COST_CONFIG`, `COST_RUN`, `COST_SAMPLE`, and `COST_SUMMARY` explicitly print
`references`. References-off passes also assert that neither differential span
appears. The existing SOFT+ assertions and complete serialized CK / assembled
native-array comparisons across delta, warm-full and evicted-full modes are
retained. Those independent cross-mode comparisons are outside the timed spans;
they are not disabled by the override. Each mode still has three warmups and at
least 20 samples, for nine summaries / 180 measured passes on the default shapes.

After restoring the **existing scrubbed archives**, reproduce inside the isolated
worktree:

```sh
cargo test --release --locked -j 2 -p mc-module --lib \
  thread_cpu_clock_records_work_and_stays_opt_in -- --nocapture
MC_PER_PASS_REFERENCES=off cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
  -- --ignored --nocapture --test-threads=1
# Separate reference-on parity run; never subtract its medians and call the
# result a measured production-equivalent run.
MC_PER_PASS_REFERENCES=on cargo test --release --locked -j 2 \
  -p mc-module --lib copied_sessions_per_pass_cost \
  -- --ignored --nocapture --test-threads=1
```

Collect each summary's `thread_cpu_p50_ms` / `wall_p50_ms` by stage, especially
`evolution_hygiene`, its tag/index/parts/signature/refresh children,
`state_evolution`, `delta_expand`, `finalize`, `store_commit`, `build_output`,
`seed_or_sync`, `tag_overlay`, `handler_followup`, and `native_attach`. Record each
mode's load line. Zero samples are not zero cost. Without those samples there is
no measured basis for deciding whether to proceed to Design 2.

## Why the old harness and live breakdown need not agree

The prior plan's references-on ALF delta medians were 524.86 / 530.11 ms handler,
62.76 / 62.87 ms hygiene, and 119.54 / 121.37 ms native attach. Its subtraction
estimate was 257.635 ms handler CPU without references, **not a references-off
measurement**. Removing the projection and native correctness references explains
that test-only cost. It does **not** by itself explain the earlier live wall
medians of 504 ms state evolution, 313 ms delta expansion, 184 ms finalize and
148 ms store commit. Those production stages still do whole-session work.

Code-supported reasons for the remaining gap, not measured causal attribution:

- **Different workload and sampling.** The live inputs describe selected slow
  ALF passes, not all ordinary passes. This harness repeatedly streams one short
  provisional assistant with a two-message transport suffix, low usage (1%),
  fixed config, no new historian publications, idle historian state, and no model
  chain. It normalizes first and requires stable SOFT+ samples. It does not replay
  live execute/fold/drop/protection/publication events or their composition work.
- **Shape is not captured content.** Historical text is filler sized from tag
  sources, tool inputs are simplified, cross-message/unanswered tool arcs are
  repaired or converted to text, reasoning is 64-byte unsigned filler, and
  redacted reasoning is 32-byte filler. Native metadata is synthesized by the
  codec rather than preserving unknown fields, signed reasoning, tool metadata,
  or the exact input byte volume. Live reminder/drop-sentinel and recurring-call
  behavior is not preserved. Those differences affect traversal, hashing,
  attribution and native-prefix cloning costs even when message counts agree.
- **Persisted scale is deliberately retained, but not identical state.** The
  harness restores the original historical frozen units and uses persisted tags
  and overlays; it is incorrect to say it simply discards all history or tags.
  However m0/m1 frames are normalized and historical identity pins are replaced
  with the reconstructed request's pins. The earlier report observed 26,713
  identity-history rows in ALF's backup, versus about 7,500 current ingress
  messages. This can reduce seed/clone/commit work. The earlier fixture's 23,273
  projection blocks and 36,749 frozen units are not smaller than the supplied
  live counts (~22,900 / ~34,750); nominal block/unit count alone cannot establish
  that the fixture underrepresents expensive history payloads or dependencies.
- **Sharing and waiting differ.** An isolated handler on writable scratch clones
  lacks live SQLite writer contention, concurrent session cache competition and
  request queues. Host load near 40 can deschedule live wall spans and alter
  frequency/cache pressure. The harness still runs on that loaded host, but
  reports same-thread CPU as well as wall to separate computation from waiting.
  No per-stage live CPU values were supplied, so there is no defensible fixed
  conversion from live wall time to isolated CPU time.

Stage medians are inclusive and drawn from different passes: store commit is
inside finalize, hygiene inside evolution, and delta expansion outside transform.
Do not add those medians or use them as an exact latency partition. A useful next
comparison needs references-off samples first, then matched live work counters
(identity rows, block kinds/bytes, frozen payload bytes, pending drops and
composition/publication activity), without opening live stores in this task.

## Decision and verification boundary

Design 2 is not started: the task requires Step 1 to confirm hygiene's ranking.
The old arithmetic estimate suggests hygiene could be important but does not
satisfy that condition. A ranked recommendation and before/after timings remain
pending the new measurement. No epochs, wire/schema/migration, cache algorithm,
baseline semantics or signature format were changed. No mc-core changes.

Verification on cargo 1.99.0 (5f94df478 2026-08-27), rustc 1.99.0
(b940084d7 2026-09-28), clippy 0.1.99 (b940084d7e 2026-09-28),
rustfmt 1.10.0-stable:

- `cargo fmt --all --check`: passed (silent-success formatting gate).
- `CARGO_BUILD_JOBS=2 cargo clippy --locked -p mc-module --all-targets -- -D warnings`:
  passed, one all-targets package check, no warnings (19m24s including shared-slot
  queueing). This is authoritative compilation/typechecking of the change.
- `CARGO_BUILD_JOBS=2 cargo test --locked -p mc-module`: passed, **1,582 tests
  passed / 22 ignored / 0 failures**, including 1,558 library tests and 24
  binary/integration tests. The first attempt reached passing library and several
  integration suites but timed out at 30 minutes after 24m27s compiling/queueing;
  no test failure was observed. After confirming no owned child build/test
  survived, the cached rerun with a longer cap completed all targets, including
  real-daemon integration tests (about 14m30s total).
- Restored-state `CARGO_BUILD_JOBS=2 cargo test --locked -p mc-module --lib
  per_pass_ -- --nocapture --test-threads=1`: **4 passed / 1 ignored / 0 failures**.
  Covers clock opt-in, existing model-cache-TTL behavior, scoped/thread-local
  suppression (including nested scopes and unwind), and strict/default-on mode
  parsing. The copied-session harness is the one ignored test.
- Scoped editor inspection: partial/unknown while Rust analyzer was still
  checking; no clean-editor-diagnostics claim. Use the successful clippy/test
  compilation above.
- Release copied-session profiling and Step 2's recorded-session/provider-byte
  differential, one-unit measurement mutation and before/after timings:
  **not run**. The required backups are missing and no hygiene candidate exists.
  Pure replay is not claimed for this test-only harness switch.

### Scoped-override non-vacuity

The implementation was staged before applying a `NON-VACUITY BREAK` that made
`differentials_disabled()` always return false. The non-empty diff was
`crates/mc-module/src/tests/per_pass_cost.rs | 4 +++-` (one file, three insertions,
one deletion). Running the `per_pass_` gate made exactly
`tests::per_pass_cost::per_pass_differential_override_is_scoped_and_thread_local`
fail: actual `(true, true)` versus expected `(false, false)`. These independent
controls stayed green:

- `per_pass_profile::thread_cpu_clock_records_work_and_stays_opt_in`
- `tests::claude_code_response_resolves_per_pass_model_cache_ttl_from_module_config`
- `tests::per_pass_cost::per_pass_reference_mode_defaults_on_and_rejects_unknown_values`

The copied-session harness stayed ignored, not green. Restoring with
`git checkout -- crates/mc-module/src/tests/per_pass_cost.rs` and touching that
file restored an empty `git diff --stat`; the four runnable controls then passed.
A tool-service restart interrupted delivery of the first restore/check response;
the restored file and staged-state diff were independently confirmed and the
narrow gate was rerun to obtain a recorded result. No mutation remains. This
proves the test-only switch is defended, **not** incremental measurement parity.
