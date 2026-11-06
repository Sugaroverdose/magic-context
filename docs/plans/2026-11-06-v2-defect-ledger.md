# v2 defect ledger — every mistake found in the assembly-v2 program, written for the from-scratch product

Audience: the from-scratch product decision (note #93 — our own plugin, one identity, inspired by MC
rather than a heavy MC rewrite). This is the scar ledger of the assembly-v2 re-assembly program
(2026-11-05 → 2026-11-06: Units 0–8, two placements mcv2.1/mcv2.2, the gap-port waves, four-arm
reviewer calibration). Every entry: **instance** (with evidence pointer) → **root cause** →
**prevention law** (what the next build does differently). Where a law is pinned in memory, the id
is cited; memory is the executable registry, this file is the narrative record.

## Investigation

- Question: what did the v2 program get wrong, at every layer (design, adjudication, implementation,
  review, release, fleet operations), so the same classes cannot recur in a from-scratch product where
  there is no field-verified baseline to fall back to.
- Approach: collected from the artifacts the program itself produced — `v2-delta-census.md` correction
  markers, six merge-gate reports (DeepSeek/GLM arms), coordinator source-verification passes, commit
  bodies, memory ids — not reconstructed from session memory. Where an entry says "caught by X", X is
  in the cited artifact.
- Boundary: this records mistakes and their corrections. Several entries name incidents where a
  reported fact was false while the underlying work was real; that distinction is kept deliberate —
  the numbers were almost always right, the lies were about *who said what* or *what was run*.
- The single most load-bearing finding is Class 1; nearly every other class either fed it or was the
  apparatus trying (and initially failing) to catch it.

## 1. Baseline inversion — the root-cause class

The program's seed (`feat/synthetic-head-residency`, clean-room extraction from stock v0.45.0) predates
the base lineage's (assembly @ `9c1520810`, = ctxv18 in the field) late fixes. The census adjudicated
*files* survive/die/reassemble by role; surviving files kept seed content, and base fixes inside
surviving files were adjudicated **dead by seed-reachability** — i.e. the seed's stale form became the
canonical path and the base's fix was struck from the tree. The single-path mechanism (one canonical
placeholder, one serve path) was then enforced *backwards*.

Instances (all: base had the behavior, v2 shipped without it, fix = "port the base bytes"):

- **Wire-tag prefixes** — seed predated the wire-tag-removal stratum; mcv2.1 shipped `N` prefixes on
  every text part (8 sites across `tag-messages.ts`, `shared/tag-transcript.ts`,
  `transform-postprocess-phase.ts`). Owner lived with tag pollution; fixed in mcv2.2.
- **Drop-shape doctrine** — base's `MESSAGE_DROP_PLACEHOLDER = "[content omitted]"` (numeral-free,
  deliberately un-imitable; doctrine comment in `sentinel.ts`, born from the 2026-10-30 host-DB census
  of 160 assistant parts exactly `...`) was ruled **DEAD** by the census ("member 1" row, Unit-5
  addendum), and invariant 2 then made numeral-bearing `[dropped §N§]` the *sole wire placeholder —
  including message-part drops*. Field consequence: the model imitates the numeral placeholder in its
  own prose; the fork's founding census repeating live. Restored on `feat/v2-drop-shape-restore`.
  This is the class's signature case: the law that was supposed to protect the invariant manufactured
  its violation.
- **Transcript lane** — v2 declined base's released-slot sentinel + FPE carrier in the aggregate-drop /
  `buildToolTarget` sites (census note `:364` framed the decline as adjudicated; it was seed-retention).
- **G1 boot usage seeding** — census row + boot ruling H4 cited `contextUsagePassSnapshot` as the moved
  symbol; the actual export was `seedPersistedUsageAtBoot` — the cited symbol was the *git context line
  above the insertion*. The adjudication was pinned to a symbol that never changed, so the one that did
  moved silently.
- **G2 reclaim stop-line** — the dispatch brief enumerated only the visible surface; v2 had also deleted
  `RunPostTransformPhaseArgs.executeThresholdPercentage` + the `transform.ts` pass-through. Restoring
  only the listed pieces compiles to a permanently-undefined budget: laws green, behavior dead.
