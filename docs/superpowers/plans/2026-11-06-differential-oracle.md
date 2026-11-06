# Differential rendering oracle — mcv2.3 placement gate (ordered by owner 2026-11-06)

**Why:** the v2 program's root defect class (ledger Class 1, baseline inversion) is invisible to every
apparatus built for it: batteries enforce whatever contract the tree pins; parity reviewers diff code and
read a blessed-looking delta as intentional. The only sound oracle for "did the rewrite stay faithful to
the field-verified build" is the field-verified build itself. This unit builds that gate; mcv2.3 cannot be
placed without it. Memory #2824 is the law; the ledger (`docs/plans/2026-11-06-v2-defect-ledger.md`
Class 1 + 7) is the mistake record it enforces against.

**Owner rulings this unit implements (verbatim):**
- "ONLY m[0,1] placement was allowed to drift since it's the whole point of work"
- "the real gap is the lack of oracle which would test whole rendering path against expected result"
- "ordered from here: oracle + corpus as its own unit, drop-shape restoration as the first mechanical consequence, both before mcv2.3"

**DeepSeek plan validation (2026-11-06, agent 20aae840, rev f13b6509d): 2/7 caught, four design
defects; all load-bearing claims coordinator-verified at source before amending (prior-art false, M1
placeholder, mural part-flag, OC1-only lane, stale Ruling C — all confirmed).** The pre-amendment
version is superseded; its verdicts are folded into the text below at the points they bind.

## Lane declaration (validation B4 — added)

- **OC1-TS only.** The frozen region lane is an OpenCode-1-TS capability; the OC2 lane keeps serving
  synthetic heads (`packages/plugin/src/v2/server.ts:52-53`). The oracle runs the OC1 harness
  (`opencode-runner/spawn.ts`, plugin via `MC_E2E_PLUGIN_ENTRY`).
