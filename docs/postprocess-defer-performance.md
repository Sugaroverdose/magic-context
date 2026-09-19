# TypeScript postprocess defer performance

Measured 2026-09-18 with Bun 1.4.2 on macOS arm64.

## Reproduction and scope

```sh
NODE_ENV=production bun packages/plugin/scripts/benchmark-postprocess-defer.ts
```

The benchmark clones `/tmp/ctx-bench.db` into a private temporary directory. It
never opens the live Magic Context database. OpenCode's message store is opened
read-only. The exact session ID is `ses_099ff1cb2ffeTSE956AjbUYyF3`; the shorthand
in the incident report is not a complete ID. The store contained 8,300 messages;
the benchmark selects its last **2,252 actual source messages** (7,771,030 JSON
characters), rather than manufacturing repeated message content.

This is an isolated phase benchmark, not a captured post-tagger request. It uses
the real persisted tag/replay state, fresh message objects on every pass, and a
persistent Channel-1 baseline map. It disables prefix injection and auto-search,
uses empty mutation targets and an empty protected-tag set, and holds the
scheduler at defer. Those choices isolate this phase but do not certify an
entire live OpenCode request. The unrelated tagger optimization is not included.

There are five warmups and twenty timed samples. Cloning the input, reading the
source messages, database cloning, and output hashing are outside the measured
phase. Both variants use the **same substage instrumentation**. For the before
run, only the new read caches and measurement memo were disabled; instrumentation
and the benchmark were unchanged. Each run started from a fresh database copy.

## Results

Milliseconds; `max` covers the twenty warm samples, not cold initialization.

| Stage | Before p50 | After p50 | After max |
| --- | ---: | ---: | ---: |
| entire postprocess phase | **38.025** | **6.371** | **7.467** |
| setup and operations | 0.5 | 0.4 | 0.5 |
| replay snapshot | 1.2 | 0.1 | 0.1 |
| stale ctx_reduce replay | 0.1 | 0.1 | 0.5 |
| processed images | 0.0 | 0.0 | 0.0 |
| placeholder neutralization | 0.0 | 0.0 | 0.3 |
| sticky nudge replay | 0.0 | 0.0 | 0.0 |
| marker reconciliation | 0.1 | 0.0 | 0.6 |
| deferred notes and todo synthesis | 0.6 | 0.4 | 0.5 |
| frozen reasoning/blank decisions | 0.3 | 0.2 | 0.4 |
| final representation | 0.8 | 0.4 | 0.6 |
| tail attribution reads | 2.5 | 0.0 | 0.0 |
| tail measurement | 28.1 | 2.8 | 2.9 |
| tail state and structural signature | 2.5 | 1.0 | 1.2 |
| tail baseline, inclusive of preceding three rows | 33.4 | 3.8 | 4.1 |
| last-writer guard | 1.1 | 0.8 | 0.9 |

The original structural-signature helper did **not** memoize the `{U,T}` walk.
`refreshTailHygieneBaseline` called `measureTailHygiene` on every pass. Existing
content-token memoization did not avoid attribution construction, tool-input
serialization, excluded-part serialization, or measurement assembly.

Cold initialization was 302.626 ms before and 317.742 ms after. The new memo
intentionally pays for a copied source on misses; the target here is steady
unchanged defer replay, not cold initialization. Changed messages, including
appended messages, currently invalidate the whole measurement memo rather than
using a speculative attribution delta. Structural comparison and the independent
last-writer alarm remain linear in structure size; unchanged passes skip the
expensive measurement, hashing and serialization work.

The four repeated warm phase outputs in both variants all had SHA-256:

`eb7f762b6db1f78f778382aa1be7dbe8b6ecf17d4971c2d607b8101c6646479a`

Separately, the full provider-wire differential against master
`ef3b226b93954332fa8a55beefc9eddea0c6984e` reported
`RESULT IDENTICAL defer_passes=4` for implementation commit
`88323363e510027c73585c259018b4fd658e9840`.

## Invalidation and safety

- **Tail measurement:** exact copied-value comparison of message id, role,
  summary flag, parts, tags, protected numbers and pending drops. Same-length
  historical edits invalidate, unlike a byte-count signature. Cache-busting
  passes remeasure. Retention is limited to eight entries and an estimated
  32 MiB. This does not change the independent last-writer guard.
- **Read snapshots:** per database connection and session, bounded to 100
  sessions. SQLite `total_changes()` invalidates local writes and
  `PRAGMA data_version` invalidates external commits. Transactions and database
  wrappers whose native transaction getter is unavailable bypass caching. This
  prevents an uncommitted snapshot surviving rollback.
- **Oldest reclaim hints:** database-clock invalidation plus exact protection-set
  membership. Pending drops, token counts and tag status changes are database
  writes and therefore invalidate the selection.
- **Frozen replay decisions:** the same database clocks, with fresh mutable
  containers returned for each pass. Speculative strip detection cannot modify
  the cached sets if persistence fails. Compare-and-swap winner rereads remain
  unchanged.

No migration, persisted schema, or rendered-byte contract changes. The existing
replay-row test intentionally now expects one read across unchanged passes,
rather than one per pass, while retaining its changed-row reload assertion.

## Verification and mutation controls

Plugin typecheck and lint pass. The full plugin suite passes **4,937 tests**.
An initial full-suite run exposed native SQLite getters on test proxies; the
cache now conservatively bypasses unsupported wrappers, and the full suite was
rerun successfully.

The new 200-versus-2,000-message test compares per-message medians in one process.
Its ratio limit is 3; an absolute 10 ms ceiling exists only under `MC_PERF_GATE`.
Instrumentation uses controlled clock increments of both 7 and 13 ms, not a
wall-clock sleep or a source-text assertion.

Safe staged mutations demonstrated:

1. Delete the tail-read timing write: only `reports measured postprocess
   substages once per defer pass` failed; the scaling test passed.
2. Replace the timing record with constant `7.0ms`: only the same instrumentation
   test failed (`expected >=13, received 7`); the scaling test passed.
3. Disable measurement reuse: only `reuses exact replay measurements without
   serializing tool input again` failed; attribution invalidation passed.
4. Add quadratic phase work: only `keeps defer per-message cost load-invariant
   between 200 and 2000 messages` failed (ratio 5.865); instrumentation passed.

Each mutation had a non-empty working diff and was restored to an empty working
diff from the staged implementation. No mutation is included in the commits.

## Pi twin

Pi has its own `measurePiTailHygiene`/baseline path in
`packages/pi-plugin/src/tail-hygiene-walk-pi.ts`; it does not call the optimized
OpenCode `refreshTailHygieneBaseline` or postprocess phase. It therefore does not
automatically inherit these caches just because their files live in the core
package. Pi's existing 250k-token hygiene performance fixture measured **1.806 ms
memoized p95**, versus **161.779 ms unmemoized p95**, with its existing content
memoization. No equivalent change is justified by that measurement. This is not
a 2,252-message Pi production profile; attribution-heavy Pi shapes would need a
separate measurement before recommending the same whole-measurement cache.
