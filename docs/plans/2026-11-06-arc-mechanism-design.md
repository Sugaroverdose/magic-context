# Arc mechanism design — invizipburu v2 (history segmentation, closure verdicts, recall)

**Status:** adjudicated design, not started. Queued on the assembly-v2 product line behind the
differential-oracle units and mcv2.3 (queue order in `2026-11-05-assembly-v2.md`). This document is
the authoritative design record; before 2026-11-06 the decisions lived only in a coordinator's
session notes, which are invisible to reviewer agents and other models — the owner ruled that
half-hidden design decisions cannot be validated by other models, so the full design moves to the
document surface (this file) in the same pass as the candidate rulings.

**Scope.** Replace purely budget-driven history segmentation with semantic *arcs* judged by the
historian, while keeping the mechanical fold machinery as the guaranteed floor; add the store-side
memory (arc ledger, recall tool, translator index) that lets a stateless historian reason about
what it already covered. Three apply sites share one verdict object: head folds (cut-point choice),
mid-window dead-arc folds (opportunistic), and offline consolidation (the librarian).

## Investigation (how the design was reached)

- **Question (2026-11-05).** Mid-window compaction is strict FIFO: no mechanism can fold a
  finished *span* before the head boundary reaches it. Store census on a live session showed ~78%
  of live-tail tool bytes were finished-arc mass (one 45 KB `list_models` dump = 64% of the tail,
  consumed once hours earlier, never stampable because the closure evidence was never
  self-reported). Exhibit: two identical dumps where positional protection *inverted* liveness —
  the older copy already dropped, the newer deader one still active.
- **Population correction (owner).** "Not typical — almost all sessions in this project are like
  that." Marathon forensic sessions are the modal workload, so dead-arc mass is systematic. The
  same population revisits old content (82% of `ctx_expand` restores came from three forensic
  sessions), so false-positive "finished" verdicts hurt most exactly where foldable mass is
  largest — acceptance gates must be tuned on this population, not casual sessions.
- **Scope extension (owner).** "Arc detection works beyond that feature, history also can have
  arcs (semantical blocks) instead of compartments (mechanical blocks)" — arcs as the segmentation
  unit for all of history, not just a mid-window folder. Compartment titles/calibration seeds
  inherit the seams of budget-cut boundaries; one arc gets severed across two blocks, one block
  welds two stories.
- **Rejection of arc-only replacement (owner, load-bearing).** "Arc can have proper summary only if
  it's folded, that's why arc-only mechanism cannot fully replace compartments… best approach i
  assuming is mixed compartment+arc summaries." The summary is downstream of the fold: nothing
  certifies an unfolded span's completeness, so a summary of a live arc is a lie about its end.
  Three mechanisms, non-substitutable: compartments (fold artifact; summary earned by folding),
  arcs (segmentation + closure verdicts, *not* a summary lane), LKG message compression (the only
  candidate to *replace* summary bytes — admitted only at equal-or-better model-perspective
  fidelity; current test data fails at the smallest rung, so compression stays in drop-shape land).
- **Statelessness gap (owner).** "Historian works with a limited scope, e.g. it does not know what
  messages were summarised earlier and what arcs has been assigned" — plus a gap the feature itself
  creates: once mid-window folds land, future windows contain sealed summary *islands* the
  historian would re-narrate (compaction-of-compaction through the back door).
- **Recall-tool alternative (owner).** "In theory we can just add some kind of recall tool for
  historian to look at compartment summaries and just attach following messages to exact the same
  arc if they does looks like continuation" — resolved as ledger + index + depth tool (ruling 7),
  not prompt pre-baking.
- **Pending-merge idea (owner).** Unapplied same-arc compartments may be re-summarized wider before
  the boundary moves (ruling 7(e)); the pre-applied/post-applied divide is the whole law —
  unapplied bytes are deliberation, applied bytes are history.
