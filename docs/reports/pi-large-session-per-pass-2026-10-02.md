# Pi large-session per-pass costs

## Scope and isolation

This change concerns Magic Context only. The requested Pi/provider wall-time
split was withdrawn by the owner; it is not inferred from JSONL timestamps.

The private session and `context.db` (including WAL/SHM) were cloned with macOS
`cp -c` into a task-specific directory beneath `$TMPDIR/magic-context/`. Each
replay then cloned that database seed again into an independent throwaway data
root. No live session, configuration, or database was written. Private inputs,
served arrays, timing JSON and mutation logs remain outside Git.

The baseline was archived from `df31b3819bf7922c2832bcc4426486207c92c0e2`.
Both handlers used the same augmented replay runner, database seed and fixture.
The runner clones messages before each context event, matching Pi's hook
isolation rather than letting a transform mutate later fixture passes.

The lane is `historian-low` (25% pressure, mock historian, headless), with
accumulation points 69750, 69752, 69754, 69756, the fixture's final point, and
five repeats of the final point. This is ten real-context-handler passes,
not a microbenchmark of a replacement implementation. The cloned database
contained 44,563 session tags, substantially more than the visible wire's tags.
The run uses Bun and the repository's Pi SDK fixture projection; it is not a
live Pi 0.99/Node/provider experiment. Auto-search and remote embeddings are
not enabled in this deterministic lane.

Reproduction (all paths below must point to throwaway copies):

```sh
bun packages/pi-plugin/scripts/experiments/perf/run.ts \
  --fixture "$COPY/session.jsonl" --database "$COPY/context.db" \
  --points 69750,69752,69754,69756 --repeat-final 5 \
  --lane historian-low --output "$COPY/timings.json" \
  --wire-output "$COPY/served"
```

`--wire-output` stores exact `JSON.stringify` bytes for each served array. All ten
baseline/final arrays compared byte-for-byte equal; all ten persisted behavioral
tag-row hashes also matched. This is stronger than comparing canonicalized arrays
alone. The comparison covers the replayed lane, not arbitrary remote search
results or provider timing.

## Measurements

Milliseconds, medians over all ten passes, including the first cold pass:

| Stage | Baseline median | Final median | Baseline max | Final max |
| --- | ---: | ---: | ---: | ---: |
| `lkgCapture` | 171.405 | 32.757 | 248.640 | 308.488 |
| `getTagsBySessionSnapshot` | 44.950 | 3.473 | 48.671 | 132.280 |
| `historianScheduling` | 235.631 | 281.956 | 17840.319 | 15458.550 |
| `applyPendingOperations` | 323.119 | 262.123 | 323.119 | 262.123 |
| `runPipeline` | 178.481 | 176.638 | 11180.261 | 16557.009 |
| `postTransformPhase` | 30.494 | 41.039 | 97.989 | 387.235 |
| `entryParseAndBranchResolution` | 16.950 | 21.360 | 567.250 | 607.502 |
| `total` | 475.705 | 549.022 | 29935.514 | 33341.226 |

`lkgCapture` is deferred capture work and is outside the handler's reported
`total`. Do not add overlapping stage totals or present a reduction in deferred
work as a measured reduction in `total`. The stable final passes reuse all 1,170
input fingerprints. Shared-machine scheduling and cold database costs vary
substantially; the data demonstrates the LKG and tag-snapshot improvements,
not a statistically established historian or end-to-end speedup.

## Changes and validity fences

### LKG

The existing Pi path already reused input digests on ordinary append-only passes.
However, cache-busting captures discarded both the replay slot and the input
reuse state, forcing prefix hashing again. Replay invalidation still happens
immediately for changed representations, but detached accepted input fingerprints
now survive that invalidation for capture-only reuse. Exact entry IDs and field
tokens, plus model/provider identity, must match before any digest is reused.

Output serialization also reuses an exact unchanged prefix, independent of host
object identity. Only new/changed messages are serialized. Fully unchanged arrays
reuse their captured JSON string. Non-plain values, custom serializers, accessors
and sparse arrays retain whole-array JSON serialization; field tokens alone do
not prove their JSON representation. An unchanged valid slot skips persistence,
including on a nominal cache-busting pass whose actual bytes/fences did not change.
Failed persistence still requires retry. Deferred work never reads live messages.

