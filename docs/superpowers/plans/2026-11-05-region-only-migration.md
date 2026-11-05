# Region-Only Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the frozen system region the only serve shape, and restore the two-tier cache economics the head-era m[0]/m[1] split provided: frozen panels in the region, delta-class content on a small volatile segment appended after the region, absorbed by the next natural fold.

**Architecture:** Today the region fold runs the head-era two-tier renderer (`materializeWithRetry → materializeM0`, `inject-compartments.ts:2548`) and discards the volatile half (`:4138` `regionMode ? undefined : materialized.m1Bytes`); delta-class content (memories, compartments-since, profile version, docs) then re-enters only through `DELTA_TRIGGER_FIELDS` rotation (`system-region.ts:279-284`), so every memory write or compartment publish costs one full-region (~38K token) re-render at the next boundary. The migration renders the region natively (no m[1] half is ever produced), carries deltas on a per-session volatile segment stored beside the region and served at the tail of `system[0]` after the region bytes, and empties `DELTA_TRIGGER_FIELDS` so region bytes change only on folds that already change the wire.

**Tech Stack:** TypeScript (Bun, `bun test`), the plugin (`packages/plugin/`) and Pi mirror (`packages/pi-plugin/`), SQLite host store (`session_meta`), biome, mc-gate test-budget wrapper.

**Spec:** `docs/designs/frozen-system-region-residency.md` — §3 (frozen region contract), §7 (pass mechanics/LKG), §9 (lane port plan), §11 (what gets deleted), §21 (flag deletion), §25 (storm defect + production-composition law). This plan supersedes §9's "reuses renderM0/renderM1" line and amends §11's `cached_m1_bytes` deletion into "delete head carriage, replace with `region_volatile_bytes`".

