# Rust adapter: receive split and archived replay-map cost

## Result and limits

On the hermetic real-daemon 1,500-message fixture, using replay metadata from the
operator-provided checkpointed context snapshot, adapter wall time minus the
module's **`handler_total`** fell from **20.62 ms p50 to 11.66 ms p50**. Four
post-seed SOFT+ passes passed the `< 40 ms` gate and retained all four pre-change
served-array SHA256 values. No Rust crate, module output, wire field, installed
binary, or production store was changed.

This is **not a reproduction or resolution of the live ~97 ms transport gap**.
The measured receive gap remained ~4–5 ms, including ~1.8 ms JSON decode. The
live process's event-loop workload was not reproduced. Its 58 ms apply time
also exceeds this fixture's baseline; the identified archived replay-map walk
is demonstrated, but does not establish that it accounts for every live
millisecond.

## What was exercised

- Base implementation: `98159ea19c18243ab54be930f4bf6131e436d271` (benchmark WIP
  subsequently preserved at `2fb4f9e4a`). Bun 1.4.2, macOS, plugin SDK 0.11.1.
- Real hermetic daemon and current-checkout module, using `RustTestHarness`.
  No daemon mock or transform-response mock. The mock provider/host process is
  booted by that harness; the measured adapter is invoked directly in the test
  process rather than through a busy live plugin process.
- 1,500 initial raw messages, 1,200 completed tools, 1 KB bodies; one 7,200-byte
  user tail appended per defer. The adapter resends its previous edge too:
  requests are 20,714 bytes on the first defer and 32,828 on subsequent defers,
  two wire messages each. A separate 18,432-byte control isolates small RPC cost.
- A clone/copy of `/tmp/ctx-bench.db` is opened **under the hermetic data root**.
  The original authorized snapshot is never written. The first supplied copy
  was malformed; the operator replaced it with a valid VACUUM snapshot before
  these measurements.
- The full copied database remains present, including its 1,469 compartments
  for the source session and 7,910 active memories. To pair deterministic raw
  IDs with a fresh module session, the source session's `note_nudge_anchors`,
  `auto_search_hint_decisions`, `trailing_blank_decisions`, and
  `merged_reasoning_stripped_ids` are transplanted to the fixture session.
  Their text sizes are 1,961 / 9,085 / 1,535,924 / 68,552 characters. These are
  **actual persisted replay fields, not generated padding**.
- Important limitation: source-session compartments, tags, mural and memory
  selection are **not remapped into the fresh module session**. This isolates
  adapter replay history; it is not a byte-for-byte reconstruction of the live
  session. Archived anchors mostly refer to IDs outside the synthetic visible
  window. Memory is disabled and the historian has no producer/models.
- The provider is Anthropic, including `info.model` on messages. Without that
  field the model-gated replay read is skipped and the empty-state benchmark
  misleadingly reports ~1 ms apply time.

## Receive instrument and attribution

`src/rust-runner/adapter-profiler.ts` instruments the **actual adapter SDK
instance**. It timestamps complete-frame `dispatch`, `decodeReply` entry/exit,
then the adapter transport call's resumed continuation. A 1 ms interval records
maximum timer delay during each request. The probes are test-only, explicitly
check the pinned SDK's private seams, and fail if the seams disappear. They do
not ship monkey patches in the production transport.

The response's existing module timers are paired with the request captured by
the same awaited call and its `request_observed_at_ms`. No duplicate module
handler timer was invented. `request_observed_to_handler` was 1–2 ms on the
measured defers. Complete-frame dispatch is **not kernel arrival**: time before
JavaScript can read bytes remains part of the residual. Consequently
`response_wait - handler_total - decode - scheduling` is a combined daemon /
wire / SDK-read / possible event-loop delay, **not proven pure adapter CPU**.

Inspection of SDK 0.11.1 `request` confirms that Uint8Array requests bypass its
JSON encoder, then await `send` and call `decodeReply`. The adapter already
caches routes; warm route/lane/encode timers round to 0.0 ms. There is no
measured per-call route-open or 100 ms timer floor. Twenty warm controls:

| Same 18,432-byte request | p50 ms |
| --- | ---: |
| Bare localhost TCP echo, equally sized response | 0.072 |
| Direct SDK request on existing real daemon route, `session.status` | 0.221 |
| Adapter transport, same status bytes | 0.231 |

The status control includes a small real module handler and has a smaller
response than the echo; it is not an identical-response serialization benchmark.

## Timelines

Live values below are the operator's last-20-pass aggregate from the supplied
stage log, not a controlled before/after. Hermetic values are medians of four
post-seed defers. Different rows' medians should not be summed.

| Stage (ms) | Live aggregate | Seeded before | Seeded after |
| --- | ---: | ---: | ---: |
| Adapter observed wall | 216.7 | 79.45 | 72.91 |
| Module `handler_total` | 52.3 | 59.16 | 60.94 |
| Wall minus handler, paired samples | ~164.4 | **20.62** | **11.66** |
| Transport response wait + decode | 149.0 | 63.45 | 65.45 |
| Wait + decode minus handler, paired | ~96.7 | 4.29 | 4.45 |
| SDK JSON decode | unavailable | 1.83 | 1.78 |
| Frame dispatch to decode entry | unavailable | 0.016 | 0.014 |
| Decode exit to adapter continuation | unavailable | 0.024 | 0.026 |
| Maximum 1 ms timer lag, per-call median | unavailable | 1.71 | 1.59 |
| Apply | 58.4 | **12.7** | **2.5** |
| Replay-choice read (inside apply) | unavailable | **8.14** | **0.44** |
| LKG preparation | 2.1 | 1.95 | 2.30 |

