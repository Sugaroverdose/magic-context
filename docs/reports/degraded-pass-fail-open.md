# A degraded transform pass must never be served

## The incident

A busy database made one pass send a request 2.5 times larger than the previous one. Session `ses_110d87916ffeDbfbAjhUgyL8Ps`, OpenCode 1, TypeScript mode, `anthropic/claude-opus-5-5`. The lines below are copied from the live diagnostic log (`magic-context.log.1` under `$(getconf DARWIN_USER_TEMP_DIR)opencode/magic-context/`), which was only read:

```
15:55:50.291Z event message.updated: totalInputTokens=648983 contextLimit=872000 percentage=74.4%
15:55:52.658Z transform scheduler: percentage=74.4% inputTokens=648983 cacheTtl=never lastResponseTime=1790870150267 decision=defer
15:55:53.035Z transform tag persistence failed; continuing without tagging: SQLite writer acquisition remained busy
15:55:53.482Z historian skip: internal drain budget spent (130800/130800 tokens; resets in 3m)
15:55:53.485Z pending ops WILL NOT APPLY — reason=scheduler_defer pendingOps=591 context=74.4%
15:55:54.441Z transform: final-wire telemetry estimate=unavailable trusted=false conversation=unknown tools=unknown system=unknown toolDefinitions=unknown tail=[...]
15:55:54.441Z lkg_capture_declined degradations=tagging-persistence-failure
15:56:03.553Z channel1 evaluation: ctx_reduce=callable U=54052.02 T=1473060.97 ratio=0.0367 band=quiet ...
15:56:07.404Z overflow detected via session.error: reportedLimit=1000000 provenance=prompt_only pattern=prompt is too long
```

The provider refused the request with `prompt is too long: 1621877 tokens > 1000000 maximum` (from the brief; the plugin log records only the pattern).

What happened: the in-turn writer limit (250 ms) expired under fleet contention while tagging this pass's new messages. `transform.ts` caught the error, recorded `tagging-persistence-failure` and kept going with an empty target map. Every replay keyed on tag targets was skipped: about 40K persisted drops (`applyFlushedStatuses`), reasoning clearing and caveman rewrites. Channel 1 then measured 1.47M tokens in the conversation. The pass knew it was degraded, so it declined to store itself as last-known-good (LKG), but it still served the request. The request was about 2.5 times the previous one, and it broke both the storage-busy rule (never send unreduced messages: LKG replay, then lock retries, then a refusal) and the defer-replay rule (a defer pass replays byte-identically).

## The fix

### One path for a failed stage

`degraded-pass-refusal.ts` adds `DegradedPassRefusalError` and `degradedPassError(site, error)`, where `site` is the name the pass records for the failed stage. Inside the pass, `failPass(site, error)` records the degradation and then throws, which hands the pass to the messages wrapper's recovery:

- a SQLite busy or locked error is rethrown unchanged, so the messages wrapper's existing storage-busy path handles it: LKG replay, otherwise `StorageBusyRefusalError` and the host notice (toast and abort on OpenCode 1);
- any other error becomes `DegradedPassRefusalError` (user-facing code `MC-S06`). The wrapper treats it like `UnresolvedHistoryBoundaryError`: replay the LKG if valid, otherwise rethrow, which refuses the turn. On OpenCode 2, `isBlockingV2TransformError` includes it, so the context hook toasts and refuses before the provider.

In compaction-off mode `failPass` only records. There, OpenCode's native compaction decides what history the request carries, the pass only adds blocks, and the wrapper's contract is to pass the input through unchanged on any failure.

The tagging catch keeps `tagger.cleanup(sessionId)` before throwing, so the next pass reloads the tagger's counter and assignments from the database. Without that, a stale in-memory counter can keep producing the same UNIQUE collision on every pass.

### Per-degradation verdicts

The rule: if serving the degraded pass can produce bytes different from a healthy pass, or grow the request, it takes the replay-or-refuse path. Otherwise the table says why it is served. Line numbers refer to this branch.

