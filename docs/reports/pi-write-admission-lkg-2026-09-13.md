# Pi high-fill write admission and LKG recovery

## Q1 — timeout and contender attribution

**Pi already had the five-second busy timeout. No missing-timeout fix is needed.**
`packages/pi-plugin/src/index.ts:957` calls the shared async opener.
`packages/plugin/src/features/magic-context/storage-db.ts:199–208` installs and logs the PRAGMA;
both open paths call it before their first fence read (`:2299`, `:2371`).
The initializer preserves it before WAL/schema work (`:905–918`).
The staged `all-hosts-window.txt:2` explicitly reports **backend=Node.js timeout=5000ms** at 11:25:34.821Z.
The new Node subprocess regression exercises the real shared opener and pending-operation implementation, checks the live PRAGMA, and waits through a controlled 100ms sibling writer.

The defect is **deferred transaction admission**. A read snapshot can become unwritable before its first write; SQLite cannot repair that snapshot by waiting in the busy handler. The original pending-operation transaction read tags/ops before attempting marker/drop writes (`apply-operations.ts:77` at base `3bf0cf34487d229f4fab587ed56c0a97151069e7`). It now reserves the writer before any callback or wire mutation (`packages/plugin/src/hooks/magic-context/apply-operations.ts:180`). The related Pi/OpenCode heuristic transactions and Pi content-decision transaction also use immediate admission.

**The staged logs do not identify a unique lock holder.** In particular, an invalidated WAL read snapshot need not have a writer still holding the lock when its upgrade fails. The absence of `site=` is not proof that every possible writer held for less than one second: the reporter only emits for instrumented calls above its one-second threshold (`packages/plugin/src/shared/write-transaction-timing.ts:7–22`); the original deferred wrapper here had no site report.

Evidence, with paths relative to the staged incident directory:

- `all-hosts-window.txt:87,90`: historian pid 40303 spawned at 11:59:25.901Z; full extension registration was skipped at 11:59:26.577Z. The separate child entry can still open storage and register its project (`packages/pi-plugin/src/subagent-entry.ts:82–100`), which entails boot/schema checks. Its publication is **later**, at 12:01:06 (`all-hosts-window.txt:108–110`), not evidence that publication held the writer at 11:59:35.
- `all-hosts-window.txt:764–769`: OpenCode session `ses_08df2045bffeBcWcqw60elghER` reports usage updates at .632/.650/.694/.709 around the collision. Its event path persists session metadata (`packages/plugin/src/hooks/magic-context/event-handler.ts:814`). These are plausible competing writers, not positive attribution.
- The indexer schedules debounced incremental writes and reconciliation (`packages/plugin/src/features/magic-context/message-index-async.ts:44–66`); Pi schedules reconciliation at handler entry. Other-process indexing can contend. A synchronous transaction on Pi's own single connection cannot concurrently lock itself through another callback on the same JS event loop.

## Q2 — why “retaining pair” still abandoned the pass

At the base commit, `context-handler.ts:4992–5011` caught the native-removal-marker write and returned `false`. That did **not** mean “leave all arc bytes unchanged”: `tag-transcript.ts:1061–1080` interpreted a structural-removal refusal as permission to replace the pair with sentinels and reported `removed`. `applyPendingOperations` then attempted the durable drop-mode/status writes. Its unguarded auto-reclaim caller (`context-handler.ts:6031` at base; now `:6030`) allowed the later write error to reach the outer transient-storage catch (now `:3718`). The caught marker exception itself was not rethrown. The log contains no stack identifying a particular tag, so the full-drop versus skeleton mode of the subsequent write cannot be determined from telemetry alone.

There are now two local defenses:

1. Immediate writer admission fails **before** tags are read or targets are mutated. On busy admission, pending operations return false and keep both the queue and served bytes intact. Errors after admission remain throwable: rolling back SQLite alone cannot roll back arbitrary wire mutations.
2. A failed *new* structural-removal marker returns an explicit `defer` veto (`packages/pi-plugin/src/native-replay-state-pi.ts:159–189`). The transcript composite recognizes it before either structural removal or sentinel fallback (`packages/plugin/src/shared/tag-transcript.ts:1070`). A previously dropped legacy arc still replays its already-authorized skeleton instead of resurrecting its raw bytes. The Pi content-decision writer similarly declines its new decision on transient contention before callers change content.

The regression invokes the same exported authorization function as the handler, not a test-side implementation. A SQLite trigger rejects the durable marker write; the committed Pi output array's SHA-256 must equal the actual last good committed pass, and the queue must remain pending. A separate real sibling lock exercises admission; releasing it allows the next pass to reclaim.

## Q3 — persistent unknown IDs are not head contraction