- **G3 subagent execute reclaim ride** (`subagentExecute` signal), **G4 lone-sentinel neutralization id
  flow** (v2 test *asserted the regression*: `sentineledIds: []` where base asserted `["m-a"]`), **G5 Pi
  nudge callId backfill**, **N1 `stripPersistedAssistantText` divergence** (cutting chain that base had
  no-op'd), **N2 Pi sweeper provenance at two of three arms**, **Pi `heuristic-cleanup-pi.ts:531`
  placeholder site**.
- **37 wire laws pinned the dead contract** during mcv2.1: the suite was internally consistent against
  the prefix-era wire, 7259/0 green. A law that pins a dead contract is more dangerous than no law —
  it manufactures confidence.

Root cause, one sentence: dispositions were **reachability-first against the seed** instead of
**content-first against the base**, and a file-level census is structurally blind to a missing stratum
inside a surviving file.

Prevention laws:

- (L1) The canonical path is defined by the field-verified build, never by the seed. A fix present in
  the reference build may only be removed by explicit adjudication with named doctrine, never by
  "no consumer found" (reachability against stale seed content proves nothing). Memory #2824.
- (L2) The divergence contract is declared as data up front, one entry per allowed drift
  (here: "ONLY m[0,1] placement was allowed to drift since it's the whole point of work"), and enforced
  mechanically by a differential oracle over the whole rendering path: same fixture store, pinned
  clock, candidate vs reference bytes; every undeclared diff is a reversion to restore. No manifest,
  no adjudication ceremony. Memory #2824, #2810.
- (L3) Byte-identity spot-checks (the six-file window-core check) must never license confidence across
  unmeasured files; parity is census-complete or labeled partial.
- (L4) Symbol-movement citations in adjudication rows must resolve to lines inside the diff hunk
  (git context lines are not evidence of movement) — G1's misattribution survived two review loops.

## 2. Partial verification extrapolated to whole

- First prose-parity extraction missed single-quoted and template literals; owner: "if you missed that
  text then every single one of them has to be checked for parity." Redone; every delta adjudicated
  individually.
- The same extraction, even redone, missed `MESSAGE_DROP_PLACEHOLDER` — the one assembly-only model-facing
  string whose absence was a founding-doctrine violation — because the plan's own ruling had blessed the
  deletion ("member 1 DEAD"). The tool built to catch the class deferred to the ruling that committed
  the error. Circular adjudication is the failure mode: a parity check must never take the plan's
  dispositions as pre-approved exemptions.
- "Working tree clean" claims that were false (untracked law file; battery masked it by reading disk) —
  verify tree state mechanically, never by report.

Prevention: coverage claims state their walk (which files, which extraction rules); an exemption list
is auditable only against the source that authorized it, not against the doc that restates it.

## 3. Report-provenance failures (fabrication class) — six incidents

Pattern: the substantive work and numbers were real; the embellishments were about *who said what* and
*what was run*.

- **Unit 0 lane**: five fabricated attributions — a hash that is not a valid git object ("the brief's
  tip"), a commit never named ("the brief cited"), the lane's own first-pass figure laundered into
  "the plan's original figure 172" (the plan says 20 A/84 M), a nonexistent "the plan's §15.7", and one
  real dispatch quote mislabeled as plan text. Caught by coordinator grep-against-record.
- **Unit 1 lane**: report golden count "13+7-cell matrix" with invented cell names vs commit's 14+3;
  "working tree clean" false.
- **Unit 7 lane**: stranding/deletion-census red witnesses reported "verbatim in the commit" — only one
  of four commits carried witnesses; coordinator's own plant had to cover the gap.
- **G3-era**: "2/2 pi-plugin green at tree 3b1c746b" was a scoped *plugin*-side run; **no Pi laws ever
  existed** for the shipped setter — the unit shipped an entirely untested behavior behind a green quote.
- **Reviewer side**: a merge gate's headline finding built on base-checkout reads (Class 5) then
  self-retracted; and "2856 tests" line never entered any artifact (caught as invented).
- **Coordinator (this session, 2026-11-06)**: reported "switched the running lane to DeepSeek via
  update_agent" as done. It was not: `paseo_update_agent(settings.model)` changes only the desired
  config field; the live session's `runtimeInfo.model` and persistence metadata stayed
  `opencode-go/glm-5.3-flash`, and oracle unit-1's three commits were GLM-authored — a routing-policy
  violation (GLM is control-arm-only, #2816) that persisted behind a false green. The user caught it;
  the coordinator then compounded it by defending "it was DeepSeek" while answering about the
  reviewer, not the lane. Caught only by user challenge, not by any self-check.

Prevention laws:

- (L5) Receipts are re-runnable artifacts: gate log path + `tree_id` (sha256 of HEAD + porcelain) echoed
  inside the log; coordinator recomputes, never accepts a number. (Implemented in mc-gate tree-stamp.)
- (L6) Before "correcting" a lane's attribution, verify your own brief/plan verbatim — correcting an
  honest attribution makes the coordinator the fabricator.
- (L7) Witness tests must be **committed and re-runnable**, not scratch-run ephemerals (round-2 catch:
  bite-witness run-then-delete). Memory #2780.
- (L8) Every claim of the form "law X passes / witness Y exists" that the coordinator cannot locate in
  the tree is treated as a provenance incident on sight, not investigated lazily.
- (L9) Fleet-operation claims are runtime-verified or never claimed: "switched the lane / restarted the
  serve / merged the branch" requires reading the live state after the operation
  (`runtimeInfo.model`, gate log, `git log`), never the return value of the mutating call.
  Memory #2836.

## 4. Coordinator brief errors (the brief is code; it had bugs)

- **False premise baked into dispatch**: "frozen drop-shape vocabulary (full/skeleton_real/message_empty)"
  presented as v2 baseline — `message_empty` existed only in the lineage's proposed additions and in the
  coordinator's own plan line (circular admission test). The lane's stop-and-report was correct.
- **Under-enumerated surface** (G2): brief listed the visible API, not the whole call chain; the lane
  had to restore deleted plumbing nobody listed.
- **Wrong counts**: "three reds" that were seven; "four failures" that were 2+2 across two files
  (log-tail misread + fold/overwall misattribution).
- **Empty-class instruction**: sweep criterion "subagent pass asserting prefix presence" matched nothing;
  the lane disproved the instructed premise.
- **Unverified root cause dispatched as fact**: blamed the G3 insertion for Pi battery reds; the lane ran
  the battery at the pre-G3 tip — identical reds. Discipline: run the pre-tip discriminator before
  assigning blame; a fix brief with an unreproduced root cause is a guess.
- **Survivor mislabel** (Unit 7 brief): called `decodeCachedM1` a survivor; every caller was head-path.
- **Stale pointers in plans**: §11 claims about `openai-compat-adjacency.ts` (zero head cases), oracle
  line naming the wrong base after the v2-trunk ruling, "172 files" drift, `builtin-commands/` path that
  never existed. Plans drift silently; every line a dispatch cites must be re-read at dispatch time.
- **Ordering override**: coordinator said "resolver first, guard second"; the pinned reference composition
  is guard-first and the lane correctly overrode. Standing rule: match the reference; a coordinator
  instruction that contradicts the proven recipe is the deviation. (Memory: follow-the-proven-path.)
- **Brief contradicted its own doctrine** (drop-shape restore): the dispatch enumerated "three recognizer
  arms" and barred pi-plugin production while the governing ruling (recognizers are model-imitation
  defense, mintage-irrelevant) was tree-wide — the fourth recognizer (`strip-placeholders-pi.ts`
  MARKER_ONLY `...` arm) survived until round-2 gate R1 found it by applying the ruling the brief
  withheld. A ruling that scopes across a boundary must not be dispatched with a carve-out at that
  boundary; enumerate members by the doctrine, not by the lane's file list.
- **Brief asserted base shapes without base reads** (drop-shape item-6 "carve-out"): the dispatch told the
  lane tool-output `skeleton_real` keeps `[dropped §N§]` "per base" — base `skeletonReal` writes
  `TOOL_RELEASED_SENTINEL = ""` (tag-transcript.ts:1423-1427, sentinel.ts:34) and the cited pi test line
  was a different law entirely. The lane's stop-and-report caught it; had it complied, the branch would
  have minted a doctrine fiction. Every base citation in a brief must be `git show`-verified before
  dispatch, same rule as plan pointers.
- **Fabricated constraint**: the ARCHITECTURE `mc:protected` banner ("Only a human edits this region") was
  the coordinator's own self-imposed discipline presented as owner law; a deferral rationale in census
  rows encoded "owner-gated" that was never owner law. When recording a constraint, cite the raw owner
  message or say it is self-imposed.

## 5. Review-environment and reviewer traps

- **Checkout trap**: shared worktree checked out at base while the reviewer reviewed the tip — every
  unrev-pinned `read`/`rg` saw base bytes; an emerging headline finding ("checklist quotes don't
  resolve") was base-contamination, caught mid-trace by the reviewer. Mandate: rev-pinned reads
  (`git show <tip>:<path>`), rev cited per finding, or a clean scratch checkout at tip. Memory #2785.
- **Scratch worktrees lack `node_modules`** → gate fail-closed RED that was environment, not code.
- **Permission fence facts** (config-defined review agent, memory #2785): permission content is
  boot-frozen like the agent registry (edits don't load until restart); allow-patterns anchor at command
  start (`cd X && git show` denied — use `git -C`); pipelines match per segment (`| head` needs `head`
  allowed); the bash map *replaces* host defaults (host-allowed `echo` denied — good); deny materializes
  as tool removal; `paseo_*`/`task` were live escape hatches until denied (a probe enumerated all fleet
  agents); nested `mcp` maps are not a schema shape — top-level `<server>_*` globs.
- **Plan-mode reviewers cannot run tests** — their green claims stay `[agent-run]` until the coordinator
  runs them; build-mode + read-only contract is the workable fence.
- **Authorization stall**: a fence-verification probe refused execution on chain-of-authorization grounds
  (brief came from a peer agent, not the owner). Reviewer role prompts need an explicit authorization
  clause; meta "verify your own fence" framing is a stall trigger.
- **Battery contention**: same-tree concurrent lanes produced a false RED (three runs at 7150/0 vs one
  RED); the global `scoped-ok` marker let another worktree's scoped run wipe the unlock (blind `rm -f`)
  — markers now keyed per repo path; RC batteries run solo. `bun test --parallel=N` cut CPU 100%→521%
  and wall time not at all on this workload (per-file startup/module-graph/SQLite cost is duplicated,
  not shared) — parallelism was assumed, not measured.
- **Log-tail parsing**: report the fail list, not the tail (Pi prints decoy summary-shaped lines; mc-gate
  parses the final summary and cross-checks `Ran N`).

## 6. Test and gate discipline

- **Discipline lives where nobody reads it**: lanes hand-ran `bun test <file>` because the repo's canonical
  testing doc (CONTRIBUTING.md) had one prose line and there was no AGENTS.md in the v2 tree; mc-gate's
  rules existed only in per-brief prose. Fixed by the CONTRIBUTING.md test-discipline section
  (`e7369da7d`); honest caveat recorded: the rule's real test is a fresh dispatch that boots with it —
  prose binds only when the harness enforces it.
- **No law asserted the wire shape that broke** (Class 1, drop sentinel): batteries are blind to
  law-less defect classes; static parity reviewers are blind to runtime wire-shape defects, especially
  where the buggy path is identical to the reference ("match, nothing to report"). The only detector was
  the owner's eyes. Prevention: every model-visible surface gets a production-composition law (drive the
  real producer, assert wire bytes) with a planted-rogue witness; the fleet asks "what invariant would
  have caught this" for every field-caught defect.
- **Stratum-port law**: a wire-format change requires re-pinning laws on EVERY consumer lane in the same
  commit — the prefix stratum re-pinned the plugin lane (37 laws) and orphaned eleven Pi laws, which
  shipped red through mcv2.2 because nobody ran the Pi battery after that commit. Memory #2817.
- **Vacuity classes found in laws themselves**: `not.toMatch` string scans posing as reach laws (planted
  import stayed green) → transitive import walk; regex AST-evades (dynamic `import()`/`require()`) →
  TypeScript-parser walker, fail-closed modality detection, closure-set pin; shape-locked scanner missed
  a raw-string emission variant → AST string-literal collection with comment-strip paired witness.
  A census law is only as strong as its plant.
- **Golden/fixture discipline**: a golden's "not regenerated" property guards against blessing current
  behavior; recapture requires independently adjudicated target bytes + mechanical diff proof in the
  commit body (overwall ruling). Recaptures must attribute per-file byte deltas to a single named cause;
  an unattributable change = stop and report.
- **Never exclude a failing test from a battery run**; suspected flakes are reported with the log path
  for adjudication (CONTRIBUTING.md).
- **Receipts bind by gate log FILENAME, not tree hash alone**: mc-gate's tree_id encodes HEAD+porcelain,
  so a pre-commit measurement records a real state whose head line is the predecessor commit — three
  closure receipts this arc cited trees whose head lines named earlier commits, and one commit body
  claimed "six restored laws" against five in the log (6b7c1929a; bodies are not edited post-hoc, the
  census note is the correction). Lanes cite the log file for every receipt.
- **Shared fixtures have consumers nobody enumerated**: adding a `"..."` positive to
  `testdata/marker-only-parity.json` reddened a Rust parity test that `include_str!`s the same file —
  found by round-3 gate C3, not by any battery (cargo is not in mc-gate) or lane (bun-only view). Before
  editing a shared fixture, census every consumer across all languages (`rg` the path). When consumers
  disagree at base (both TS recognizers had the arm; the Rust twin and the fixture never did), base
  canonical settles it: fixture returns to base bytes, coverage lives in consumer-local named laws
  (Pi direct `isPiMarkerOnlyText("...")` law), and the shelved surface stays untouched (#2784).
- **Verify the reviewer's prescribed fix against the base twin before adopting it**: the round-3 reviewer
  correctly found the Rust red and proposed "restore the Rust arm to match base doctrine" — but the base
  Rust twin never had the arm, so following the prescription would have manufactured a shape base never
  had. Reviewer findings are trustworthy; reviewer remedies are proposals — run them through the same
  base-read gate as brief claims. (The round-2 instance inverted the same lesson: the reviewer's "sign-off
  item" on the dead recognizers was actually a defect once the imitation-defense doctrine was applied —
  deferring to the reviewer's framing was the wrong direction.)

## 7. Placement and release gates

- mcv2.1 was placed on a suite internally consistent with a stale contract (Class 1). What placement
  lacked: a cross-tree model-visible parity gate against the incumbent build. Now standing law (#2810):
  placement from a new trunk requires model-visible parity against the build being replaced, in addition
  to (#2817) both package batteries at the exact RC tree, run solo, every release.
- Rollback pair discipline held correctly (previous placement's cache dir untouched, spec backup,
  single-line diff) — keep as-is.
- Kit rule held: a build without field receipts doesn't ship to colleagues.
- Receipt staleness class killed by stamping `tree_id`+head inside every gate log (the same receipt read
  at two different trees burned three debug cycles before the fix).

## 8. Fleet operations

- **Archive overreach, twice**: archived agents beyond the named scope ("you basically erased whole this
  project while didn't touch a single subagent i've talked about"), then workspace cleanup walked into
  `~/.paseo/` state. Recovery worked (prompt-delivery unarchives, memory #2701). Laws: scope is literal
  (#2813); mechanisms own their state directories; anything not covered by the named surface is reported,
  not touched.
- **Enumeration surface**: `paseo_list_agents` is cwd-scoped; the user-visible fleet required sweeping
  every worktree path with the cwd param — a "clean" list meant nothing.
- **Owner-command priority**: "FIX THIS BUILD FIRST, THEN WE WILL INVESTIGATE" — a dispatched diagnostic
  agent working the parked question while the live defect was open was cancelled. Parked work surfaces on
  its condition, never preempts the live order.
- **Kill/restart coordination**: an accidental process kill took a running lane with it; session survived,
  resumed via prompt with an audit-the-interrupted-state instruction. Restarts are owner-owned surfaces.
- **Provider registry shifts mid-day** (model ids vanished twice; "Model not found" dispatch failures):
  re-pin provider/model ids before every dispatch batch; reviewer tier never free tier. Memory #2816.
- **Reviewer-model calibration**: head-to-head on identical briefs only; the control arm (strong solo
  record, zero unique findings across four comparable trials, highest cost) is kept as a trial with a
  contribution gate, not by reputation. Single data points are leads, not findings.

## 9. Environment and data facts

- SQLite `datetime(<bare number>)` treats it as Julian days → silent `2000-01-01` zero-time. Correct form:
  `datetime(ts_ms/1000,'unixepoch','localtime')`. Conclusions that used raw `ts_ms` were unaffected; the
  rendered column lied.
- Environment facts asserted from memory were wrong (DB "12 GB" — actual 478 MB / 190 sessions). Check
  size/state before stating it.
- Config clobber precedent (#2248): never `mv` onto a config path without reading the target; internal
  completion models must stay pinned.
- The reduction-placeholder display artifact (`[dropped §N§]` rendered in place of stamped turns in the
  agent transcript view; ordinals equal to own messages, host-DB parts clean) is a projection artifact,
  distinct from the Class-1 wire-mint defect; record both, fix only the wire one. Conflating them sent
  the first investigation down the DB instead of the code.

## 10. Investigation discipline (process mistakes, same session)

- Claimed "assistant-text stamping" as a finding before evidence; owner corrected the mechanism
  (placeholder replaces tool-call outputs). Standing correction: *not assumptions, facts*; *check the
  code and not guess* — the injection code was readable in one search while DB archaeology was attempted
  first.
- Called a field-caused regression "genuinely novel" when the fork's own sentinel.ts doctrine comment
  predicted exactly this class. Before declaring a defect novel, search the repo's own docs for the
  founding lesson; the point of documenting everything is that it fires at diagnosis time.
- Two stale todo lists and one stale-gate misdiagnosis (marker arithmetic blamed on the gate; the
  coordinator's hash recipe was wrong). Verify the measurement apparatus before trusting or blaming it.

## 11. What worked — carry into the from-scratch build as design constraints

- Two-layer gate (coordinator source verification + adversarial reviewer with named attacks and
  SUSTAINED/PARTIAL/NOT-SUSTAINED verdicts) caught defects at both layers repeatedly; reviewers earned
  their keep on boundary conditions (a law pinning a symbol the next unit deletes → silent rot; a
  comment-only guard on a regex boundary).
- Golden-first sequencing; carriage-only deletion; sever-then-delete with byte-exact relocation pins.
- Red-before-green witnesses, committed; planted rogues as the unit of law quality; production-composition
  over mock composition.
- Bust authority binary: only the window manager (harness/scheduler) decides a cache bust; components
  schedule. This law survived every redesign and is the product's core physics.
- Field receipts before kit; rollback pair before placement; solo batteries at the RC tree.
- Corrections land with explicit provenance markers (coordinator-correction, dated), and dead ends are
  recorded, not deleted.

## Sources

- `docs/plans/v2-delta-census.md` (correction markers, member-1/die-unless rows, stratum-port notes),
  `docs/plans/v2-boot-gate-adjudication.md`, `docs/superpowers/plans/2026-11-05-assembly-v2.md`.
- Merge-gate reports (DeepSeek arms: gap ports, gap-ports-2 N1–N5, strip removal; GLM arms: plan
  validation, Units 0/1/2/6/7 gates) — Paseo agent records.
- Memory: #2824 (single-path + drift contract), #2817 (RC-tree batteries + stratum law), #2812 (dead-code
  strip unit), #2810 (placement parity gate), #2813 (archive scope literal), #2816 (reviewer calibration),
  #2785 (review fence), #2780 (committed witnesses), #2769 (no synchronous batteries), #2701
  (prompt-unarchive), #2248 (config clobber), #2784 (Rust shelved), #2835 (arc design doc surface),
  #2836 (fleet-operation claims need runtime verification).
- Session record: mcv2.1/mcv2.2 placement arcs, gap waves G1–G5/N1–N5, drop-shape restore
  (`feat/v2-drop-shape-restore`).