### Tag snapshot

A connection-local TEMP revision table and TEMP insert/update/delete triggers
observe tag writes through that connection, including direct SQL. SQLite
`data_version` observes commits through other connections. Unrelated local
metadata writes do not invalidate the snapshot. The cache is bounded to 100
sessions per database handle and returns fresh shallow tag records, preventing
heuristic edits from contaminating later reads. Nothing changes the durable
schema or stores revision records in the main database.

### Historian/raw branch

The provider now counts folded raw ordinals without materializing content, exposes
that count to bounded consumers, and avoids copying the entire branch-reference
array for full conversion. Historian trigger inspection can read from the durable
compartment anchor onward, provided the anchor ID matches at its absolute ordinal.
Missing/mismatched anchors retain the authoritative full-conversion fallback.
Historical tool payloads outside a requested page are no longer synthesized just
to advance ordinals.

The copied session's persisted end ID did not match the raw projection at its
stored ordinal. Consequently its trigger evaluation correctly retained the full
fallback. This explains why a substantial historian speedup is **not** claimed
for this copy. The bounded path is covered by a matching-anchor regression test;
changing coordinates to force a faster replay would conceal the fallback and
change the experiment.

`applyPendingOperations` remains unchanged: its transaction admits the writer
before reading canonical state and mutating wire bytes. Hoisting a cached tag
read ahead of admission would introduce a race. Only one replay pass applied
operations, so its table entry is a single observation, not a distribution.

## Spike attribution and remaining costs

Read-only inspection of the supplied Magic Context log found:

- 07:59:37Z: `postTransformPhase` 12618.7 ms, of which `autoSearch` was 12587.7 ms.
- 08:00:53Z: `postTransformPhase` 5432.6 ms, `autoSearch` 5394.4 ms.
- 12:53:12Z: `postTransformPhase` 7002.6 ms, `autoSearch` 6925.7 ms.

These are awaited search work, not LKG capture or screenshot tokenization. Moving
search after the hook would change the served hints, so this change does not do
that. The deterministic replay does not reproduce remote embedding/search latency.

The 22:39:55Z `runPipeline` spike was 10314.0 ms, including 2548.6 ms in heuristic
cleanup. A roughly 5.6-second gap between tagging and pending-operation timing
was not subdivided in that deployed log. It cannot honestly be assigned to GC,
lock admission or image tokenization from those timestamps alone.

In the baseline cloned cold pass, pipeline time was 11180.3 ms and measured
synchronous database operations across the pass consumed 10425.3 ms. The visible
`token:bpe` sample was only 160.5 ms; historian scheduling separately took
17840.3 ms. These observations identify cold database/full-raw inspection costs,
but do not prove which individual SQL statement or GC event explains every
historical spike. No live lock contention was recreated. Additional per-query
and GC tracing would be needed for that stronger attribution.

## Verification and non-vacuity

The complete Pi suite, Pi TypeScript check, Pi lint and Pi build passed. Lint
retains one pre-existing non-null-assertion warning in the mural test.

Seven staged-state mutations were marked `NON-VACUITY BREAK`, tested, restored
from the index and touched. Each produced a non-empty diff while applied and an
empty diff after restore. Each failed exactly the named regression while the
remaining tests stayed green:

| Neutralized control | Exact red test |
| --- | --- |
| Capture-only prefix fingerprints | `reuses input fingerprints across a cache-busting capture while invalidating replay` |
| Output serialization prefix reuse | `reuses cloned output serialization and skips unchanged LKG persistence` |
| Unchanged persistence skip | `reuses cloned output serialization and skips unchanged LKG persistence` |
| Plain-JSON serialization fence | `preserves JSON serialization for non-plain output values` |
| Tag snapshot cache | `tag snapshots reuse unchanged rows and invalidate local, external and rollback changes` |
| Proven historian anchor paging | `historian tail pages from the proven anchor without hydrating historical tool content` |
| Out-of-page tool synthesis avoidance | `historian tail pages from the proven anchor without hydrating historical tool content` |

No mutation is present in the delivered tree.
