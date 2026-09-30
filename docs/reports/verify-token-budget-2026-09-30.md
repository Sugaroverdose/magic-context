# Verify token-budget investigation — 2026-09-30

## Finding

The supplied invocation spent **1,418,834 prompt tokens** (324,812 input +
1,094,022 cache read) and banked nothing. Aggregate usage and the old log cannot
uniquely distinguish a refused-tool stop from a discarded final answer or a
single usage report jumping over the soft threshold: the old implementation
logged neither finalization nor refusals. In particular, absence of an old
finalize log is **not evidence that finalize never happened**. The live budget
setting and per-message finish/usage sequence were not supplied; the current
source default for verify is 1.7M, above that invocation's recorded spend.
No live store or configuration was modified or sampled by these probes.

Real OpenCode **1.18.30**, using the local Anthropic-shaped mock provider, reproduced
all three mechanisms. A fourth problem appeared first: OpenCode emits
`MessageAbortedError` for the transport's own abort, and the session-error hook
could mistake that late event for a provider failure in the replacement finalize
turn. The initial unmodified-host probes for (a) and (b) hit that race; (c) failed
with `DreamTokenBudgetExceeded` directly. Ignoring only that expected abort event
for budget-finalizing children exposes (a) and (b) reliably. Other provider errors
remain failures.

**Conclusion:** (c) reproduces a spend/error shape close to the reported incident,
but declaring it the historical cause from the supplied evidence would be
inventing missing telemetry. Both discard paths and the abort-event race are now
defended, and new logs make the next incident distinguishable.

## Host reproductions

`packages/e2e-tests/tests/dreamer-verify-token-budget-oc1.test.ts` uses the shared
verify implementation through `verify-broad`, bypassing incremental file-change
selection to isolate the budget behavior. It checks invocation status and actual
banked rows, not just mock replies. The six-memory map probe checks the persisted
file-mapping records in `memory_verifications`.

Each investigation step reports 20K new input + 100K cache read, with a 1.2 s
response delay so the real polling loop observes persisted usage. Refused steps
report 1 new input + 60K cache read. Output is deliberately small and not charged.
Failure probes explicitly use a **1.4M test override**, not an asserted live setting.

| Path | Script / measured result |
| --- | --- |
| (a) refuses twice | Ten 120K reports reach 1.2M; finalize fires; two more read calls are refused. Stops at **1,320,002**, banked **0**, token-budget failure. |
| (b) finalize reply crosses 100% | Same 1.2M pre-finalize spend; completed XML costs another 120K input + 120K cache. At **1.44M**, fixed code banks **1** verdict. Restoring the old charge ordering discards it with a token-budget error and banks **0**. |
| (c) coarse step skips 80% | Nine 120K reports reach 1.08M (<1.12M soft limit); the next report is 210K input + 120K cache. Stops at **1.41M**, no finalize request, banked **0**. This intentionally models a large newly-read input, not a 1M cache-read step. |
| normal verify batch | Five memories, two read turns per memory plus answer: **1.32M** at the 1.7M default; all **5** banked, no finalize/refusals. |
| normal map batch | Six memories, one read turn per memory plus answer: **840K** at the 1.5M default; all **6** mapped, no finalize/refusals. |

These are realistic *usage replays*, not measurements of Gemini's reasoning or
proof that every real memory requires this many turns. An in-flight step can be
sent before the polling loop notices the preceding usage; the hard cap therefore
is not an exact provider billing ceiling.

### Isolation and reproducible command

```sh
ROOT="$(getconf DARWIN_USER_TEMP_DIR)magic-context/verify-budget"
mkdir -p "$ROOT/home"
HOME="$ROOT/home" TMPDIR="$ROOT" MC_E2E_OC1_BUDGET_PROBE=1 \
  bun test --timeout 120000 packages/e2e-tests/tests/dreamer-verify-token-budget-oc1.test.ts
```

`opencode --version` is asserted to equal 1.18.30 before each probe. Each host has
separate config/data/cache/work roots and an isolated diagnostic-log override.
`lsof -nP -p <host pid>` is sampled before and after each run: every open `.db`,
`-wal`, and `-shm` must be inside the harness data home. One successful run sampled
PIDs **50287, 50896, 52897, 53271, 53646**, under respectively
`opencode-e2e-1790793094680-g245cx`, `...1790793114975-dj6yak`,
`...1790793132140-hide16`, `...1790793148263-cko4fd`, and
`...1790793164238-uuz3g4` beneath the root above. For example PID 50896 held
`data/opencode/opencode.db` and `data/cortexkit/magic-context/context.db`
(and their WAL/SHM files) there, with no database outside that data home.
This is sampled host-process proof, not a continuous descendant-process audit.

