# CKIOS reasoning-only defer disappearance

## Status: not reproduced; no replay-semantic fix

The staged September 20, 2026 requests for `ses_06be916fbffezpvuoIO3ac4yMZ`
prove a historical tail rewrite: A at 12:48:01 contains assistant
`msg_0bedb7d8f001FvFOQdZoGqywkr`; B at 12:48:26 does not. The neighboring
user tool result and synthetic completion notice consequently merge at index
332. This investigation does **not** establish which stage removed that assistant.
There is no original TS transform-entry capture for B.

## Executed discriminators

- A real `createTransform` test uses `[step-start, reasoning, step-finish]`,
  `finish=stop`, completed time, and `anthropic/claude-opus-5`. It executes A,
  appends a newer reasoning/tool assistant, then defers B. The target and the
  whole previously served prefix stay byte-identical. This passes on the base
  code; it is diagnostic coverage, **not** a red-first reproduction.
- `bun packages/e2e-tests/scripts/ckios-reasoning-only-probe.ts <output-dir>`
  drives isolated real OpenCode processes against the mock provider, once with
  MC absent and once with the TS plugin. It produces a tool call/result, a
  completed reasoning-only assistant, a synthetic completion notice, then a
  newer reasoning/tool assistant and result. Probe plugins record the complete
  hook inputs and outputs. Both arms retain the target at wire index 3 in A
  and B. MC serves `[text " ", thinking, text " "]` on both. Tail cache-control
  markers move normally. This does not recreate the original 285 pending ops,
  81 auto-drops, or original marker drain from ordinal 20800 to 21398.
- The probe also has a `marker` arm (`MC_PROBE_LANE=marker`). It seeds a
  compartment and pending marker below the target, reloads deferred signals,
  warms live usage, and prices A at 96.5%/185000 tokens. The log confirms
  `decision=execute` and `compaction-marker drain: applied at ordinal 3`.
  B is `decision=defer` at 0.5%/1000 tokens and its hook input contains the
  host-trimmed marker projection. The target survives both hook outputs and
  both wire bodies at index 5. Pending marker state is null after the drain.
  This arm used the exact staged reasoning text/signature and notice text;
  only inert `printf` tool commands were executed. Captures:
  `/tmp/ckios-probe-pool951-marker-v4/`.
- Direct installed `@ai-sdk/anthropic` 3.0.82 capture retained historical
  whitespace/thinking/whitespace assistants and lone whitespace/empty-text
  assistants. This SDK-only experiment is not evidence about OpenCode's
  pre-conversion filtering or its differently pinned SDK build.

## Source and store checks

`applyFrozenTrailingBlankDecisions` has no newest predicate. A `strip` choice
retains one canonical trailing blank when stripping would expose terminal
reasoning. The target's frozen `strip` therefore does not explain its removal.
`stripReasoningFromMergedAssistants` restricts replay to its persisted selections;
new detections are gated on a priced pass. The TS Fable model predicate gates
explicit thinking-binding error recovery, not a demoted-reasoning hold.
Rust's `native_reasoning_keep_mids` is a separate native-overlay mechanism.
No matching model-gated demotion predicate was found in the Pi typed-reasoning
watermark replay.

The authorized read-only context.db query found:

- Notice tag 25233 is owned by `msg_0bedbd073001dWTdnRGldoxnBq:p0` (not the bare
  message ID), status active. Tag ownership searches must account for this suffix.
- No tag has the target ID as its message prefix or tool owner. There are no
  target pending ops. Applied pending ops are not a retained ledger, so their
  full historical membership cannot be reconstructed from that table.
- The target is absent from `stripped_placeholder_ids`, `stale_reduce_stripped_ids`,
  `processed_image_stripped_ids`, and `merged_reasoning_stripped_ids`. Its only
  session-meta occurrence is `trailing_blank_decisions: strip`, matching the
  staged snapshot. There is no target-specific persisted neutralization to
  seed in the requested final store-side arm. No stripped-placeholder ID in
  the read-only current store sorts newer than boundary
  `msg_0bc7d0493001eZJVUThylqRw00`; consequently the two original sentinel
  replay targets cannot be identified by intersecting newer IDs. Naming them
  without the original B hook input would be speculation.

## Remaining evidence needed

Capture original hook input and output around an affected pass, including the
host marker projection, or reproduce from a contemporaneous full host/context
DB snapshot. Neither the reduced real transform nor the real-host dual arm
removes the target. Therefore no claim is made that a next priced pass now
removes it, no speculative exemption/SDK-filter change is shipped, and there
is no live-predicate mutation proof. The existing latest-assistant thinking
rule and provider bytes are unchanged.

## Attribution repair

The analyzer and sentinel now share a scheduler-log fallback for TS passes
without durable decision rows. `--mc-log <path>` selects an explicit captured
log; otherwise the standard OpenCode MC log path is used. Durable rows from
the same pass retain precedence and their richer fold/drop attribution. No
transform code or DB-write path changes: **zero additional writes per pass**.
Reading/parsing the staged log averaged 0.118 ms over 100 warm offline calls
on this machine; this is analyzer cost, not transform latency.

The staged body copies (with generated adjacent metadata, never live dumps)
now classify B as `unaccounted_defer_pass`, with 189320 rewritten tokens.
A is unmetered in this reduced artifact set because its predecessor's response
is not staged. The API fixture separately verifies that A's supplied
`execute`/`pressure_refold` row wins over its scheduler line. Scheduler-only
defers cannot be accounted merely by nearby old marker text or a changed
billing header: that text is not evidence of an applied mutation. Existing
richer-row classifier behavior remains unchanged.

The discrimination test drives both the real analyzer and the sentinel's
default analyzer path. Neutralizing the fallback makes it fail with
`no_mc_pass_row`; neutralizing the conservative scheduler-only classification
makes it fail with `accounted_hard_marker_drain`. Both controls are restored.