**Scope exclusions:** OpenCode 2 v2 adapter is out (not under obligation — it boots its own surface and serves no MC panels); Rust transform mode is out per the standing shelve (note #88) and lands as a boot-refusal, not a port.

**Execution gate (owner ruling 2026-11-05):** this plan is scheduled by the from-scratch/region-only decision (note #93), not by a defect trigger — ctxv18 sits stable; do not start before the owner's go.

## Global Constraints

- Test budget per memory #2703: scoped blast-radius laws via `~/Git/magic-context/.mcgate/mc-gate scoped <repo> <files>` while iterating; full batteries exactly once at the end via `mc-gate battery <repo>`; never re-run a green battery on an unchanged tree.
- Production-composition law per memory #2710: every convergence/wiring law must drive the real promotion path (production call sites, `currentRegionMarkersForPromotion`), never hand-write marker fixtures; a test fixture's value must be obtained by calling the production reader.
- Replay-only law: a stored line is served once; defer/boot passes replay persisted bytes verbatim with zero store reads beyond what the pass already loaded; recomputation happens only on passes that already hold bust permission.
- Canonical templates only for builder-emitted blocks (drop-shape vocabulary law); no timestamps/random/`Date.now()` inside region or volatile bytes.
- Reviewers: GLM on normal tier `opencode/go:glm-5.3-flash` (memory #2737), plan mode, drift-stop; adversarial rounds attack the closures, not the original diff.
- Commit per task with `feat(region-only):`/`refactor(region-only):`/`test(region-only):` prefix; branch `feat/region-only-migration` cut from assembly tip.
- **Window-core reference oracle (owner steer 2026-11-05, amended same day for the v2 trunk):** the migration is executed on `assembly-v2`, seeded from the reviewed `feat/synthetic-head-residency` tip — the six window files are identical to that reviewed tip at authoring, verified at true paths: `features/magic-context/system-region.ts`, `config/system-region-lane.ts`, `hooks/magic-context/lkg-replay.ts`, `hooks/magic-context/system-prompt-hash.ts`, `hooks/magic-context/system-region-wiring.test.ts`, `hooks/magic-context/system-region-rotation.test.ts`; sole recorded divergence = one assertion-string re-pin in `system-prompt-hash.test.ts` (ctxv15 seam law, test-only). Review-loop rule: every hunk in those files must be attributable to a plan unit that names the file; an unattributed window-core edit is a finding. The *window laws* (design rounds 1–4) remain the review standard.
- Rust transform mode stays out-of-contract (standing shelve, note #88); this plan makes it a boot-refusal, not a head fallback.
- Prompt-surface fixture regeneration (if measured copy moves) only under the attribution gate: every drift row names the commit that legitimately grew it.

## Review Focus

1. Quiescent memory/note write → served region bytes unchanged, zero rotations in `transform_decisions`, the delta visible in the volatile segment by the next pass. (Task 3 laws; Task 2 render tests.)
2. Fold pass with pending deltas → volatile absorbed, post-fold volatile empty, rotation count identical to a no-write control session. (Task 3 convergence laws.)
3. Defer/boot passes → volatile bytes replayed verbatim from store, zero live reads; byte-for-byte equality across restart. (Task 1 replay laws.)
4. Volatile segment is builder-emitted content: R11 empty-echo and sweep lanes must never skeletonize it; forbidden-marker sweeps stay green with a planted volatile row. (Task 1 + Task 4 laws.)
5. Pi parity: identical wire shape (region then volatile at the tail of the composed system string); `PARITY.md` records every deliberate difference. (Task 5 laws.)

---

### Task 1: Volatile segment carrier (TS lane)

**Files:**
- Create: `packages/plugin/src/hooks/magic-context/region-volatile.ts`
- Create: `packages/plugin/src/hooks/magic-context/region-volatile.test.ts`
- Modify: `packages/plugin/src/storage/schema.ts` (or the file owning the `session_meta` DDL — add `region_volatile_bytes BLOB`, `region_volatile_watermark INTEGER DEFAULT 0`)
- Modify: `packages/plugin/src/storage/session-meta.ts` (typed accessors `readRegionVolatile` / `writeRegionVolatile` on the sanctioned update surface)
- Modify: `packages/plugin/src/hooks/magic-context/system-prompt-hash.ts` (Step 2.5, after the region append at `:532-535`)

**Interfaces:**
- Produces:
  - `renderRegionVolatile(options: M0M1RenderOptions, regionWatermark: RegionVolatileWatermark): { text: string; memoryUpdateCount: number; compartmentCount: number }` — renders delta blocks for mutations newer than the region row's captured markers: `<memory-updates>` (reuse the builder at `inject-compartments.ts:3022`), `<session-history-since>` (reuse `:3163`), docs/profile delta lines; returns `""` when nothing is pending.
  - `serveRegionVolatile(db, sessionId): string | null` — decode stored bytes; zero computation.
- Consumes: existing block builders; region row markers via `snapshotMarkersFromCachedM0` (`inject-compartments.ts:1610`).

- [ ] **Step 1: Write the failing replay/determinism laws** in `region-volatile.test.ts`: (a) with stored volatile bytes and a live mutation added to the store after capture, `serveRegionVolatile` returns the stored bytes verbatim (no live read); (b) `renderRegionVolatile` called twice with the same DB state returns byte-identical output (no time/random); (c) with watermark equal to current max ids, output is `""`.

- [ ] **Step 2: Run to verify failure** — `mc-gate scoped <repo> packages/plugin/src/hooks/magic-context/region-volatile.test.ts`; expect FAIL (module missing).

- [ ] **Step 3: Implement** `region-volatile.ts`, the two columns, and the accessors; append at the serve site: when `systemRegionLane` and stored volatile bytes are non-null and non-empty, `output.system[0] = system[0] + SYSTEM_PROMPT_GUIDANCE_SEPARATOR + volatile`. The hash watcher keeps covering `hostContent` only (no new hashed surface).

- [ ] **Step 4: Recompute rule** — in the same hook, recompute via `renderRegionVolatile` and persist only when the pass already holds bust permission (`isCacheBustingPass` or scheduler execute); every other pass replays. Law: a non-bust pass with a mutated store leaves served bytes unchanged.

- [ ] **Step 4b: Growth backstop (head-era port)** — when the volatile segment exceeds a head-era-verified threshold (>40 pending memory updates, or segment past 15% of the region body with a small-region floor, or an absolute token cap), it **requests** a fold from the scheduler; it never re-renders the region itself. Law: a planted oversized volatile segment produces a fold *request* (pending row / scheduler-visible signal), zero region rotations, and zero region byte changes on the requesting pass.

- [ ] **Step 5: Run scoped laws green; commit** `feat(region-only): volatile segment carrier behind the frozen region`.

### Task 2: Region-native renderer (stop rendering-then-discarding)

**Files:**
- Create: `packages/plugin/src/hooks/magic-context/region-render.ts` (+ test)
- Modify: `packages/plugin/src/hooks/magic-context/inject-compartments.ts` (`materializeM0` `:2548`, rotation call site `:2851`, `regionMode` branches `:4138`, `:4222`)

**Interfaces:**
- Produces: `renderRegionBody(options: M0M1RenderOptions, markers: RegionMarkers): Buffer` — renders exactly the four region panels (user-profile, session-history, session-history-since, project-memory) from the store up to `markers`; never renders any m[1] block.
- Consumes by later tasks: `materializeM0` remains for anything still un-migrated; after Task 4 it has zero live callers and is deleted with them.

- [ ] **Step 1: Failing parity law** — for a fixture store, `renderRegionBody` output equals today's `materializeM0` region bytes (golden capture taken from the pre-change production path, both captured through the same options builder). This pins that extraction changes no bytes.

- [ ] **Step 2: Run to verify failure**, then implement `region-render.ts` by moving (not copying) the panel-rendering blocks out of `materializeM0`; switch `executeSystemRegionRotation`'s renderer input at `:2851` to `renderRegionBody`; region mode no longer calls `renderM1WithMetadata` at all (delete the `:4138` discard — the head half is never produced on the region path).

- [ ] **Step 3: Fold-absorbs-volatile law** — after a rotation, the funnel write also persists empty volatile bytes and the new watermark (one receipted update). Law: post-fold serve equals post-fold store bytes; a delta that was volatile pre-fold is now inside the region panel, counted once.

- [ ] **Step 4: Scoped laws green; commit** `refactor(region-only): region-native renderer, end render-then-discard`.

### Task 3: Comparator demotion — empty the DELTA trigger set

**Owner ruling 2026-11-05 (option A, confirmed as the design's founding law):** the only components that decide whether a cache bust happens are the window manager (scheduler-authorized folds) and the harness itself (H changes — e.g. AGENTS.md edits surfacing through `system_hash`). Every other component — memories, notes, compartments, profile, docs — only schedules its changes/additions onto the volatile segment. `project_docs_hash` (ARCHITECTURE.md/STRUCTURE.md panel) is a scheduled component, not H; AGENTS.md is host-prompt content and stays a harness-side bust.

**Files:**
- Modify: `packages/plugin/src/features/magic-context/system-region.ts` (`DELTA_TRIGGER_FIELDS` `:279-284`, comparator docstring `:228-233`, comment `:271-277`)
- Modify: `packages/plugin/src/features/magic-context/system-region-wiring.test.ts`, `system-region-rotation.test.ts`
- Modify: rotation-reason fence participants (the two-way-checked closed vocabulary)

**Interfaces:**
- Produces: `DELTA_TRIGGER_FIELDS` becomes an empty array retained as the fence anchor with its law; rotation reasons = HARD/fold-driven vocabulary only (`region_first_install`, fold-inherited reasons, `force_band`).
- Consumes: Task 1's watermark (what the volatile segment shows instead of rotating).

- [ ] **Step 1: Failing wiring law (red-first, production-composition)** — drive the promotion decision through the production call site with a warm quiescent session, then bump **each** of `maxMemoryId`, `maxCompartmentSeq`, `profileVersion`, `projectDocsHash` live in the store (one test each, real writers, never fixture markers): assert `rotate === false` and zero new `transform_decisions` rotation rows.

- [ ] **Step 2: Run to verify failure** (all four currently rotate); delete the four entries from `DELTA_TRIGGER_FIELDS`; update the comparator comment to the true law: *"cheapness came from placement behind the cached prefix, not from boundary timing; delta-class content rides the volatile segment and is absorbed on folds."*

- [ ] **Step 3: Absorb-on-fold law** — natural fold (compartment publish or drop pass) with pending deltas: region bytes include the new memory/compartment, volatile returns to empty, total rotation count for the session equals the control run without writes.

- [ ] **Step 4: Fence consistency** — reason vocabulary census stays two-way green with the emptied set (a re-added DELTA entry must go red on the wiring laws: plant each entry as a rogue mutation witness and show the specific law catching it).

- [ ] **Step 5: Scoped laws green; commit** `fix(region-only): demote delta triggers to volatile carriage; region changes only on folds`.

### Task 4: Head-lane deletion (spec §11) + capability predicates

**Files:**
- Modify: `packages/plugin/src/hooks/magic-context/inject-compartments.ts` (delete `prependM0M1Messages`, head call sites, `M0_EMPTY_BODY`, `M1_EMPTY_PLACEHOLDER`, `replayCachedM1`, head-lane `softRefreshCachedM1` path and its cached-m1 branch)
- Modify: `packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts` (`info.syntheticHead`, `isSyntheticHeadMessage` walks `:222,253,1293`), `tag-messages.ts:243`, `rust-served-m0.ts:37`, `plugin/messages-transform.ts:605-618` (#129 arms), `openai-compat-adjacency.ts` head adjacency cases, `hooks/magic-context/system-prompt-hash.ts:403-408` (key-files remnants)
- Modify: `packages/plugin/src/hooks/magic-context/hook.ts:721` + `features/magic-context/system-region-lane.ts:19` (`isSystemRegionLane` → constant true; Rust transform mode → loud boot refusal per §21 shape)
- Modify: `docs/designs/frozen-system-region-residency.md` (mark §11 rows done; record the compaction-off ruling below)

**Interfaces:**
- Consumes: Tasks 1–3 (region + volatile are the only serve surface).
- Produces: the deleted-symbol census baseline for the review loop: zero live references to `prependM0M1Messages`, `syntheticHead`, `M0_EMPTY_BODY`, `cachedM1Bytes`, `readCurrentM0SnapshotMarkers` placeholder contract (the docs-storm root dies with it).

- [ ] **Step 1: Failing census** — a planted-rogue test that greps the production tree (statement-rule parser per the H1/H4 census precedent) for the deleted symbols and fails on any live reference; red until Task 4 deletions land.

- [ ] **Step 2: Compaction-off ruling (owner 2026-11-05): no head preservation, no gradual-migration carve-out.** `compaction.enabled:false` sessions serve the region like every other session and re-render on the same window-manager/harness bust authority — they are not held across multiple updates, so they cache-bust anyway and there is zero point preserving the head-era path for them. `isSystemRegionLane` is therefore constant `true` with no compaction-off branch; the head lane has no surviving consumer.

- [ ] **Step 3: Delete per §11 row by row**, running the scoped law set after each row; every deletion's test must fail before the delete and pass after.

- [ ] **Step 4: Boot-refusal law** — with `transform_mode: "rust"` the plugin logs a named refusal and serves with region lane disabled-but-headless (no head synthesis anywhere); the refusal string joins the census vocabulary.

- [ ] **Step 5: Prompt-surface fixture** — regenerate under the attribution gate only if measured copy moved; commit `refactor(region-only): delete head-era carriage (spec §11)`.

### Task 5: Pi mirror

**Files:**
- Modify: `packages/pi-plugin/src/inject-compartments-pi.ts` (delete `prependM0M1Messages` `:2553`; region-only; volatile segment at the tail of `composeMagicContextSystemPrompt`), `system-prompt.ts` (watcher split mirrors `processSystemPromptForCache` `:121-234` with H/region/volatile separation), `system-entry-pi.ts` (index-zero contract stays), `derivePiRegionBoundary` (volatile bytes must not move the boundary)
- Create: `packages/pi-plugin/src/region-volatile.test.ts`
- Modify: `packages/pi-plugin/PARITY.md`

**Interfaces:**
- Consumes: Task 1 semantics re-expressed in the Pi codec (own copy, per the Pi-adoption precedent — no cross-package import of `region-volatile.ts`).
- Produces: parity lines in `PARITY.md` for: volatile tail carriage, demoted triggers, boot replay.

- [ ] **Step 1: Failing parity laws** — same five Review-Focus behaviors re-expressed against the Pi serve path (quiescent write → no rotation; fold absorbs; defer replay verbatim; sweeps don't touch volatile; index-zero system contract intact with volatile appended).
- [ ] **Step 2: Implement**; run scoped Pi laws green.
- [ ] **Step 3: Commit** `feat(region-only): Pi lane volatile segment + head deletion`.

### Task 6: Verification, battery, placement

**Files:**
- Modify: `docs/opencode-installed-tools.md` (harness repo registry — placement row, Version/Config), install spec pin + backup (`.pre-ctxv19`), pin directory entry `@cortexkit/opencode-magic-context@0.45.0-ctxv19`

- [ ] **Step 1:** mc-gate scoped pass at final tip → `mc-gate battery` once (plugin + Pi); expected: zero failures, blessed set per #2703 flake policy (contested heap class only).
- [ ] **Step 2:** Field receipts gate on a live restart: boot pass serves stored region + volatile verbatim (`rematerialized=false`), a scripted memory write on a quiescent session produces **zero** rotations and a volatile-delta sighting in the served bytes, next fold absorbs (volatile empty, rotation count flat). Capture store rows as evidence.
- [ ] **Step 3:** Standard placement (dist aside → fresh build → tarball identity → marker gates → spec flip with backup → registry + memory #888 sync); rollback pair = ctxv18.
- [ ] **Step 4:** Adversarial review loop (GLM normal tier, plan mode) attacking Tasks 1–5 closures; converge per the standing rule before the placement is declared stable.
