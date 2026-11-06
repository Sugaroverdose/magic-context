# v2 boot-gate adjudication (Unit 0, assembly-v2 plan Step 3)

Scope: rule which boot-fold prohibitions in assembly's `restore-only-boot-pass.ts`
("rust-lane restore-only boot law, TS-lane port") remain **physical law** headless —
without the synthetic head — and which are **head-era** and die. Delivers the boot law as
a v2 test: `packages/plugin/src/hooks/magic-context/region-boot-law.test.ts`
(2 tests, green on v2 as-is — no production code changed by this unit).

All greps/reads/tests below were run by this agent on 2026-11-05 against
`assembly@9c1520810` (the current tip; `dcd769d6f` located by this agent during rev
verification — coordinator correction 2026-11-05: the dispatch brief cited only the seed tip
`d31586f83`, verified an ancestor, and the
restore-only surface is unchanged between them — anchors re-verified at the tip) and
`v2@d31586f83` (revs `git rev-parse`-verified; `2f67a75f4`, an invalid object that appeared in
this agent's working notes — coordinator correction: never in the dispatch brief), unless a
claim is explicitly labeled `[assembly-doc]` (recorded in
assembly comments; not re-measured here) or `[reasoned]` (grounded in cited source, not
directly exercised).

## The question

Assembly gates wire mutations on boot with a detector: a pass that entered the process
without provider usage (`contextUsage.inputTokens <= 0` + persisted `lastResponseTime === 0`,
kill-switchable) is "restore-only". `[assembly-doc]` motivation (file docstring): the Rust
lane pins first-pass contract; `defect-4` — healthy sessions booted `dec=execute
reason=ttl_idle` — idle expiry is true by construction at boot and the host post-restart
replay raises the materialization flush; both boot artifacts must not become wire-mutation
permits.

## Evidence read — assembly side

- `restore-only-boot-pass.ts` (69 lines, read in full).
- Uses, `transform-postprocess-phase.ts` (grep re-anchored at `9c1520810`): import :151;
  computation :1855; flush-clear at pass start :1907; cacheExpired fold arms :2181/:2185;
  drain/flush/heuristic lane gates :2206, :2221, :2241, :2252.
- Laws: `transform-postprocess-phase.test.ts:9400` `describe("restore-only boot pass
  (rust-law port)")`, test-side toggle import :81.

## Evidence read — v2 side (the boot surface, no detector)

- Region replay entry: `inject-compartments.ts:4008` `prepareCachedM0M1Replay` — sentinel
  region row + lane ⇒ returns `decision {value:false, reason:"cache_hit"}`,
  `m0RematerializedThisPass:false`, **no** `prependM0M1Messages` call, no m[1]
  (:4028-4034). Region bytes are a pure function of store state (design global constraint),
  so a re-render of an unchanged store is byte-identical. `[verified by test]`
- Idle fold witness: `mustMaterialize` region mode reuses the head-era arm
  `inject-compartments.ts:1918-1924` — `ttl_idle` fires only when
  `lastResponseTime > cachedM0MaterializedAt` (self-consuming; the fold that lands writes
  materialized_at newer than the response clock). `[verified by test]`
- Scheduler boot truth: `scheduler.ts:67` defers brand-new (usage 0, clock 0); `:114-117`
  boots a restored session `execute` on the persisted idle clock — the exact
  `[assembly-doc]` defect-4 census shape. `[verified by test]`
- Hash watcher: `system-prompt-hash.ts:518-523` the watched hash covers **host content
  only** (region appended after all H mutations :490-505, never hashed); the three-set flush
  add fires only on a genuine H-hash change :535-549. The comment at :420-425
  ("an aborted attempt prepared its frozen head") names head-era machinery as the historical
  flush-artifact source.
- LKG: slots are durable across restart (`lkg-slot.ts:45,521-535`
  `lkg_hydrated_from_disk`), replay wrapper `messages-transform.ts:218-245`;
  `lkg-replay.ts:778,847` handle the after-restart capture contract explicitly.
- Rotation comparator: `system-region.ts:306-335` (`bustPermission` gate first arm) and
  `transform-postprocess-phase.ts:1752-1781` (`regionRotationPromotion` declines without
  boundary permission) — ride-only, L4.

## Ruling

### Physical law headless — survives, structural (no detector)

- **P1 — replay-first.** Boot serves stored bytes verbatim; boot identity is the frozen
  system channel + appended region decoded from the reopened row (`system-prompt-hash.ts:500-504`),
  byte-identical across a store reopen (#2622). Pinned: law test, receipt 1-2 + byte witness.
- **P2 — fold needs the witness.** The `ttl_idle` fold arm requires
  `lastResponseTime > cachedM0MaterializedAt`; an idle-restored boot does not fold even
  though the scheduler boots it `execute` and `cacheExpired` is true by construction.
  Pinned: receipt 4 + armed control (moving both landmarks re-fires the fold — the witness
  is live, not absent).
- **P3 — rotation is ride-only.** No rotation originates a bust; a quiescent boot with
  boundary permission present (scheduler execute) rotates zero times because the production
  marker comparison says so. Pinned: receipt 5 + two-sided controls (comparator bite on an
  edited docs file; boot-gate bite on stale manifest without permission).
- **P4 — genuine content folds stay legal at boot.** Model/system-hash/upgrade/epoch/mutation
  arms (:1868-1897, :1940+) may fold on a boot pass — assembly's own law conceded
  content-change folds ("mustMaterialize fires off baseline bytes that drifted while the
  process was down"). The provider cache is dead post-idle anyway; a region fold re-rendering
  an unchanged store is wire-neutral `[reasoned from P1 purity + the TTL clock]`.

### Head-era — dies

- **H1 the detector itself** (`isRestoreOnlyBootPass` + kill-switch). Its subject was the
  head-era bust ledger: usage-unknown passes must not re-price the cached prefix once the
  host re-anchors heads after restart; the census it distrusted (`dec=execute
  reason=ttl_idle`) was a head-era fold-permission signal. Headless there is no head
  carriage to protect: P1-P3 make the boot pass replay-only by construction, and the
  usage-unknown reading no longer marks any byte authority. Dies; no v2 port.
- **H2 the pass-start flush-clear** (:1907). The flush it discharges came from the
  host-replay-vs-frozen-head interaction (`system-prompt-hash.ts:420-425` comment is the
  artifact's own record). The v2 watcher raises flush only on a genuine H change, which is a
  content event (P4). Dies.
- **H3 the lane gates** (:2206/:2221/:2241/:2252). These gated drop-drain, heuristic, and
  flush lanes on `!restoreOnlyBootPass` because a boot bust was unpriced. In v2 the same
  lanes consult the single boundary-permission mechanism (P3) and the fold receipt
  (`foldExecutedThisPass`); a second veto would be the double-gate defect the ALF split-bust
  lesson forbids. Die.
- **H4 `seedPersistedUsageAtBoot`** (`transform-context-state.ts` BOOT +36). Boot seeding of the
  persisted provider usage, feeding the first priced pass after a restart; dies with H1. Re-enters
  only via a named headless law that needs a pass-level usage reading (none today — census rows for
  both files marked U0/dies). [Correction 2026-11-06, G1 port: the BOOT +36 hunk is commit 10a2de631
  adding `seedPersistedUsageAtBoot` + `canonicalizeModelKeyForUsageSeed`, not
  `contextUsagePassSnapshot` — that symbol is unchanged in the hunk and appeared here only as the
  git context line above the insertion. Re-entered as the G1 port on feat/v2-gap-ports: the boot
  path seeds from the persisted provider record before the wire-estimate fallback, laws ported
  verbatim into `transform-context-state.test.ts`.]
- **H5 the Rust-lane provenance** (`lib.rs` first-pass pinning, per the port docstring).
  Rust is out-of-contract (governance: named boot refusal); dies as a port. If the Rust lane
  returns, it owns its own boot contract. `[reasoned]` for the lane itself; the exclusion
  source is #2704/#2735.

## The boot law (v2)

`packages/plugin/src/hooks/magic-context/region-boot-law.test.ts` — reproduces the
defect-4 receipt shape in region-era `InjectM0M1Result` vocabulary:

1. **quiescent boot**: fresh handler + reopened temp store (system-region-serve.test.ts:93-125
   pattern) after a production rotation install → `prepareCachedM0M1Replay` answers
   `{injected:true, m0RematerializedThisPass:false, decision:{value:false,
   reason:"cache_hit"}}`, no head/m[1] carriage; region bytes + `cached_m0_materialized_at`
   unmoved; scheduler (production) says `defer`; `regionRotationPromotion` on the
   production composition (`currentRegionMarkersForPromotion` +
   `snapshotMarkersFromCachedM0`, #2710/#2715) declines. Controls: warm-boundary docs edit
   rotates (`project_docs_hash`), same edit without permission does not.
2. **idle-restored boot**: persisted pre-restart clock past TTL → scheduler boots `execute`,
   `cacheExpired` true — replay receipts still hold, zero rotations, witness holds; control
   moves the landmarks and the `ttl_idle` fold re-arms.

Header discloses the spec §10 pass-level gap: the law drives named production entries, not
the full `runPostTransformPhase` pass. Pass-level boot wiring is what Units 1-5 re-assemble;
this law is the boot-floor contract they must preserve.

Gate: `mc-gate scoped` → `pass=2 fail=0` (log
`~/.local/state/mc-test-gate/logs/20261105-014823-87852-scoped-plugin.log`). `[agent-run]`

## Consequences for later units

- Unit 1 must **not** port the restore-only lane: the BOOT-stratum hunks in
  `transform.ts`, `transform-postprocess-phase.ts`, `transform-context-state.ts` (census U0
  rows) die with this ruling.
- Unit 3 re-derives `ctx-handles.test.ts` boot rows without the boot-lane vocabulary; the
  assembly law describe at `transform-postprocess-phase.test.ts:9400` does not migrate.
- The window-core oracle (#2622 target) is now pinned on v2 independent of assembly.
- Nothing here licenses touching the frozen region implementation; the assembly-side
  `restore-only-boot-pass.ts` row's final deletion is executed when Unit 1 severs (this
  document is the ruling, not the deletion).