The supplied live log also includes a later 287–289-input / 281–283-output
window with 53–66 ms apply. Thus raw message count alone cannot describe its
state load. The expensive state is allowed to outlive the active raw window.

## Named apply walk and change

`runRustModePostprocess` used `getTrailingBlankDecisions` to parse/validate the
whole persisted replay document, enumerate it into a Map, copy the entire Map,
then filter all entries for absorbing strips on **every pass**, even when the
visible tail needed almost none of those archived decisions. The 1.5 MB source
field makes this cost independent of the number of messages in the response
delta. The profiler measures this reader directly, not a proxy counter.

The Rust postprocess path now asks only for visible assistants' decisions. A
bounded, connection-local cache holds a validated trailing-blank dictionary,
keyed by **exact freshly-read source text**, then performs keyed lookups for the
visible IDs. Returned Maps are fresh; callers cannot mutate the cached state.
Whole-document writers and all existing unscoped readers are unchanged. A
fresh raw read observes external writers, rollbacks, malformed replacement and
ABA replacements. The cache is bounded to four sessions and four million
source characters per connection; oversized documents bypass retention.

This removes repeated historical parsing/enumeration, **not all O(session)
work**. The raw JSON column must still be read and compared without a durable
fine-grained replay epoch. Visible message cloning, prefix validation, marker
reconciliation, and LKG JSON preparation still walk visible state. Removing
those safety walks would require another ownership/invalidation proof; none
were bypassed to manufacture the timing result. Compartment/memory mirror
stages are outside the logged apply bracket and cannot explain its 58 ms alone.

## Byte identity

SHA256 of `JSON.stringify(output.messages)`, compared by the final e2e run
against the independent pre-optimization log (exact equality on all four):

| Defer | Before = after |
| --- | --- |
| 1 | `79796d9b2588c90132fc146e8857f41464101b7189a05167b5ecea36b5975161` |
| 2 | `cc5186d7dbc71f57c7c2df14706af06c822d79fcca5547d58aecc86e99fca09a` |
| 3 | `6ddf0ceb6e3a2523c923f79a1b4ce7d100e0f96212aa3d77dbddb49ce75c27fa` |
| 4 | `6b83e415465f2078550330865d6dd87f394e60f59a287f6ea3c589db24259d91` |

## Reproduction and regression gate

From the repository root, with an authorized checkpointed **snapshot**, not a
production database, and hermetic Rust prerequisites installed:

```sh
MC_ADAPTER_CONTEXT_SNAPSHOT=/tmp/ctx-bench.db \
  bun test --timeout 600000 packages/e2e-tests/tests/rust-adapter-perf.test.ts > before.log 2>&1
# Repeat on the changed implementation, preserving the same snapshot:
MC_PERF_GATE=1 MC_ADAPTER_CONTEXT_SNAPSHOT=/tmp/ctx-bench.db \
  MC_ADAPTER_BASELINE_LOG=before.log \
  bun test --timeout 600000 packages/e2e-tests/tests/rust-adapter-perf.test.ts
```

Without `MC_ADAPTER_CONTEXT_SNAPSHOT`, the normal hermetic lane uses a new
in-memory database. Performance assertions are opt-in; defer, applied-output,
response-timer presence and two-message wire-delta assertions always run.
`MC_ADAPTER_SNAPSHOT_SESSION` selects another source replay session.

The load-invariant unit test drives the actual Rust postprocess path with
40,000 archived decisions. After warmup, four passes must neither parse the
unchanged document nor enumerate archived keys, while serving exactly the same
stripped output. A NON-VACUITY BREAK disabling cache reuse made exactly
`does not parse or enumerate archived decisions on four unchanged adapter passes`
fail (`Expected: 0; Received: 4`). The changed/rollback/malformed/restored-document
correctness test remained green. The mutation was restored before final gates.

## Verification caveats

Plugin `bun run typecheck` passed. The e2e workspace's `tsc --noEmit` retains
unrelated baseline errors in rust-harness, dropped-input-guard, prompt-surface-s6,
pi-compaction-off, retina-local-fs module resolution and command-handler; none
are in the changed benchmark/profiler. AFT diagnostics were incomplete because
its TypeScript server could not initialize, so the explicit compiler result is
the authority. No production transport priority or scheduling behavior changed.

The hermetic build touched Cargo.lock incidentally as the shared sibling
`subc-core` source moved from 0.18.11 to 0.18.12 and later 0.18.13 during this
session. Those lock changes were restored and are not part of the delivery.
The plugin SDK stayed at 0.11.1; module output hashes remained identical.
Because sibling daemon builds are not pinned across separate invocations,
small transport timing differences must not be attributed to this adapter
change. The archived-map unit control and the directly measured reader/apply
reduction are the isolated evidence for the optimization.
