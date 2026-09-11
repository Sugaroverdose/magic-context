# Explicit-drop investigation

## Report before implementation

A read-only SQLite connection and `VACUUM INTO` a local disposable copy confirmed the supplied lineage (the separator is literal U+241F, not U+001F). Command `toolu_01J19s6gEDeNTGomb1QGvZXy` was queued at 1789164662220 and first applied at 1789164662239. All 29 tool-result rows in tags 577–608 remain pending; text tags 595, 605 and 607 do not. The effective protection budget is 30,000 tokens. The emergency assessment and validation failure match the incident description. The committed JSON fixture contains only tag numbers, kinds, block identities and token counts, not conversation content.

### Drop selection

At the starting revision, `select_agent_drops` rejects `ctx.block_is_protected(id)` before emitting any explicit decision. The final selector filter applies that same protection again to automatic **and explicit** decisions. This directly contradicts the automatic-only protection ruling. The emergency selector separately removes protected arcs and recency-reserved candidates. An empty candidate iterator produces `-0.0` through Rust's `Sum<f64>` identity; it is not negative token accounting.

The observed pass is **Force85**, despite 95.1% of the usable soft budget. `derive_band_with_hard_wall` uses a separate absolute provider-wall denominator for Emergency95. Only Emergency95 sets `emergency_window_yields`; setting that flag in the fixture made automatic tool reclaim proceed and did **not** reproduce the incident. Reproducing the observed Force85 keeps it false.

The emergency lane does not consume an exclusive opportunity: explicit selection occurs before emergency planning and again after arc expansion. There is no 32-target cap. Ledger first-applied records the first successful target from a command, not that every target was drained. The three text drops explain the ledger timestamp without implying the other 29 applied.

The CC projector pairs user-carried results to assistant calls by tool-call identity, not by matching `ccm-N#0` message names. A fixture must exercise the projector rather than assume this pairing. Signed-reasoning exclusions remain a separate provider-safety constraint; this fix must not make signed reasoning rewritable.

### TypeScript parity

The premise that the current TS twin ignores protection for explicit requests is not true at this revision: `applyPendingOperations` lines 105–107 unconditionally skips every member of `protectedTagIds`, including non-synthetic operations. Its existing test `consumes protectedTagIds in tag-number coordinate space and protects member tags` explicitly expects a queued agent drop to remain active. `transform-postprocess-phase.ts` passes `args.protectedTagIds` directly. Thus this is a shared policy defect, not evidence of Rust-only divergence. The bounded implementation here changes Rust; TS behavior is reported, not silently redefined. A disposable JS probe called the real TS function with the same 32 tag identities/token counts, completed targets, pending DB rows and 29-member protection set: all 29 tools stayed active and all three messages became dropped. The two existing TS protection tests also pass. No plugin source or test changes are included.

### Historian taxonomy

`HistorianNoFireCause::FailureBackoff.canonical_cause()` unconditionally returns `rate_limit`. The handler chooses it for every backoff except `chain_exhausted`. No inspection of a 429 body occurs at this classification point. The durable validation string therefore cannot justify the rate-limit label; it is a lying reason field. The backoff duration and retry policy need no change. Validation rejection should have its own canonical cause, with the original validation text retained in diagnostics and `last_no_fire`, and the correct category in the decision ring; other unclassified failures should say `failure_backoff`, not invent a rate limit.

## Reproduction and bounded change

The Rust fixture uses the real CC-style assistant-call/user-result projector and `sel_item_from_flat`, with sanitized stand-in payloads sized from persisted tokens. It is a selector reproduction, not an archived full native request replay. It derives the 29-member window with `ProtectionWindow::from_persisted_rows(…, 30_000)`. Before the fix its named test printed `paired=true protected=true applied=false` for each tool-result tag 577–594, 596–604, 606 and 608, and `applied=true` for the three text tags, then failed `left: 3, right: 32`. No pairing failure or target-count cap was observed. After the fix all 32 apply, including when the command has already made its first application; the automatic emergency lane still reports zero candidates/reclaim.

Explicit target admission now excludes open arcs, newest-three ctx_reduce invocation exemplars, absent/frozen blocks and the existing signed-reasoning/pass-through safety constraints before those targets can price a ride. Automatic protection is applied before appending explicit decisions. A concrete automatic reduction can also supply a ride for an already-applied command remainder. The existing one-self-bust and defer behavior are retained.

`handler_backoff_blocks_refire_and_records_durable_skip_reason` first failed with actual `rate_limit` versus expected `validation_rejected`; it now checks the response reason, durable detail and ring category. The ring schema has only `cause`, not a separate `canonical_cause` field; its missing field was not evidence of a second classifier.

Two prior protection tests asserted the policy being corrected: the selector's combined automatic/agent protection test and the transform's persisted-row explicit-drop test now assert explicit admission while automatic protection retains coverage. The held-remainder byte-stability test previously used 70% against a 65% execute ceiling, relying on protection to hold explicit work; it now uses 10% to genuinely test a no-bust pass without changing its byte-stability assertion. Recovery/connect-failure tests now expect `failure_backoff` instead of an invented rate limit. No retry timing, provider validation or ledger storage semantics changed.

## Verification

- `cargo test -p mc-module --lib`: 1,143 passed, 8 ignored (private/manual fixtures), no failures.
- `cargo clippy -p mc-module --all-targets -- -D warnings`: passed.
- `cargo fmt --all -- --check`: passed; no Cargo.lock drift.
- TS twin probe: 29 pending tools / 3 applied messages; `bun test src/hooks/magic-context/apply-operations.test.ts` from packages/plugin: 2 passed.
- The newest-exemplar guard was neutralized with a staged-state-safe `NON-VACUITY BREAK`. Only `selection::tests::explicit_drops_keep_newest_three_ctx_reduce_exemplars_and_open_arcs` ran and failed, exposing reductions of exemplars 3 and 4. Restoring the staged file returned the unstaged diff to empty and the same test passed.

The probe database and JS script were removed. No live DB writes, master push, lockfile changes, plugin source changes or deployment were performed. The pre-existing untracked `.cortexkit/alfonso/release-notes/v0.42.0.md` was left untouched.