- **The OC1 host binary is pinned** — recorded binary hash in the run manifest (the OC1 runner spawns
  `opencode` from PATH; unlike OC2's `cli-resolution.ts` it is unpinned by default). "Same harness for
  both legs" means the same recorded hash, enforced.
- Pi lane is a separate, second-phase leg (`pi-harness.ts` + `MC_E2E_PI_PLUGIN_ROOT` +
  `MC_E2E_PI_VERSION`) — achievable, not aspirational, but not the first build.

## Contract

Same fixture store, same pinned clock, same pinned OC1 host, two plugin builds:
**reference** = field-verified incumbent (ctxv18 bundle, present at
`~/.cache/opencode/packages/@cortexkit/opencode-magic-context@0.45.0-ctxv18/`),
**candidate** = assembly-v2 tip dist. Both legs boot **sequentially on one shared store and cwd**
(the `session-api-cutover.test.ts` existingIsolation pattern) so cwd, project identity
(`git:<root-commit>` keyed golden windows), and paths are identical by construction.

Verdicts per scenario, on captured wire bytes (not internal state):

1. **Zero diff** → pass.
2. **Declared-drift** — confined to the m[0,1] relocation, with the comparator rules made exact
   (validation B3, all coordinator-verified):
   - `region ∪ volatile` is **ordered with a defined seam**: comparator reconstructs the reference
     system block as `region_text + "\n\n" + volatile_text` in serve order; unordered multiset matching
     is forbidden.
   - **Reference empty-m1 placeholder normalizes to empty**: reference bakes
     `M1_EMPTY_PLACEHOLDER = "<session-history-since>(no new content since last
     materialization)</session-history-since>"` into the region at quiescence (base
     `inject-compartments.ts:1174,2844`) while the candidate's volatile is `""`; this is a declared
     named normalization, not silent.
   - **The mural message belongs to the region position**: the candidate's separate synthetic
     user message at index 0 (region-render `buildRegionMuralMessage`) is compared against the
     reference's synthetic file part on the m0 message as a declared transport divergence; its bytes,
     ordering, and part-level flags are still verified — exclusion never means unverified.
   - **Watermark-refused volatile = error verdict**, not empty.
   Anything outside this set → RED, placement blocked. No manifest, no adjudication ceremony.
3. There is **exactly one declared drift class** (m[0,1] relocation incl. its mural transport). The
   previously listed "Pi tag-era" drift is **deleted as stale** — N3 restored `ctx_handles` on Pi;
   Ruling C is superseded (census `:410`).

## Capture design

- **Wire = outbound provider request bodies** at the existing mock provider
  (`packages/e2e-tests/src/mock-provider/server.ts` — captures `rawBody` + parsed
  system/messages/tools). Model-visible content only: `synthetic` flags are plugin-internal (host
  filters on `ignored`) — structural fields come from the draft probe (`outbound-shape-probe.ts`),
  recorded separately, not claimed as wire bytes.
- **Request classifier + request-set comparison**: main-agent vs title vs historian vs dreamer vs
  embedding requests are tagged (reuse `mock-routing.ts` `pinMockAgents` /
  `assertHistorianMockRouting`); the compared artifact is the request **sequence**, not just per-request
  bytes — a title-generation delta caused by a part-flag change is a finding, not noise.
- **Internal completions disabled or scripted** on both legs (`memory.enabled=false`,
  `historian.disable=true`, `dreamer.disable=true` — the `oc2-wire-dump.ts` precedent); any scenario
  that needs them names them.
- **Determinism contract (validation B2 — cross-process, not in-process):** the in-process
  `Date.now` pin used by golden capture does not reach a spawned `opencode serve`; the runner injects
  a plugin wrapper freezing `Date.now` + TZ and pinning "Today's date"/cwd (port the
  `idle-ttl-restart.test.ts:876` system-transform wrapper), plus seeded randomness. Normalization
  whitelist: ids/timestamps only, each rule named, pinned by a law — silent whitelist addition = red.
  **The determinism self-test (same leg twice, byte-identical modulo whitelist) ships FIRST and gates
  everything after it.**

## Prior art (corrected — validation C)

The earlier draft claimed `scripts/audit-transform-wire-parity-live.ts` "drives live sessions" — false;
it is a read-only live-DB probe (+`.py` summarizer). Not ported. Port instead, all verified present:
`mock-provider/server.ts`, `harness.ts` + `opencode-runner/spawn.ts` (OC1), `pi-harness.ts` +
`pi-runner/spawn.ts` (phase 2), `oc2-wire-dump.ts` (driver skeleton), `paired-session-replay.ts`
(`first_diff_byte`, block-shape diff), `outbound-shape-probe.ts`, `session-api-cutover.test.ts`
(same-store dual-boot).

## Corpus (shape-coverage census first, then fixtures)

Shape vocabulary is the **live v2 union** — `drop_mode × role × route` from
`packages/plugin/src/features/magic-context/types.ts:22-44` (`erased`, `truncated`, `skeleton_stripped`,
`skeleton_real`, `edit_marker`, `edit_marker_stripped`, …), NOT the ledger's corrected 3-shape framing;
**message-part drops and tool-part drops are distinct shapes** (validation A2).

Coverage rows (each with a named capture predicate + a planted rogue that reddens if the predicate lies —
committed witnesses, ledger Class 6; untriggered shape = red):

- message-part drop × route (the `[content omitted]` acceptance) and tool-part drop × route (carrier)
- tool-release / FPE carrier + resolve composition; mint-without-resolve rogue (Unit 8 family extended)
- **boot with persisted usage above the execute/emergency threshold** (G1 replay — validation A3)
- **reclaim pass driven into the execute band, stop-line visible** (G2 — A4; reference stops 15pp below
  band, candidate runs to watermark → diff)
- **subagent session** exercising the `isSubagent`-gated execute reclaim ride (G3 — A5)
- **tag-shaped assistant text persisted, then replayed** next turn and via `ctx_expand` (N1 — A6)
- **Pi three-arm sweeper × provenance** (N2 — A7; phase-2 Pi leg)
- withdraw / stamp states; compaction-off ride; mural/PNG (incl. the part-flag rule below)
- memory write → volatile growth → absorption at scheduler-authorized boundary
- region rotation + boot replay

Real-host windows stay in the in-process golden (`region-golden-replay.test.ts`); the oracle corpus uses
the seeded fixture windows + synthetic arms (identity/ordinal rewrite cost rejected per validation C).

## Unit breakdown (re-sequenced per validation)

1. **Determinism self-test first** — spawn OC1 leg, clock/TZ/date/cwd freeze wrapper, internals off,
   same leg twice byte-identical modulo the named whitelist; whitelist law with silent-addition rogue.
2. **Mock-endpoint wiring + request classifier + request-set comparison** (port the e2e machinery above).
3. **Dual-leg driver** — shared store/cwd sequential boots, reference = ctxv18 bundle via
   `MC_E2E_PLUGIN_ENTRY`, candidate = v2 dist; host binary hash pinned in the manifest.
4. **Comparator + exact declared-drift rules** — M1 placeholder normalization, mural transport rule,
   ordered union seam, watermark-refusal = error; planted rogues: drop re-mint, prefix re-add,
   mural-flag flip.
5. **Corpus + shape-coverage census** — live-union vocabulary, per-shape predicates + rogues, rows above.
6. **(phase 2) Pi leg** via `pi-harness.ts`.

## Field-caught defect this review produced (production fix, not oracle)

Candidate's mural file part **lacks the part-level `synthetic: true`** where the reference has it
(candidate `region-render.ts:1141` vs base `inject-compartments.ts:3469`, whose comment ties the flag to
phantom-user-turn/title-suppression avoidance, issue #129) — a Class 1 wire-shape deviation. Restored
byte-faithful to base before mcv2.3; it also becomes the oracle's first live catch (mural-flag rogue
arm).

## Gates and integration

- Oracle runs on every RC tree before placement (#2817 extended: batteries + oracle at the exact RC
  tree, solo). Red on any scenario = no placement; fix the candidate, or (owner ruling only) extend the
  declared-drift set with the ruling's citation.
- Standing gate for future wire-format stratum ports (the #2817 lesson, now mechanically checked).
- Receipts: evidence dir + tree_id inside the run record (mc-gate recipe); coordinator recomputes.

## Sequencing

Drop-shape restore merges first (its green is unit 4's acceptance evidence). Mural part-flag fix joins
the same merge train. Then this unit ships in the order above; first full run at the combined tip;
zero unexpected diffs + batteries green at the same RC tree → mcv2.3 placement.
