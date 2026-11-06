# Differential rendering oracle — mcv2.3 placement gate (ordered by owner 2026-11-06)

**Why:** the v2 program's root defect class (ledger Class 1, baseline inversion) is invisible to every
apparatus built for it: batteries enforce whatever contract the tree pins; parity reviewers diff code and
read a blessed-looking delta as intentional. The only sound oracle for "did the re-assembly stay
field-verified" is the field-verified build itself. This unit builds that gate; mcv2.3 cannot be placed
without it. Memory #2824 is the law; the ledger
(`docs/plans/2026-11-06-v2-defect-ledger.md` Class 1 + 7) is the mistake record it enforces against.

**Owner rulings this unit implements (verbatim):**
- "ONLY m[0,1] placement was allowed to drift since it's the whole point of work"
- "the real gap is the lack of oracle which would test whole rendering path against expected result" (accepted framing: reference = the incumbent, not self)
- "ordered from here: oracle + corpus as its own unit, drop-shape restoration as the first mechanical consequence, both before mcv2.3"

## Contract

Same fixture store + same pinned clock + same opencode harness version, driven by two plugin builds:
**reference** = the field-verified incumbent (assembly lineage = ctxv18), **candidate** = assembly-v2 tip.
The diff is the deliverable.

Verdicts per scenario, on captured wire bytes (not internal state):

1. **Zero diff** → pass.
2. **Declared-drift diff** — confined to the m[0]/m[1] relocation:
   `candidate(region_bytes ∪ volatile_bytes)` equals `reference(m0_block + m1_block)` as rendered content,
   and the message-array bytes outside the system position are equal → pass. This is the ONLY legitimate
   drift.
3. **Anything else** → RED, placement blocked. No manifest, no adjudication ceremony: an undeclared
   diff is a reversion to restore. (First worked example: pre-restore, reference renders
   `[content omitted]` for a message-part drop while candidate renders `[dropped §N§]` → red; the
   drop-shape restore is what makes it pass.)

## Capture design

- **Wire = the outbound provider request bodies.** Both builds POST to one local mock provider endpoint;
  raw bodies are the ground truth — this captures harness-side injection (AGENTS.md, tool schemas) and
  plugin-side transform identically for both, and avoids private-API coupling. Per-request record:
  system text, message array (roles, parts, synthetic flags, file-part presence), tool list.
- **Isolation:** each leg runs in its own bun process under its own temp XDG dirs (`test-preload.ts`
  precedent) against its own copy of the seeded fixture DB; same pinned opencode binary version for both
  legs; reference leg loads the ctxv18 installed bundle (cache dir preserved; rollback-pair discipline),
  candidate leg loads the built dist.
- **Prior art (port, don't invent):** `scripts/audit-transform-wire-parity-live.ts` (+ `.py` twin) in the
  assembly repo already drives live sessions and audits wire parity — start there for the driver, extend
  to mock-endpoint capture.
- **Determinism contract:** pinned clock source; seeded randomness; declared-normalization whitelist
  (session/message ids, timestamps) — every normalization is a named rule in the harness code, and the
  whitelist is pinned by a law (silent normalization addition = red, same census doctrine as Unit 5's
  volatile walker).

## Corpus (shape-coverage census first, then fixtures)

Seeded from the real host DB through the existing golden capture mechanism (Unit 1 corpus: 17 windows +
`seedGoldenStore`) plus synthetic arms for shapes no real window exercises. Every shape in the coverage
census must be triggered by ≥1 scenario; **untriggered shape = red** (prevents a vacuous corpus):

- drop modes × role (user/assistant) × route (full / skeleton_real / message_empty) × lane (plugin / Pi)
- tool-release / FPE placeholder + resolve composition (carrier parity, Unit 8 law family)
- withdraw / stamp states; compaction-off ride; mural/PNG carriage (vision present/absent)
- memory write → volatile segment growth → absorption at scheduler-authorized boundary (the ctxv18
  defect, as an oracle scenario, not only a field receipt)
- region rotation + boot replay; ctx_reduce/ctx_expand wire shapes (Pi stays tag-era — Ruling C is a
  declared drift entry here: Pi ctx_reduce family, citation census ruling C)

## Unit breakdown (lane-dispatchable)

1. **Mock-endpoint capture harness** — port `audit-transform-wire-parity-live.ts`, add mock provider,
   per-leg isolation, determinism contract + normalization whitelist law. Red-first: two runs of the same
   leg byte-diff only through whitelisted fields.
2. **Fixture seeding + clock pinning** — golden-seed reuse, clock injection verified (frozen `Date.now` +
   DB `ts_ms` source), scenario runner (scripted turn sequences incl. folds forced through genuine HARD
   arms — never by calling internals directly).
3. **Reference/candidate dual-leg driver** — both legs, one scenario set; artifacts written to
   `docs/evidence/oracle/<date>-<tree>/`.
4. **Comparator + verdicts** — declared-drift rule for m[0,1] relocation (region ∪ volatile vs base m0+m1
   render), whitelist enforcement, per-scenario verdict table; planted-rogue witness: candidate side
   re-mints `[dropped §N§]` for a message-part drop → exactly that scenario red.
5. **Shape-coverage census** — table (shape → triggering scenario), untriggered = red; committed artifact,
   per-unit lanes must extend it when they add wire shapes.

## Gates and integration

- Oracle runs on every RC tree before placement (extends #2817: batteries + oracle at the exact RC tree,
  solo). A red on any scenario = no placement; fix the candidate or (only by owner ruling) extend the
  declared-drift list with a citation to the ruling that authorized it.
- Same harness becomes the standing gate for future wire-format stratum ports (the #2817 Pi lesson: every
  consumer lane re-pinned in the same commit; the oracle is now the mechanical check that they were).
- Receipts: evidence dir + tree_id inside the run record (mc-gate recipe); coordinator recomputes.

## Sequencing

Drop-shape restore merges first (it is the oracle's first adjudication — its green is the unit's own
acceptance test #2/#3 evidence). Then this unit ships; first full oracle run happens at the combined tip;
zero unexpected diffs + batteries green at the same RC tree → mcv2.3 placement.