At base, `pi-lkg.ts:213` emitted `lkg_entry_id_gap` for an undefined **interior live-input ID**. Head contraction instead failed the exact-prefix reshape fence. The staged log showed 16 unresolved entries on consecutive passes (`all-hosts-window.txt:76,91`: 2911/2927 and 2913/2929), so capture itself remained unavailable.

The artifact directory contains two logs, **not the session JSONL or entry payloads**. Their aggregate counts cannot establish whether those 16 entries were custom messages, compaction-generated rows, fork-inherited duplicates, or another extension's messages. Claiming a specific kind would exceed the evidence. The mapper indexes only `type=message` branch rows (`packages/pi-plugin/src/context-handler.ts:1600–1619`) and deliberately refuses missing or ambiguous fingerprint buckets (`:1537–1579`). Thus generated host entries and ambiguous/mismatching branch fingerprints are source-supported possibilities.

LKG now uses a full detached-content SHA digest to identify individually unmapped entries, including leading ones, without assigning them a guessed JSONL owner. This identity is **LKG-only**: it does not authorize compaction boundaries or durable tag ownership. Capture still requires at least one stable JSONL anchor; duplicate synthesized identities, non-snapshotable content, reordered/interior missing IDs, and content changes refuse replay.

For head contraction, capture records output ownership separately from raw input positions. Replay checks every surviving input ID and digest through the captured anchor, removes only output entries owned by the removed raw prefix, preserves explicitly synthetic output entries, and appends the untouched new tail. It never slices served JSON by a raw input count. The handler supplies ownership through its post-commit reference maps. Synthetic todo results share their assistant owner's ID so a trim removes the whole injected pair; ambiguous duplicate synthetic call owners decline mapping. Missing output ownership refuses contraction rather than guessing.

Ownership survives hydration. The existing `lkg_slots.input_id_seq` text column accepts a versioned Pi metadata envelope `{version:1,inputIds,piOutputEntryIds}` as well as the historical plain array. OpenCode rows retain their array format. Output JSON bytes remain stored unmodified in `json_prefix`. The loader validates ownership references and output length. Old rows without a mapping still support exact-prefix replay but cannot safely contract; older binaries cannot consume the new Pi envelope and may discard that LKG cache row. No authoritative session state or schema fence is changed.

## Q4 — defense ordering and tests

1. The existing 5s timeout now governs writer **admission**, verified through actual Node SQLite.
2. Failed admission or failed new marker declines that mutation; the same Pi served-array SHA-256 survives and the queue retries.
3. LKG supports 2927 captured entries with 16 stable unmapped entries, 268 removed from the head, and two appended entries. Its raw fixture exceeds 204000 tokens under the real fit proxy while the mapped replay fits. This is a hermetic coordinator fixture, not a claim to replay the unavailable incident JSONL.
4. The installed-host tests still exercise the fit guard on both raw and replay arrays. A mapped contraction with a fitting append now serves captured bytes; an oversized append still aborts. The previous tests' unconditional reshape-refusal expectation was deliberately replaced with these stronger suffix/fit assertions.

New/updated tests: `pi-write-contention.test.ts`, `pi-lkg.test.ts`, `context-handler-lkg.test.ts`. Contraction tests cover content divergence, interior gaps, hydration, synthetic prefix ownership, removed output ownership, and corrupt durable mappings. Mutation results are recorded in the delivery declaration.

## Q5 — recurrence and OpenCode twin

Exactly **two** transient-storage → LKG-gap → over-wall refusals appear in the staged Pi log:

| UTC | raw entries | proxy bytes | proxy tokens | source lines |
|---|---:|---:|---:|---|
| 11:25:41.554–555 | 2637 | 828163 | 207041 | `pi-session-log-11-12Z.txt:39–40` |
| 11:59:35.797–799 | 2929 | 829770 | 207443 | `pi-session-log-11-12Z.txt:7190–7192` |

Only the second occurrence contains the “tool arc removal persistence failed” line. The surrounding ladder is shared, but the logs do not prove identical failed writes.

OpenCode's trailing-blank and thinking-binding durable markers already catch failed persistence and serve only frozen decisions (`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts:572–601`, `:639–676`). Those specific marker paths do **not** have Pi's escalation shape. OpenCode does share `applyPendingOperations` and had the same deferred admission hazard; it receives the immediate-admission/degradation fix, and its local heuristic mutation transactions reserve the writer first as well.

## Verification caveat

The initial full Pi suite had an unrelated nudge timeout and a 15ms hygiene performance-budget failure; the full plugin suite passed 4789 tests and failed two unrelated wall-clock performance budgets under load. All four failed tests passed focused reruns (Pi hygiene p95 4.273ms; plugin hygiene p95 10.202ms). No performance threshold or unrelated test was loosened. Typechecks and lint are recorded separately in the delivery; scoped AFT diagnostics had unavailable LSP producers, so compiler results are authoritative.