| Site | Can bytes differ / grow? | Verdict |
|---|---|---|
| `tagging-persistence-failure` (`transform.ts` tagging catch) | Yes, grows. With no targets, persisted drops, truncations, reasoning clears and caveman replays are all skipped. This is the incident. | **Replay or refuse.** A busy writer goes to the storage-busy path; a UNIQUE collision or other error goes to `DegradedPassRefusalError`. Tagger state is still reset. |
| `flushed-status-failure` (`applyFlushedStatuses` / `batch.finalize`) | Yes, grows. The replay mutates messages as it iterates and has no rollback (`apply-operations.ts:503-553`), so some drops may apply and others not. | **Replay or refuse.** |
| `session-meta-early-return` (`getOrCreateSessionMeta` / cache TTL) | Yes, grows. The early `return` served the host's raw input with nothing applied. | **Replay or refuse** (`fatal`). Compaction-off keeps the early return. |
| `store-generation-rebase-failure` | Yes. Saved ordinals stay in the old host's projection. A boundary cut that cannot find its id keeps raw history (`inject-compartments.ts` `findBoundaryIndex`), and the postprocess marker drain compares ordinals. | **Replay or refuse.** The generation stamp is written only on success, so the next pass retries the rebase. |
| `compaction-mode-transition-failure` | Yes. A half-applied transition leaves a stale m[0]/m[1] baseline or marker state that a completed one would replace (`transform.ts` transition block, `compaction-off-transition.ts`). | **Replay or refuse.** This only happens on the first pass after a mode flip, and that pass retries. |
| `overflow-state-read-failure` | Yes, grows. If the block fails before it reads the overflow latch, a provider-overflow arm goes unseen and the synthetic 95% bump that drives the emergency drops never happens. The block also writes on every pass (`resetProtectedTailNoEligibleHead` below 80%). | **Replay or refuse.** |
| `rust-transform-unavailable` (new, `transform.ts` Rust branch) | Yes. The branch returned the raw input. Production always builds a module client in Rust mode (`index.ts:305-311`, `v2/hooks/rust-mode.ts:22-33`), so this is a wiring fault. | **Replay or refuse.** |
| `session-directory-fallback` | Can differ, cannot grow the conversation. The launch directory only selects which project's memories and docs m[0]/m[1] render, plus the materialize decision. It skips no drop, truncation or history cut. Refusing would refuse every turn on a host whose session lookup fails, and 32 existing tests use mocks with exactly that shape. | **Served, record-only, with an m[0]/m[1] freeze** (parent ruling). When a frozen pair exists and the host has resolved this session before (a `session_projects` binding exists), the pass replays the frozen pair byte-identically and leaves every rebuild signal pending (see below). A session with nothing frozen, or one the host never resolved (whose pair was itself rendered with the launch directory), renders as before. The size guard is the backstop. |
| `compartment-trigger-failure` | Not for this pass. The trigger only decides whether to start the historian (`updateSessionMeta(compartmentInProgress)`, boundary snapshot). The conversation bytes equal those of a healthy pass whose trigger declines to fire, and every persisted reduction is still replayed. | **Served.** The size guard covers an over-limit result. |
| `invalid-cache-ttl-fallback` | No relative to a valid config. A malformed `cache_ttl` falls back to the 5-minute default, which is a TTL healthy sessions use. It is deterministic config, so refusing would refuse every turn of every session with that config. | **Served.** |
| `auto-search-timeout` (`transform-postprocess-phase.ts` auto-search) | Cannot grow. A timeout skips appending a new hint. A persisted hint is re-appended before the search runs (`auto-search-runner.ts:256-263`), so a defer pass does not drop one it served before. | **Served.** |

The postprocess phase records more degradation sites than the ten above. They are listed here so nothing is silent. They are **not** converted in this change, because each needs its own replay-vs-detect analysis. The size guard below covers any of them whose request goes over the limit:

| Site | Effect when caught |
|---|---|
| `pending-operation-failure` | Rest of the pending-op batch skipped; earlier in-memory edits remain. Can be larger than a healthy pass. |
| `stale-reduce-strip-exception`, `image-strip-exception` | Remaining strips skipped; can be larger. |
| `m0-m1-injection-degradation` | Legacy history block re-injected instead of m[0]/m[1]; bytes differ, can be larger. |
| `m0-m1-fallback-failure` (fatal) | History missing from the wire; differs, cannot be larger. |
| `compaction-marker-drain-failure` | Marker not advanced, signal kept; can be larger than a pass that advanced it. |
| `note-nudge-cas-failure` | Nudge text not appended; cannot be larger. |
| `thinking-binding-recovery-…`, `merged-reasoning-strip-…`, `trailing-blank-…`, `proactive-thinking-strip-persistence-failure` | A strip whose persistence failed is not applied this pass (so the next pass's replay stays consistent); can be larger by the kept reasoning or trailing bytes. |

Follow-up candidates: the exception variants that can stop a replay of persisted decisions part-way (`pending-operation-failure`, `stale-reduce-strip-exception`, `image-strip-exception`, `merged-reasoning-strip-exception`, `trailing-blank-*-exception`). The persistence-failure variants deliberately do not apply a decision they could not persist. Applying it would break the next pass's byte-identity instead.

### The m[0]/m[1] freeze on a directory fallback

`transform.ts` computes `freezeM0M1` when the session directory fell back, a complete cached pair exists, and `hasRecordedSessionProjectIdentity` finds a binding (a failed read counts as "freeze"). On such a pass:

- the explicit and deferred history refresh signals are not seen and not consumed, so `prepareCompartmentInjection` stays on its cached boundary;
- `protectionFoldWillBust` skips `mustMaterialize`, which also avoids its write of `cached_m0_project_identity`;
- postprocess skips the fold preflight and the soft refresh, and serves `prepareCachedM0M1Replay` (the persisted pair and its trim boundary) as the prepared prefix. That replay is marked contention-exhausted, so the history drain and marker drain treat the pass as not consumed;
- `pendingMaterializationSessions` and the explicit/deferred materialization successes are left in place, so the next resolved pass does the rebuild.

### Last-resort size guard

At the end of the pass, after the emergency fail-closed handling and before the LKG capture, `transform.ts` runs a guard when the pass recorded any degradation or its own final-wire estimate is untrusted. If no estimate exists yet and the pass is degraded, it estimates now, which is the only added cost and lands only on degraded passes. If the estimate exceeds `boundaryContextLimit`, it throws `DegradedPassRefusalError("served-request-over-limit")`, so the wrapper replays the LKG or refuses. An untrusted estimate is partial: it leaves out parts it cannot count, so one already over the limit is over for certain. The guard needs a known limit. `boundaryContextLimit` falls back to `inputTokens / percentage`, which is 0 when a synthetic usage bump meets an empty input sample, and a limit of 0 proves nothing. The check is the same estimator-versus-limit comparison as the existing in-pass `UnresolvedHistoryBoundaryError` fit check, which is the TypeScript-mode counterpart of `assertPiRawFallbackFits`. The Rust raw-fallback byte proxy is not used here, because it counts base64 image bytes as tokens and would refuse image-heavy requests that fit.

A healthy pass with no estimate (a defer pass under 95%) is not estimated. It is the previous request plus the new tail, measured by the last provider usage.

## Pi

`packages/pi-plugin/src/context-handler.ts` (catch at about line 3895). After an ordinary, non-storage error the handler logged `context handler failed (continuing without mutation)` and returned `undefined`, so **Pi sent its own unmodified messages**: unmanaged, without the session's drops. The transient-storage branch was already safe. It tries the LKG and checks fit with `assertPiRawFallbackFits`, which refuses whenever measured system and tool-definition tokens are missing, and no caller passes them. So that branch always refuses.

Pi has no catch-and-continue around tagging. A tagging or drop-replay error reached that top-level catch and was served raw. The change:

- `tagTranscript` and `applyFlushedStatuses` run through `runPersistedReplayStage`. A busy store is rethrown as is; any other error becomes `PiDegradedPassError` (with tagger cleanup first for tagging). The catch handles `PiDegradedPassError` exactly like a transient storage failure (`DEGRADED PASS` in the recovery log): LKG plus fit check, otherwise refuse. Compaction-off still falls through.
- Last-resort guard on the ordinary fall-through: when the messages alone (`tokenizePiMessages`, so without system prompt or tools) exceed the window, the handler throws `PiDegradedPassError("raw-messages-over-limit")`. Messages that cannot be read or counted are not refused, which keeps the existing "persists and clears top-level transform errors" behavior.

## Rust mode

- Host fail-open found and closed: `transform.ts`, Rust branch. `if (!rustModeTransform) { …"using raw passthrough"; return; }` served raw input. It is unreachable with production wiring, and now goes through `failPass("rust-transform-unavailable")`.
- `rust-mode-transform.ts` `run` already refuses. Module failures go to LKG replay, then `serveRawFallback` (`rust-mode-transform.ts:2238-2300`). That function throws `StorageBusyRefusalError` for a busy store, `RawFallbackContextLimitError` when the limit is unknown or the byte proxy or trusted estimate is over, and `EmergencyFailClosedError` in every other case unless compaction is off. The catches that keep serving after publication serve **module output**: LKG capture failures on non-busting passes, rendered-memory-id and nudge bookkeeping, optional writers. None serves raw messages. Tagging lives in the module, so the TypeScript tagging catch never runs in Rust mode.

## Tests

| Test | What it shows | Red when reverted |
|---|---|---|
| `transform-degraded-pass.test.ts` "replays the last good request when the writer lock is held across tagging" | Real `context.db`. A second connection holds `BEGIN IMMEDIATE` from the tagger's `initFromDb` until `cleanup`, i.e. exactly across tagging, on a session with a persisted tool drop. The served array equals the previous request byte for byte, plus the new turn as it arrived. | Tagging catch back to record-only: the served array contains the dropped tool output (`not.toContain("BULKY-TOOL-OUTPUT")` fails). |
| … "refuses with the storage-busy refusal … no last good request" | Same, with the LKG dropped: `STORAGE_BUSY_MESSAGE` refusal. | Same mutant: the pass resolves. |
| … "replays the last good request when the persisted drop replay fails" / "refuses when …" | `applyFlushedStatuses` throws a non-transient error: LKG replay byte-identical, or `DegradedPassRefusalError(site=flushed-status-failure)`. | Flushed catch record-only: both red. Wrapper without the `DegradedPassRefusalError` rethrow: the refusal test goes red (raw served). |
| "a pass that falls back to the launch directory" | Resolved first render; then a system-prompt change plus an explicit flush, with the host returning no directory: m[0]/m[1] are byte-identical, the cached system hash is unchanged and the flush stays pending. The next resolved pass rebuilds (system hash updated, flush consumed). | `freezeM0M1` forced false: red. |
| "the served-request size guard" | A degraded pass (directory fallback) over a 2,000-token window throws `served-request-over-limit`; the same request on a healthy pass is served unchanged. | Guard throw removed: red. |
| `transform.test.ts` (3 rewritten) | The old fail-open claims for unreadable session meta, a throwing meta lookup and a failing tagger init now assert the refusal, unchanged input, and tagger cleanup. | — |
| Pi `context-handler-degraded-pass.test.ts` | A tagging or drop-replay failure refuses (`PiStorageBusyError` caused by `PiDegradedPassError`); an ordinary failure over the window refuses; one that fits falls through. | `runPersistedReplayStage` rethrowing the raw error: both stage tests red. Guard removed: the over-limit test red. |
| Pi `context-handler-lkg.test.ts` "preserves intentional non-storage raw fallthrough" | Now reports a host window (272K) that its 170K-token payload fits, so it still pins "ordinary failures fall through and the byte proxy is not applied". Its old fake reported 100K, which made the same payload over the window, and that case is now a refusal by design. | — |

### Real host: OpenCode 1.18.30

`packages/e2e-tests/tests/degraded-pass-lock.test.ts` is an opt-in probe, excluded from the mode lanes. Run it with `TMPDIR=$TMPDIR/magic-context/degraded-pass/`, using the throwaway harness roots and the mock Anthropic provider. A wrapper plugin loads the plugin source unchanged. Once armed, it blocks the host at the tagging step's first writer acquisition (recognized by its stack) until a separate `python3` process holds `BEGIN IMMEDIATE` on the throwaway `context.db`. Every earlier write in the pass has already committed by then, which is the incident's shape. The lock is released when the pass settles.

The session: turn 1 sends a ~24 KB ballast message; the test marks its tag dropped; turn 2 is the healthy managed request; turn 3 is served under the lock.

| Run | Log | Turn-3 request (`messages` JSON bytes) |
|---|---|---|
| This branch | `transform tag persistence failed; not serving this pass` → `lkg_replay_served` | **575** (managed turn 2: 450, unmanaged turn 1: 24,502), no ballast |
| Base commit's `transform.ts` (catch-and-continue; swapped in for this run, restored afterwards) | `transform tag persistence failed; continuing without tagging` | **24,758**: ballast resent, larger than the unmanaged turn 1. The test fails on `not.toContain("BALLAST-DEGRADED-PASS")`. |

An earlier variant locked at the transform's session lookup instead, before tagging. There the per-pass overflow-state write met the lock first: `overflow recovery state read failed` went to LKG replay (699 bytes). On base, the next unguarded write threw to the wrapper, which also replayed. Locking exactly at tagging is what reproduces the incident.

Isolation: `lsof -p <pid> -Fn` on the host before the lock, on the host while locked, and on the locker listed only `.db`, `-wal` and `-shm` paths under `/private/var/folders/…/T/magic-context/degraded-pass/opencode-e2e-*/data/`, for example `…/data/cortexkit/magic-context/context.db` and `…/data/opencode/opencode.db`. The test rejects any path under `~/.local/share/{opencode,cortexkit}` or `~/.config/{opencode,cortexkit}`, and any path outside its root.

## Residual risks

- A deterministic, non-transient failure at a replay-or-refuse site refuses every turn until it is fixed, or until LKG replay stops validating. That trade is the rule's intent: a refused turn is visible, and an unreduced request is not.
- The OpenCode wrapper still serves the raw input after an ordinary (non-storage, non-degraded) transform exception when no LKG replays (`messages-transform.ts`, "Continuing with unmodified messages"). It has no context limit at hand. Pi now size-guards its equivalent path.
- On a directory fallback, historian scheduling and memory promotion in that pass still use the launch directory's identity. Only m[0]/m[1] is frozen.
