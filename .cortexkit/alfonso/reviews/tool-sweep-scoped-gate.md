# Scoped tool sweep executing gate

## Verdict: BLOCK

Two product defects were executed, not inferred: pre-fix marker-seam upgrade loses a previously served reasoning-only assistant on the first fixed-build defer; clone inheritance discards the adoption marker. A third distinction matters: even fixed-to-fixed restart preserves provider bytes but does **not** preserve the raw transform served array at this seam (an empty dropped-tool shell disappears). No product edits are included.

This is not a complete ten-sequence certification. HARD publication/fold and two-process mid-defer concurrency remain unexecuted. The matrix below explicitly distinguishes actual executions, narrower coverage, and gaps. The observed upgrade failure alone blocks shipment under the requested invariant.

## Executable environment

- Fixed checkout: task base `e27fc7f03b1c9f1a359d8c4ce88f340b3c4486c6`.
- Pre-fix checkout: `/tmp/scoped-gate-prefixed-954`, detached `4f9a3d1a4092bc2a7b914e071045cc54b7baea3e` (merge c138e68a's first parent, not a guessed relative master ref).
- Real host: `opencode --version` returned `1.18.30`; Bun `1.4.2`.
- `bun install --frozen-lockfile` run in both worktrees. No manifest/lockfile changes retained. The old checkout shares the installed root dependency directory via symlink; its product source is the detached pre-fix revision.
- Real `createTransform`, actual SQLite stores, fresh objects per transform call. Real-host probe restarts the process with `existingEnv`, preserving **both** host history DB and MC context DB, replacing only the plugin entrypoint.
- Captures distinguish raw hook arrays (unmodified JSON SHA256) from provider-message prefixes (only `cache_control` omitted, as in the existing host regression). These are not interchangeable claims.

## Sharpest finding: sequence 10, upgrade

Run:

```sh
MC_PROBE_UPGRADE_FROM=/tmp/scoped-gate-prefixed-954/packages/plugin/src/index.ts \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

Named red: **scoped gate upgrade preserves pre-fix priced marker-seam prefix**.

Final capture: `/tmp/scoped-upgrade-pin-954.log:4,14-18`:

```
aSha256=bee64b0dac82416d02dc871d1f7283ebfe0c658002961ecdf7a46490ea2745b5
bPrefixSha256=5dfa98ab1ffbe09f0a0d63b4a5eb11a53fd0afa4cba6a05d86c0fdc239bf809c
firstDivergence=50 targetA=51 targetB=-1
hookASha256=c36538b1bca6348ac51c60d7585ff260042d8af58da56fe8fafc808c3100cfba
hookBPrefixSha256=cce6233cf4cfc50708bd4ceadc3ef7b3c4fc88071823b6b7fd14d4920269368e
hookFirstDivergence=4
(fail) scoped gate upgrade preserves pre-fix priced marker-seam prefix
```

Full retained artifacts: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/scoped-upgrade-gate-ZHhXiu/` (before/after hook arrays, provider bodies, pre-upgrade ledger, pre-upgrade scheduler log, combined log, host/DB locations, gate-evidence.json). Test reaches the prefix hash assertion after proving pre-upgrade marker drain at ordinal 4, `decision=execute`, fixed-build `decision=defer`, no adoption marker in the pre-upgrade ledger, and target present in A. Thus this is not a failed fixture setup masquerading as the intended red.

The old priced seam pruned the tagging copy, leaving the reasoning-only assistant in the served array. Restarting on fixed code without an adoption marker replays the global sweep against the live array and loses that assistant. This is a real provider-prefix bust, not merely changing host metadata or cache-control. The pre-fix non-seam behavior differs: the legacy sweep in the direct transform arm already removes the assistant; three fixed legacy defers correctly preserve its absence. The non-seam arm was not separately run using an old-build priced process; it is the shipped legacy replay arm, not a claimed second cross-version execution.

### Required fix direction (not implemented)

Pre-adoption, select the sweep variant by the **last served bytes**, not a global default. TS durable `lkg_slots` (migration v81) records that prior array. Compute the old and scoped candidate arrays on a no-marker defer; choose the candidate whose prefix matches the durable LKG. Persist adoption on that defer **only** when scoped is the matching replay: this is reproducing previously served bytes, not first application of a mutation. Preserve the old variant when it matches. Explicitly decide fail-closed behavior for missing LKG and neither-match cases; do not silently call those cache-safe.

The fix must make this population-countable: emit a structured/stable event key **`tool_sweep_lkg_mismatch`**, session id, and condition **`lkg_absent` / `matched_old` / `matched_scoped` / `matched_neither`**. These outcomes must be aggregatable as counters over sessions/passes, not only a prose log that an operator can read. Pins must cover all four outcomes and both pre-fix seam and non-seam histories. Raw empty-shell geometry at the seam must be accounted for when matching the LKG; reasoning presence alone is not an array equality check.

## Sequence matrix

### 1. Legacy defer ×3, priced adoption, defer ×3 — PASS (direct transform)

Named test: **createTransform > adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (soft-execute)**.

`/tmp/scoped-pass-kinds-954.log:4-11`:

- legacy-1/2/3: `04006c59b8c824f3eef0bc3cf0de256c708fa9e0e988069efbe8c087fff3677d`, divergence `-1` each; reasoning assistant absent, no marker.
- soft-execute: `6608ad23b947b71e9f07ffde97bd7d22ac6167c2acadabccd5e80752cf26b383`, first divergence `25`; assistant restored, marker set.
- adopted-defer-1/2/3: same `6608...6b383`, divergence `-1` each.

These are complete raw served arrays, not only target-presence assertions. Comparison against an independently executed historical master binary was not done. Mutation controls: global-sweep rollback and unconditional adoption, below.

### 2. Bust permissions — PARTIAL

Same named parameterized test, suffixes **soft-execute**, **explicit-flush**, **force-band**: all three pass and flip the flag. Explicit-flush drives `historyRefreshSessions` permission (not the command parser); force-band drives 99% live usage while scheduler remains defer. Their preceding three low-pressure defers do not flip. Their priced hashes and following three defer hashes equal the soft-execute values above. Captured `/tmp/scoped-pass-kinds-954.log:15-19,23-27`.

HARD fold/publication was not driven. This is not evidence that every possible bust permission adopts. No end-to-end `/ctx-flush` command dispatch claim is made.

### 3. Actual restart, same DB — provider PASS, raw-array FAIL

```sh
MC_PROBE_UPGRADE_FROM="$PWD/packages/plugin/src/index.ts" MC_PROBE_EXPECT_ADOPTED=1 \
  bun test packages/e2e-tests/scripts/tool-sweep-upgrade-gate.test.ts
```

Named red: **scoped gate restart preserves adopted priced marker-seam prefix**.

`/tmp/scoped-restart-pin-954.log:4,14-18`:

- provider A and B prefix: `c55f141abd94e526007e1442ce797c3630c98b51ee00986384adc1db8f3155f4`, divergence `-1`, target `51 → 51`.
- raw hook A: `af13149013e1e53e5c0197be29d3d7656e73c9d2f32dcfbf44eb0becfa52951c`.
- raw hook B prefix: `2b5533f776811456a6c70d7b8bb3370f9344529e11291590b363e0add0106a7b`, divergence `4`.

The marker was persisted before killing the first host. Index 4 of A is the fully dropped tool owner reduced to an empty text shell; B has spliced that row, shifting the next tool owner left. Provider conversion removes this shell, hence wire equality despite hook inequality. Do not report this as raw-array byte-identical. Artifacts: `/var/folders/18/257zzylx4h1gbkcvs4cnpqqc0000gn/T/scoped-upgrade-gate-jkvDIH/`.

### 4. Fixed marker seam and copy/live rollback — provider PASS / mutant RED

Named test: **marker-seam full-tool replay preserves the reasoning-only assistant on defer**.

Restored product: `/tmp/scoped-seam-green-954.log:4-5`, `CKIOS marker replay prefix sha256=bee64b0dac82416d02dc871d1f7283ebfe0c658002961ecdf7a46490ea2745b5 messages=53`.

Mutation restored the global sweep, which prunes only the tagging copy on the seam and the live array on the following defer. `/tmp/scoped-mut-seam-954.log:13-17`: target expected `51`, received `-1`; only this test failed (existing dropped-boundary todo not executed). Restored before subsequent checks.

### 5. Full versus mixed owner — PASS with scope caveat

- Real transform fixture's full tool owner is older than 24 filler messages and is asserted absent after replay.
- **scoped gate mixed owner retains surviving text while full owner is spliced** invokes the actual batch: `SCOPED_GATE full owner spliced; mixed owner survives`. Disabling `splice` reddens exactly this test, `/tmp/scoped-mut-owner-954.log:16-19,39` (unexpected `full` owner with `parts: []`).
- Mixed-owner branch is a batch-level test, not an additional real-transform mixed-owner scenario. The marker-copy raw-array exception is documented under sequence 3, not concealed by this passing batch test.

### 6. Pre-fix reader tolerance — consumer PASS; stronger wording is false

```sh
MC_GATE_OLD_ROOT=/tmp/scoped-gate-prefixed-954 \
  bun test packages/plugin/src/hooks/magic-context/tool-sweep-clone-gate.test.ts --todo
```

Named test: **scoped gate pre-fix reader tolerates reserved ledger entry**. Imports the actual detached checkout's storage reader and reasoning consumer; reads an actual current SQLite ledger.

`/tmp/scoped-clone-reader-954.log:21-22`: `SCOPED_GATE pre-fix reader entries=["@tool-sweep-scoped"] stripped=0`.

Important: the old reader **returns** the marker in its generic set. It does not classify/filter it as control data. The consumer selects no real message because no message has that reserved ID. Thus “without throwing and without stripping an unrelated assistant” is executed; “reader never treats this as an ID” is not true literally. No mutation control was run for this arm.

### 7. Clone — FAIL

Named expected-red todo: **scoped gate adopted clone retains priced sweep policy**; run the command above with `--todo` to execute it (Bun reports todo and exits zero despite the captured assertion failure).

`/tmp/scoped-clone-reader-954.log:4-6,16-20`:

```
SCOPED_GATE clone source_adopted=false inherited=false
SCOPED_GATE clone source_adopted=true inherited=false
Expected: true
Received: false
```

The fixture uses the actual `copySessionStateForClone` with maximally permissive inclusion filters. The clone helper's `clonePiContentDecisions` drops anything not decoding as a Pi content decision, including this reserved marker. Pre-adoption clone remains legacy as required. A later source adoption after clone creation was not separately raced/executed. Defect is already present without any mutation; no speculative product repair is included.

### 8. Two-process mid-defer concurrency — NOT EXECUTED

No atomicity claim. Restart is not concurrency and is not used as a proxy. This remains an explicit gate gap; a controlled barrier after policy selection and before finalization is required to exercise both interleavings against one SQLite session.

### 9. Pi — PASS / mutant RED

Named test: **createPiTranscript > scoped gate Pi finalization preserves unrelated reasoning-only assistant**. Executes actual transcript tagging, tool target drop, commit, and `finalizeToolRemovals`. Tool arc disappears and unrelated signed-thinking assistant remains byte-equal.

Captured line: `SCOPED_GATE Pi removed tool arc; unrelated reasoning retained`. Mutation extending finalization to all assistant rows produced `Received: []`, only this named test failed (`/tmp/scoped-mut-pi-954.log:9-44`).

## Mutation ledger

All mutations used `NON-VACUITY BREAK`, staged the live implementation first, confirmed empty unstaged diff before mutation, captured non-empty diff while mutated, restored via `git checkout -- <path> && touch <path>`, then confirmed empty unstaged diff. No mutant is retained.

| Control | Changed path / non-empty stat | Exact red test | Other failures |
|---|---|---|---|
| Scoped predicate → global | tool-drop-target.ts, +2/-1 | adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (original unsuffixed test before parameterization) | none; 61 filtered |
| Copy/live global-sweep seam | tool-drop-target.ts, +2/-1 | marker-seam full-tool replay preserves the reasoning-only assistant on defer | none; one unrelated todo |
| Ignore canAdopt permission | tool-sweep-policy.ts, +1/-1 | adopts scoped tool sweeping only on a priced pass and preserves reasoning-only replay (soft-execute) | none; 63 filtered |
| Disable empty-owner splice | tool-drop-target.ts, +1/-1 | scoped gate mixed owner retains surviving text while full owner is spliced | none; two filtered |
| Pi prune every assistant | transcript-pi.ts, +1/-1 | scoped gate Pi finalization preserves unrelated reasoning-only assistant | none; other tests filtered |

The upgrade/clone defects are unmutated reds, not claimed as mutation controls. Reader tolerance, individual flush/force arms, and restart do not each have independent mutation proofs; the listed controls must not be inflated into full matrix coverage.

## Verification and retained pins

- Plugin and Pi package typechecks passed after final TypeScript edits.
- E2E package typecheck initially caught and fixed new `SpawnOptions` literal widening. Remaining errors are unrelated baseline errors in rust-harness.ts, opencode2 tests, rust-timeout-epoch-recovery.test.ts, retina-local-fs resolution, and readonly `[ignore]` assignment in command-handler.ts; recorded in `/tmp/scoped-e2e-tsc-final-954.log`.
- Passing targeted transform, policy, Pi and old-reader checks; existing real-host seam regression passes after mutation restoration.
- Upgrade and raw restart pins intentionally red when enabled with the environment shown. Clone defect is an executable todo, matching the nearby existing known-defect convention. No passing test was rewritten into the opposite claim.
- The report and test/harness changes are the deliverable; there are no product changes, no architecture edits, and no broad build/lint claim.