Observed diagnostic lines included:

```text
dreamer token budget: finalize fired {"budget":1400000,"spent":1200000,"finalizeFired":true,"refusedCalls":0,"hardStopped":false}
dreamer token budget: tool call refused {"tool":"read","hardStopped":false}
dreamer token budget: tool call refused {"tool":"read","hardStopped":true}
```

## Fix and batch sizing

Completed successful answers now take precedence over spend, including when one
poll receives multiple usage rows together, or a completed answer is already
available after two refusals. Usage is still charged; tools and validation retries
cannot extend a stopped budget. A child still investigating stops at the hard
limit or after two refused calls. Existing XML validation/application rules remain
in force: only a valid closed manifest can be banked.

Batch defaults change **verify 50 → 5**, **map 80 → 6**. The existing
[dreamer usage report](dreamer-token-usage.md), section D, measured matched OpenCode
Gemini runs at 114,728 tokens/useful verified memory and 95,659/mapped memory.
Those ratios include output and come from a selectively matched positive-output
subset, not a flash-specific full-population estimate. Consequently they are used
as conservative starting points, not an adaptive estimator: double each ratio,
then fit below 80% of the default prompt budget:

- verify: `floor(1,360,000 / (2 × 114,728)) = 5`;
- map: `floor(1,200,000 / (2 × 95,659)) = 6`.

The host replay above validates complete batches at these sizes. The four-minute
wall-clock floor is unchanged. Smaller batches sacrifice some shared-file reuse
and require more resumable scheduler cycles for large backlogs. Lower explicit
budget overrides can still trigger partial finalization. No live configuration
was changed and no guarantee is made for unusually expensive memories.

Existing disposition tests were rescaled to preserve their claims: one full batch
plus a durable tail, timeout/outage recovery, closed-subset acceptance versus
non-budget rejection, and resume of omitted IDs. Over-budget final usage was added
to the partial-map and partial-verify fixtures. The former 79/80 subset test is now
5/6; this changes fixture scale, not the closed-subset contract.

## Verification and mutation controls

- Plugin `bun run typecheck` and `bun run build`: passed (build includes four v2 loader tests).
- Full dreamer directory + async transport + dropped-input guard tests: **429 passed**.
- Five real-host usage probes: **5 passed**, including log assertions and lsof checks.
- Existing 1.18.30 map/finalize probe and the rescaled verify batch-floor probe:
  **2 passed**. The latter took 121 s, banked five verdicts, and started no second batch.
- Plugin `bun run lint`: fails on pre-existing formatting in
  `scripts/self-tag-trial/host-plugin.mjs` (plus unrelated informational template
  suggestions). Biome checking all changed plugin files passes; the unrelated
  file was not changed.
- Extra e2e `bunx tsc --noEmit`: blocked by unrelated existing diagnostics in
  imported plugin/harness/probe files (missing retina package subpath declarations,
  readonly command-hook typing, SQLite type mismatches, and OpenCode 2 fixtures).
  It reports no errors in either changed e2e test; plugin typecheck remains green.

Each control was staged before mutation, marked `NON-VACUITY BREAK`, shown with a
nonempty unstaged diff, then restored from the index and touched; the resulting
unstaged diff was empty. Each named red below was the **only** failing test in its
selected run; unselected host scenarios were filtered out, not claimed green.

| Mutated control | Exact red test (suite prefix where applicable) | Green control / result |
| --- | --- | --- |
| Discard completed answer in `charge` at 100% | OpenCode 1.18.30 verify budget: completed | 1.44M token-budget failure, banked 0; other host cases filtered |
| Restore transport abort of completed answers at the hard spend limit | dreamer budget on an async child > returns the final manifest after a soft nudge with 25 final tokens | 1-final-token case stayed green |
| Admit expected abort event as provider failure | OpenCode 1.18.30 verify budget: completed | MessageAbortedError, banked 0; other host cases filtered |
| Restore verify batch size 50 | runVerify disposition > banks a completed batch and reports the deadline remainder | mapper counterpart green; got 6 instead of 5 |
| Restore map batch size 80 | mapMemories disposition > banks a completed batch and reports the deadline remainder | verifier counterpart green; got 7 instead of 6 |
| Replace finalize diagnostic string | OpenCode 1.18.30 verify budget: completed | banking still succeeded; missing log assertion red |
| Replace refusal diagnostic string | OpenCode 1.18.30 verify budget: refusals | stop behavior unchanged; missing refusal log assertion red |