- **Librarian reframing (owner).** "If historians with recall mechanism could actually track
  continuity, 'dreamer' (let's call him librarian) could just get all of the detected compartments
  at once and make summary for them" — the consolidation agent is a compiler, not a detective:
  continuity is judged once at fold time with full context; the librarian compiles ledger trees
  offline (ruling 8).
- **Two-anchor representation (owner, 2026-11-06).** Long arcs need visible extent in history: a
  start stamp + an end summary with cardinals (candidate 9). Rationale for the start stamp, owner
  verbatim: users recall by position — "right before we started X" — so the stamp is a temporal
  landmark resolving that phrasing.
- **User-model translator (owner, 2026-11-06).** "User cannot reproduce its own request, especially
  if it's a couple of days ahead — it's to expand user speech habits into wider search window
  instead of leaving model guessing" (candidate 10). Model-side alias guessing is structurally
  bootstrapped: guessing the right alias requires already knowing the answer.

## Settled rulings

1. **Arc detection = historian verdicts.** Scripts are unreliable for liveness; "finished" is a
   model judgement — but a *structured, evidence-cited* one (see 2).
2. **Verdict/summary separation.** Two artifacts, two instruments, no blending. Verdict:
   structured, mechanically verified (server verifies consumption citations, `skipped_operations`
   shape, reason-coded rejects). Summary: prose, quality-gated independently by the
   fidelity-gradient instrument at model perspective.
3. **Mixed design (load-bearing).** Arc-only cannot replace mechanical compartments — a proper
   summary exists only after the fold. Compartments + historian summaries stay primary. Arcs add:
   (a) arc-aware cut-point selection for head folds — the budget becomes a *chooser among legal arc
   ends*, never a creator of one; an arc longer than budget gets a documented partial end, never a
   mid-sentence weld; (b) in-place assistant summary blocks for mid-window dead-arc folds —
   OPPORTUNISTIC EARLY PATH only (see 8). The mechanical floor always exists: malformed partition,
   missing arc ends, raw-bound validator failures, timeouts, or emergency-band passes fall to the
   budget cut, receipted with a reason code. Arc membership freezes at apply; boot replays stored
   compartments, never re-segments. Contiguity survives: arcs are contiguous ranges; interleaved
   parallel investigations are ruled a single multi-thread arc (non-contiguous ranges deferred).
4. **LKG compression as summary replacement: gate, not architecture.** Admission bar =
   equal-or-better on the model-perspective fidelity test vs the historian-summary arm at matched
   budget. Current data fails at the smallest rung → compression stays on drop-shape carriers only.
   If future compression clears the bar by evidence, it displaces the summary lane then.
5. **LKG slots never carry compaction rewrites.** The slot is the constitutional witness of served
   bytes (boot-is-replay depends on it). Any representation choice is frozen at capture, never a
   serve-time transform.
6. **Boundaries are the only apply moment.** Mid-window folds ride existing boundaries only (the
   12.7× law — model-authored folds never originate a rotation). Acceptance = arc-fold regret ≈ 0
   on the forensic-population sessions (the modal workload).
7. **Statelessness fix = arc ledger + recall tool.** The model stays stateless; the store carries
   the memory.
   - (a) **Ledger** is store-side authority: one row per arc — id, span bounds, status
     (`pending|open|closed|folded`), title, owning compartment, `parent_arc`. Written mechanically
     at apply. A compact structural index (ids/bounds/titles only, budget-constant) is injected
     into every historian pass — the recovery-locality law: a model can't query what it doesn't
     know exists, so the index is mandatory and the tool provides depth only on demand.
   - (b) **Recall tool** (owner-proposed): read-only historian tool to read prior compartment/arc
     summaries; used for continuation confirmation and consumption citations. Judgement-only — the
     serve path never calls it; boot-is-replay untouched.
   - (c) **Immutability.** Applied (served) arcs and compartments are sealed. Continuation may
     attach only to closed-but-unfolded arcs. A post-apply continuation becomes a NEW arc with a
     `parent_arc` reference — append-only wire semantics, no rewriting served islands. The
     parent-chain *component* is the librarian's grouping key.
   - (d) **Window-edge law.** An arc whose proposed end is the window's last rows can only be
     verdicted `open` — closure requires the *next* pass to cite post-span consumption (the one
     piece of evidence this pass cannot have). Server-side rejections, reason-coded, planted-rogue
     censused: overlap-with-ledger-closed, edge-closure.
   - (e) **Pending-compartment merge.** Same-arc unapplied adjacent compartments merge into one
     wider summary before the boundary moves — free (never served, zero cache cost). Merge is a
     historian judgement citing the ledger (same arc, adjacent spans, both pending); the server
     applies only if mechanical checks pass, otherwise originals apply unmerged, never blocking the
     boundary. Merge before validation (raw-bound validator sees final bytes). Receipt: source
     compartment ids, arc id, byte delta.
8. **Lifecycle — the librarian is a compiler.** (Owner name for the dreamer-like consolidation
   agent.) Historian carries *all* judgement (segmentation, closure verdicts, continuity chaining
   via recall at fold time). The librarian carries *zero* judgement: group sealed compartments by
   parent-chain component in the ledger → one summary pass per arc tree → emit a scheduled
   replacement (pending_ops family) riding existing boundaries, landing once, frozen at apply. It
   never touches live data; being offline it can afford recall depth and a larger model.
   **Eligibility (mechanical):** verdict closed + every compartment in the tree sealed + newest
   child quiet for a horizon measured in pass count (deterministic under replay), not wall clock.
   **Invalidation:** a new child attaching before land cancels the schedule, the arc reopens, the
   librarian recompiles later — only never-served bytes can change (withdraw-lane precedent).
   Replacing applied compartment blocks is the **pre-authorized exception** to the
   no-compaction-of-compaction law — structurally the rotation exception; fenced by planted-rogue
   census (only scheduled rows from the librarian, only mechanically validated, never a live-pass
   rewrite). Underlying raws stay in the store: a wrong merge is restorable and
   counterfactual-testable; worst failure = degraded narrative.

## Design candidates (owner-proposed 2026-11-06, open questions ruled)

9. **Two-anchor arc representation.** A long arc renders in history as a pair, atomically:
   - **Start stamp** — a real history MESSAGE (wire-visible), a one-line summarization stamping
     where the arc started. Purpose: temporal landmark for user recall — "right before we started
     X" resolves to the stamp, and its neighbors are what the user means. Title carries the USER's
     phrasing for the topic (same findability law as librarian summaries: user vocabulary, not just
     the historian's). Written at fold time as part of the fold artifact — before the fold the raws
     are in-window and no landmark is needed.
   - **End anchor** — summary + message cardinals. Cardinals drive the model's recovery economics:
     they decide whether `ctx_expand(start..end)` is worth paying before paying it.
   - Inherited laws: indivisibility (stamp + summary + elided span are one artifact — partial
     application mechanically impossible, same law as step-pair indivisibility); anchors bind
     minted ordinals, never array positions; an arc older than the applied boundary degrades to
     "began pre-window" + cardinals; the stamp's title re-render at seal (start-time title is a
     guess, end-time title is verdict-quality) rides the librarian's fold-artifact-replacement
     exception — land-once, cancellable, receipted.
10. **User-model translator (semantic recall index).** The user cannot reproduce their own request,
    especially days later; the translator expands user *speech habits* into a wider search window
    instead of leaving the model to guess aliases.
    - **Product = the habit, not the pair.** A single (user phrase → term) pair is evidence;
      promotion to an expansion rule requires repetition across episodes (frequency = confidence).
      Per-episode validity keeps a mechanical floor: the recovered artifact was cited in the
      model's next turn; user re-attempt within k turns demotes the pair.
    - **Consumer = the search pipeline at query time:** user text → translator widens into variants
      → fused search. The model never guesses the bridge.
    - **Durability asymmetry:** the phrase↔term mapping is the durable row (idiolect is stable over
      months); artifact pointers (arc/compartment/ordinal) are a cache that may go stale and
      re-derive (artifacts fold, tombstone, re-arc). Entries hold keywords + pointers only, never
      content — content copies go stale silently.
    - **Mining source law:** pairs key on the user's VERBATIM recall message, never the model's
      reformulation of it. Coverage builds where the model fails (steps-to-success > 1); episodes
      the model guessed first-try yield no pair, correctly.
    - **Authority shape:** historian-specific tools, no new authority lane — `check-exists` (prior
      records for a phrase visible before write; dedupe is judgement-assisted) + `write-pair`
      (server validates mechanically: schema, pointer liveness, tombstone state). Same pattern as
      the recall tool: judgement in the historian pass, server validation only. Invalidity hooks the
      ledger tombstone/withdraw plumbing.
    - **Findability law (shared with 9):** librarian summaries and arc start stamps must contain
      the vocabulary users recall with — findability joins preservation as a fidelity-gradient
      sub-metric.
    - **Fence:** the index feeds the searches that generate new pairs — every evaluation uses a
      train/holdout split by episode time, or the instrument measures its own echoes.
11. **Pre-lane probe — fourth arm.** Alongside the three-arm census (tail dead-arc mass;
    drop-then-restore counterfactual harm; compartment coherence / merge-arcs-below share): an
    offline recall-episode census over the session archive — episode count, steps-to-success
    distribution, would-a-learned-alias-have-shortcut-it share, and the repetition histogram
    (phrases recurring across ≥2 episodes = the promotable-habit population). If the histogram is
    thin, the translator starves and the probe must say so before any lane is built.

## Validation contract (for reviewer agents on any model)

Every ruling must be checkable against the repo at the lane tip without session context:

- Rulings 1–3: verdict schema tests — server rejects uncited closure claims, overlap-with-closed,
  edge-closures (reason-coded, planted-rogue witnesses committed). Mechanical-floor tests: every
  fall-to-budget path (malformed partition, timeout, emergency band) produces a receipted cut.
- Rulings 4–5: LKG slot laws — no compaction rewrite ever enters a slot (slot equals last served
  bytes); compressed rungs absent from summary paths.
- Ruling 6: no model-originated rotation — boundary-count law under fold passes (12.7× census).
- Ruling 7: ledger write-side laws (mechanical apply-time writes only), index injection budget law,
  recall tool read-only (no-writes census), immutability census (no rewrite of served islands),
  pending-merge adjacency checks + merge-before-validation order law.
- Ruling 8: librarian has zero judgement surface (no ledger mutation); eligibility/invalidation
  laws deterministic under replay (pass-count horizon); pre-authorized exception fenced by
  planted-rogue census in the rotation-reasons shape.
- Candidates 9–10: indivisibility law for the anchor pair (partial apply mechanically impossible);
  cardinal presence; verbatim-source mining law; promotion-by-repetition threshold law;
  holdout-split requirement in any translator evaluation artifact.

## Prior art (recovered to documented surfaces, 2026-11-06)

- **Recovery-locality law** (basis of ruling 7(a)): *a model can't query what it doesn't know
  exist.* Retrieval mediated by a habit the model must independently recall is the failure class;
  the shape that survives is a two-layer contract — the addressable space is injected (compact,
  budget-constant structural index), depth is paid only on demand (read-only tool).
- **sqz counterexample** (the cautionary arm, adjudicated 2026-11-03, fully documented in the
  harness-ai-exploration research repo, `docs/research/output-guard-repetition-collapse-2026-11-03.md`):
  a transparent OpenCode TS plugin + MCP (675 stars, Rust, Apache-2.0 — the survey's "MIT" was
  refuted at the API) that does capture-site command rewriting with originals in its own SQLite.
  Its recovery path is model-parsed ref tokens on the MAIN path — its own README records GLM 5.1
  looping on the refs, mitigated by four env escape hatches. That is recovery-locality violated:
  the model must know and reproduce opaque tokens. The arc design's ledger-index-injected +
  tool-depth-on-demand split is the direct answer to this counterexample. Harvested from the same
  adjudication: exception-path-not-main-path (reveal-call-rate ≈ 0 as acceptance gate) is the same
  acceptance shape as ruling 6's regret ≈ 0.
- **invizipburu name law** (owner-coined, pinned as the project's name 2026-11-05): "invisible
  zip" = the recovery-locality contract in one word — the *archive* property (originals always
  recoverable, exact — hence ruling 8's "raws stay in the store") plus the *invisibility* property
  (the model reads through builder-emitted markers like any text, never trained to invoke the
  recovery path; reveal is the exception and its rate ≈ 0 is the acceptance gate). Ruling 9's
  start/end stamps and the drop-shape family are invisibility-property artifacts.
- **Operating map rows** reused as mechanisms: "merge arcs below 10%" became ruling 7(e);
  "historian as the competitor" to the positional sweeper motivates the counterfactual-harm probe
  arm. These originated in a coordinator session record (not a doc); their operative content is
  restated in this file, so the doc is self-sufficient for validation.
- withdraw-lane cancellable-pending pattern (ruling 8 invalidation); rotation-exception fence
  precedent (ruling 8's pre-authorized exception); Compact-Bench retention gradient (external
  claim, quoted as its authors' unverified numbers).

## Sources

- Owner rulings and verbatim quotes: session dialogue 2026-11-05 (arc design thread) and
  2026-11-06 (two-anchor + translator proposals), quoted above with the recorder's context; full
  sequence in the coordinator's session record (compartments "arc-detection mechanism", "settled
  arc mechanism design"). The session record is provenance, not authority — this file is the
  authority.
- Store census evidence (2026-11-05): live-tail composition of the coordinator's own session —
  78% finished-arc mass, duplicate-dump liveness-inversion exhibit, 82%-of-restores telemetry.
  Reproducible against the context store (`tool_tag` per-tag bytes vs applied boundary) before any
  lane.
- Related documents: `docs/plans/2026-11-06-v2-defect-ledger.md` (mistake classes this design must
  not reintroduce), `docs/superpowers/plans/2026-11-06-differential-oracle.md` (placement gate
  preceding this work), `docs/plans/v2-delta-census.md` (disposition census),
  `docs/research/output-guard-repetition-collapse-2026-11-03.md` (cross-repo: harness-ai-exploration
  research repo — sqz adjudication).
