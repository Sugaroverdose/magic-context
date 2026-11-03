# Frozen system-region residency for store-backed panels

Status: **reviewed, owner rulings recorded (§12); constitution added (owner mandate,
2026-11-03) — the law set L1–L9 is the spec.** The decisions in §3 through §8 are law for
the implementation. §12.7 remains open with its proposed default in force (§12.6 was
ruled: slots survive rotation, §7.4). Step 2 (durable-slot honesty) has landed.

Base: this lane was rebased off assembly onto the v0.45.0 tag (`cb6724d69`) on 2026-11-03
(backup tag `archive/synthetic-head-pre-rebase-2026-11-03`). The lane is
`v0.45.0 + prereqs + frozen-region feature`, the prerequisite commits contiguous at the
base: step-2 LKG slot honesty `8953bc4ee` + `dd67ed427`, then the R12 system-reclaim
boundary `6526ca687` (adapted — see §7.2). The extraction property — `git diff
v0.45.0...HEAD` minus the prerequisite commits = the feature only — is the invariant to
preserve.

Audience: the lane owner and the implementers of the OpenCode 1, OpenCode 2, Pi and Rust
lanes. Purpose: approve what the frozen system region is, when its bytes may rotate, how the
system-prompt hash watcher splits, and what each lane ports. Non-goals: the LKG wipe root
cause (step 2 of the lane), the mural product itself, dashboard UI changes.

## Summary

- The five store-backed panels stop being user-role head messages. They become one
  store-backed byte string (the "system region") appended to `system[0]`, captured only at
  legitimate materialization boundaries, and served verbatim on every other pass.
- Boot and live passes serve the stored bytes with zero store reads on the serve path.
  Byte-identical boot replay is the product target, not an optimization (V5 law).
- Panel edits no longer rotate array-head bytes. They move a store-version marker, and the
  marker decides rotation at the next legitimate boundary. This kills the unlogged
  array-token-0 bust (work item, measured on the live install: Nov 2 01:55:46Z floor
  105,501/39,744 with `reason=unknown executed=false` and no fold).
- The hash watcher splits into two segments with different contracts: the host-guidance
  segment (host prompt + MC guidance + sticky date) keeps today's immediate-fold re-anchor
  arm, and the frozen region is never hashed live, only rotated at boundaries.
- The user-role head machinery is deleted: `syntheticHead`, the part-level `synthetic`
  head flags, `M0_EMPTY_BODY`, the `isSyntheticHeadMessage` head walks, and the #129
  phantom-turn special cases.
- Pressure accounting moves from the array tokenizer to the served-system estimate, which
  already exists (`final-wire-token-estimate.ts:267` folds `systemPromptTokens` in).

## Constitution (L1–L9): laws as structural properties

Owner mandate, 2026-11-03: the frozen region is a new window. The cache-resiliency
imperatives this fork accumulated as band-aids (Oct 23 units bug through ctxv14) are its
foundations, not features to re-implement on top. For each law: the guarantee, the
structural property that makes violation impossible-by-construction, the guard it
obsoletes, and the law test that attacks the mechanism. If a law ever needs a bolt-on
guard instead of a structure, that is a design smell to raise in §12, not to patch
silently.

- **L0 — Single writer, schedule-only (owner law, 2026-11-03).** Exactly one mechanism —
  the boundary transaction — may change bytes MC contributes to the served wire. Every
  other subsystem holds no write authority and may only enqueue intent (queue/marker row →
  named boundary → transaction). The sole synchronous exception is model-issued stamp
  intent (`ctx_reduce` → `pending_ops` row; the drop still lands only through the
  boundary's queue drain). Foreign byte-zones — the host-composed system region — are
  OUTSIDE the contract by design: their rotation is a content event or a foreign defect,
  and MC's duty is detect, name in a receipt, re-anchor (the watcher's H arm). Structure:
  the per-actor producer census (`system-region-producers.test.ts`) enumerates every
  subsystem able to influence served bytes and pins each row's legal path; a direct write
  outside a named actor fails CI (same form as the region-column sole-writer census). A
  rotation trigger present in code but absent from §4's named-boundary list is an L0
  violation. Obsoletes: the whole "which lane may mutate" argument class. Tests: the
  producer-census rows + the carried column census + the single-bust-permission pair
  (§10 row 5).
- **L1 — Boot is replay, never re-derivation.** Stored region bytes are served verbatim;
  the serve path performs zero store reads beyond the session meta the pass already
  loaded. Structure: serve is `decodeSystemRegionRow(sessionMetaEarly.cachedM0Bytes)` —
  a sentinel strip and return; assembly exists only behind the rotation transaction, and
  the sentinel admits no row the serve writer did not produce. Obsoletes: the restore-vs-
  live head divergence class. Tests: `system-region.test.ts` R11 reader-contract rows
  (legacy raw row → null → first-render); `system-region-serve.test.ts` steady-replay and
  gate-off rows; planned §10 attack row: instrument the db handle and assert zero
  additional `prepare` calls during a serve pass.
- **L2 — Content events move bytes; restarts never do.** Structure: rotation eligibility
  is `decideSystemRegionRotation`, a pure compare of live store markers against the
  markers captured at the last rotation; a fresh process reading the same row and markers
  computes `rotate=false`. No boot-time path calls the assembler. Obsoletes: boot
  cache-bust. Tests: rotation-decision rows (identical markers → false across a re-opened
  handle); planned §10 row 1 (panel mutation + restart → byte-identical serve, zero
  rotation/hash lines).
- **L3 — Movement happens only inside a named rotation transaction.** Structure: every
  region byte change flows through `executeSystemRegionRotation`, whose reason is a
  required parameter drawn from the enumerated set — provider-eviction re-anchor
  (model/system-hash/TTL/host-compaction), the content arms (`project_memory_epoch`,
  `max_mutation_id`, `max_memory_mutation_id`, `upgrade_state`, `compartment_render_epoch`,
  `mural_enabled`, `render_budget_identity`, `memory_render_epoch`, `rendered_budgets`),
  the bust-gated delta-trigger class (`max_memory_id`, `max_compartment_seq`,
  `profile_version`, `project_docs_hash` — rotation triggers here, m[1] refreshers on
  the head lane), and the pressure arms (`force_band`, `pending_growth`); the install
  arms (`first_render`, `missing_markers`) belong to the fold lane. Every arm of the
  decision requires the single per-pass bust permission (A3) — an anonymous bust, or a
  rotation claimed on a non-busting pass, is not type-expressible. Obsoletes: scattered
  bust guards. Tests: rotation rows assert the receipt names its reason and that no arm
  rotates without the permission; inert-gate negative controls prove each decision arm
  discriminates.
- **L4 — When the region does not rotate, nothing trims, adds, or re-renders into it.**
  Structure: the serve path is read-only by construction (no mutation API exists for
  region bytes outside the rotation transaction); every system-origin change is a marker
  move or a queue row, and the single R12-derived permission (`transform-postprocess-
  phase.ts:2042-2050`) holds the whole queue until a boundary — on this base there is no
  per-origin immediate-apply carve-out (§7.2 frozen-base note), so "queues and rides" is
  the only shape. Obsoletes: per-site bust checks and R12's gate as a bolt-on — it
  becomes the region's own admission control. Tests: the carried R12 rows (`transform-
  postprocess-phase.test.ts`, `system-reclaim-boundary-pi.test.ts`), `system-region-
  serve.test.ts` steady-pass rows (refresh sets stay empty), and the §10 row 5 single-
  bust-permission pair.
- **L5 — Served bytes are immutable once served.** Structure: shape is decided at apply
  (rotation time); replay reads frozen state. The region decode is pure extraction — it
  cannot re-tier, re-render, or re-budget; decay tiers live inside stored bytes and move
  only at rotation (the m[0] re-tier law, strengthened: tiers are literally stored
  text). Watermark-gated strips keep the frozen-id replay pattern on the array side.
  Obsoletes: the drop_mode class, generalized from tool tags to the region. Tests:
  encode/decode identity rows over hostile whitespace/unicode payloads; serve rows
  proving byte-equality across passes.
- **L6 — Capture == served.** Structure: the durable capture (region blob + marker
  manifest) is written inside the fold's single persist callback
  (`materializeM0` → `executeSystemRegionRotation(db, …, persist)`), so a snapshot stale
  relative to last-served bytes cannot exist; there is no second capture step to
  re-derive from. Obsoletes: the §4b(b) capture-cadence defect class. Tests:
  `system-region-fold.test.ts` — region equals the exact concatenation the fold
  rendered, markers equal the fold's snapshot, and refused rotations capture nothing.
- **L7 — Every refusal, clear, drop, and rotation emits a named-reason receipt.**
  Structure: one funnel per event class — `executeSystemRegionRotation` logs
  unconditionally with the reason (executed=true/false), and the LKG slot store refuses
  through `lkgSlotStructuralRejection` at both gates with logging refusal paths
  (`lkg-slot.ts:381-396`, `lkg-persist.ts:221`, `:372-378`, `lkg-slot.ts:576`,
  `lkg-replay.ts:393`). Obsoletes: per-incident receipt patches (the five-path hunt of
  `dd67ed427` became a law, not a fix). Tests: receipt rows count lines per event
  (red-first, silent paths fail CI); negative controls removed one receipt and the row
  went red.
- **L8 — One invalidation per event.** Structure: the cause sets are disjoint by
  construction — the live watcher hashes H only (`hostContent`), the region is never
  hashed live, and panel causes appear only in the rotation decision list. A panel edit
  therefore produces exactly one possible bust, at the next boundary; a host edit
  produces exactly one, the re-anchor fold. Obsoletes: the `reason=unknown executed=
  false` class and any coexistence guard between panel churn and the watcher. Tests:
  `system-region-serve.test.ts` — panel-content change moves neither the watched hash
  nor the refresh sets; H change moves exactly the re-anchor arm set.
- **L9 — Log labels distinguish replay from rebuild from queue-ride.** Structure: the
  receipt vocabulary is closed — a served pass is silent (replay), a rotation prints
  `system-region rotation: reason=… executed=…` (rebuild), a held drain prints
  `pending ops held — reason=system-reclaim-ride-required` (queue-ride), a refused
  capture prints `lkg_capture_declined reason=…`. No path reuses another's line, so a
  receipt always names the producing path. Obsoletes: the `lkg=` ambiguity lesson.
  Tests: each law row asserts its exact label; a queue-ride receipt can never satisfy a
  rebuild row.

Deletion duty (deletion is as load-bearing as addition): the head-side guards the
structure obsoletes land with §11 — the `mustMaterialize` m[1]-delta non-trigger list
becomes the region's marker non-trigger list, the head empty-placeholder floors collapse
into the never-empty floor enforced at the store writer (`writeSystemRegion`), and the
per-lane m[1] refresh bust checks collapse into L4's single permission. The
provider-eviction re-anchor arms (model/system-hash/TTL) stay — they anchor H, and L8's
disjointness is what keeps them from ever firing for P.

## 1. Problem

The heads are built in `inject-compartments.ts:3346` (`prependM0M1Messages`) as
`role: "user"` with `info.syntheticHead: true` and part-level `synthetic: true`. The
user-role wrapper exists only because the April 2026 host pipeline forces it: OpenCode's
`toModelMessagesEffect` filters on `ignored` (not `synthetic`), and the title-generation
gate counts any non-all-synthetic user message as a real turn, which is the #129
phantom-turn fix documented at `inject-compartments.ts:3348-3366`.

The measured costs (work item, live install):

1. A panel-store edit (profile, memory, docs, compartment publish) rotates the array-head
   bytes. The provider cache busts from array token 0 with no fold and no log line: the
   pass reports `reason=unknown executed=false` at the fold-decision receipt
   (`transform-postprocess-phase.ts:2019`). There is no fold, so nothing prices or records
   the bust.
2. Authority confabulation: the model attributes panel content to the user (Nov 2
   delete-confabulation quoted the `<user-profile>` block). A user-role wrapper is an
   authority lie the panel should never have carried.
3. Role-keyed breakage. Every role-or-position-keyed guard in the pipeline must know about
   the fake heads: `isSyntheticHeadMessage` head walks
   (`transform-postprocess-phase.ts:222,253,1296`), the Rust-served head parse
   (`rust-served-m0.ts:37`), the ID-less-head carve-out in the `IncompleteUserMessageError`
   guard (`plugin/messages-transform.ts:605-618`), and the empty-fake-user-turn provider
   rejections.

The system channel is the proven alternative, but only for byte-constant content: the
handler appends the MC guidance block to `system[0]` at `system-prompt-hash.ts:406`, and any
mutable byte in `output.system` trips the whole-content hash watcher
(`system-prompt-hash.ts:521-545`), which schedules a flush and fold on every change. That
watcher behavior is exactly what must change: constant bytes re-anchor immediately,
store-backed bytes rotate only at boundaries.

## 2. Definitions

- System region (P): the store-backed panel bytes, one string: `<project-docs>`,
  `<user-profile>`, `<project-memory>`, `<session-history>` (decay-rendered compartments),
  plus the delta blocks that m[1] carries today (`<memory-updates>`,
  `<new-compartments>`, `<new-memories>`, `<new-user-profile>`). Assembled from
  `context.db` at rotation time and stored per session.
- Host-guidance segment (H): the host prompt + the MC guidance block appended at
  `system-prompt-hash.ts:390-406` + the sticky date line (`:456-471`). Mutable only by re-anchor events
  (build upgrade, guidance/AGENTS source edit, prompt-surface or ctx_reduce verdict settle).
- Rotation: replacing the stored region bytes with a fresh assembly. A rotation is a cache
  bust at the region start: everything after H is re-cached.
- Materialization boundary: a pass that is already busting the served prefix for a
  legitimate reason (§4). Only these passes may rotate. The canonical enumeration is the
  R12 `systemReclaimAllowed` predicate plus scheduler-execute — the promotion caller's
  `boundaryPermission` in `transform-postprocess-phase.ts` is that enumeration; every
  `decideSystemRegionRotation` arm additionally requires its own `bustPermission`
  argument, so the effective permission is the intersection.

## 3. Frozen region contract

Serve path (boot and live): read the stored bytes and append them after H in `system[0]`.
No store reads, no re-assembly, no re-tiering, no budget re-decisions on the serve path.
The never-re-decide-at-serve rule (the `drop_mode` lesson) applies: the region's shape was
decided at the rotation that captured it.

The append stays inside `system[0]` rather than a second array entry, for the reason pinned
at `system-prompt-hash.ts:397-403`: OpenAI-compatible serializers emit one wire message per
entry and strict chat templates reject a second system message.

Boot after a panel-store mutation must serve the stored bytes even though the markers have
moved. Post-restart rotation is illegitimate by definition; the user ruling. A restart is
not a boundary. The trigger list in §4 is event-keyed, never boot-keyed. When a restart
does coincide with a real boundary (idle past TTL with `lastResponseTime` newer than the
last rotation), the rotation rides the TTL arm, not the restart.

## 4. Rotation boundaries

Rotation is ride-only. It never originates a bust (invariant 4 of ARCHITECTURE's load-bearing
list). A pass may rotate only if it is already busting for one of these reasons, which are
today's `mustMaterialize` HARD trigger set (`inject-compartments.ts:1757-1957`) with the
m[1]-specific members removed. The mechanism is not invented here: rotation eligibility
cherry-picks the merged R12 system-reclaim boundary law, the `rideSignals` enumeration and
`systemReclaimAllowed` predicate (`transform-postprocess-phase.ts:2042-2081`: hardFold,
force, explicitFlush, publishedHistory, plus the aborted-fold arm
`deferredMaterialize && prefixPreflightFailed`). The FPE lane's boundary enumeration and
bust-permission pattern is the reference implementation; the provider-eviction arms below
are its event sources.

Provider-side eviction, the cache is already dead, rotation is free:

- model or provider change (`cachedM0ModelKey` arm, `inject-compartments.ts:1834-1843`),
- H re-anchor: host-guidance hash change (the watcher split, §6; `system_hash` arm
  `:1844-1852` restricted to H),
- idle past TTL, self-consuming as today (`:1866-1879`),
- host compaction (`:1886-1892`).

Genuine content or config change, the region bytes must change anyway — the content arms
of `decideSystemRegionRotation` (`CONTENT_TRIGGER_FIELDS`, system-region.ts):
`projectMemoryEpoch`, `maxMutationId` (structural compartment mutations),
`maxMemoryMutationId` (non-additive memory mutations), `upgradeState`,
`compartmentRenderEpoch`, `muralEnabled`, `renderBudgetIdentity`, `memoryRenderEpoch`,
`renderedBudgets`. The install arms (`first_render`, `missing_markers`) are decided by
the fold lane (`mustMaterialize` `region_first_install`), never by the promotion
decision: every arm of `decideSystemRegionRotation` is bust-permission-gated (A3) — a
rotate=true verdict on a non-busting pass is not expressible, so a widened caller cannot
license a byte move that the pass has not already paid for.

Pressure backstop:

- the force band (about 85%) rotates when markers have moved, mirroring
  `forceMaterialization` today,
- the pending-growth refold gate: when the not-yet-visible delta (new memories past the
  captured watermark, unpublished compartments, profile additions, docs drift) exceeds the
  existing m[1] absolute cap (about 20% of the history budget, with a small-region floor)
  or the large memory-mutation count, rotation is due; it lands on the next pass that is
  busting anyway, and the force band is the guarantee it eventually lands.

The four head-lane m[1]-delta fields — a new compartment sequence,
`project_user_profile_version`, `maxMemoryId`, project-docs hash drift — are deliberate
non-triggers of the m[0] HARD fold on the HEAD lane (they re-rendered m[1] there). In
region mode there is no m[1] to ride, so they keep their exact role by changing shape:
they are the bust-permission-gated DELTA triggers (`DELTA_TRIGGER_FIELDS`) — they rotate
the region on a pass that is already busting, never originate a bust themselves, and
without them new memories, compartments, profile additions, and docs edits would never
surface at all (the round-2 discovery). Their freshness ceiling is the pending-growth
backstop and the force band. What stays a true non-trigger everywhere: the tool-set hash
(process-global, false positives; `:1853-1856`).

No new user-facing rotation trigger is designed. The operator's rotation trigger is
`/ctx-wrapup` (owner ruling): wrapup publishes history, and the published-history signal
is a R12 `rideSignals.publishedHistory` arm (`transform-postprocess-phase.ts:2026-2033`),
so a wrapup pass is a rotation boundary (`publishedM1RefreshedThisPass`). Wrapup's shipped
semantics (imports sessions MC does not manage yet, or wraps up when the context window
became smaller) already reach this arm on installs that leave MC's own `compaction` config
key unset, which is the shipped default here. The RPC command surfaces are untouched by
this lane.

The rotation-reason vocabulary. This is a **synchronized review vocabulary**, not a
generator: `system-region-producers.test.ts` parses it and enforces doc↔code
bi-equality (a doc entry without a code arm reddens; a code literal absent here
reddens). Authority is for review language — it does not govern spellings L0 does
not police, and a rename applied to BOTH sides stays green by design; the code's
decision tables remain the runtime authority. Composite reasons match on their
stem before `:` or `(` (e.g. `render_config:budget_shrink(...)` is the
`render_config` member).

```rotation-reasons
hard_fold
first_render
missing_markers
region_first_install
model_change
system_hash
ttl_idle
host_compaction
project_memory_epoch
max_mutation_id
max_memory_mutation_id
upgrade_state
project_change
compartment_render_epoch
mural_enabled
render_budget_identity
memory_render_epoch
rendered_budgets
max_memory_id
max_compartment_seq
profile_version
project_docs_hash
force_band
pending_growth
render_config
```

## 5. Rotation markers (the generalized profileVersion pattern)

Today the per-panel store-version watermark pattern is `renderM1`'s profile gate
(`inject-compartments.ts:3026-3033`): `getGlobalUserProfileVersion(db)` versus the captured
`markers.projectUserProfileVersion` decides whether the `<new-user-profile>` delta renders.
The generalization: every panel in the region carries a store-version marker captured with
the region bytes at rotation, and rotation eligibility is a compare of the live marker set
against the captured set — precisely the two named lists (`CONTENT_TRIGGER_FIELDS`,
`DELTA_TRIGGER_FIELDS`) plus the pressure arms; a marker outside those lists (tool-set
hash) and anything the H-side watcher owns (system hash, model key) never moves the
region. A trigger present in code but absent from §4's enumeration is an L0 violation
(producer census below).

| Panel | Marker (existing) |
|---|---|
| user profile | `cached_m0_project_user_profile_version` |
| project memory | `maxMemoryId` + `memory_mutation_log` high-water (`cached_m0_max_memory_mutation_id`) + `project_memory_epoch` |
| session history | `cached_m0_max_compartment_seq` + `cached_m0_max_mutation_id` |
| project docs | `projectDocsHash` (stored with the rendered bytes) |
| budgets/config | `renderBudgetIdentity`, `compartmentRenderEpoch`, `upgradeState` |

All of these already exist as `session_meta` columns written by the m[0]/m[1] machinery
(`readCurrentM0SnapshotMarkers`, `inject-compartments.ts:1561`; `CachedM0M1Row`,
`:3038-3049`). The marker set is also the "pending delta" estimator input for the backstop:
the bytes between the captured markers and the current store state are the pending delta.

No new marker columns are required. The serve path must not read markers (a marker read
that renders different bytes would be a re-decide at serve); the marker comparison happens
once per pass in the eligibility check, which decides rotation, never content.

## 6. Hash watcher split

One watcher, two verdicts, computed in `system-prompt-hash.ts` (and its Pi mirror, §9):

1. Compute H (everything except the stored region suffix) and hash it against the persisted
   `systemPromptHash`. Change, and the segment is not a sticky-date-only change: re-anchor.
   Fire today's hash-change arm verbatim (`:505-519`: add to `historyRefreshSessions`,
   `systemPromptRefreshSessions`, `pendingMaterializationSessions`, delete
   `lastHeuristicsTurnId`). The next pass folds and re-anchors H; the rotation (§4 boundary)
   lands on the same bust, so a guidance edit still re-anchors everything in one priced
   bust. This is the V5 law preserved: same-build restart with edited AGENTS.md or guidance
   bytes at the source must STILL fold.
2. The region P is never hashed live. The watcher hashes `output.system` minus the stored
   region suffix, so a rotation (a store-version move applied at a boundary) never produces
   a `system prompt hash changed` line, and a panel edit with no boundary produces no line
   at all. Rotation observability is its own receipt (§8), not a hash-change lie.

The two segments are separated by the stored region bytes: the handler knows the exact
suffix it serves, so the H candidate is `output.system[0]` minus that suffix. The sticky
date freeze logic (`:424-478`) keeps its current contract on H only.

Persistence interaction that must not regress: `cachedM0SystemHash` is seeded by this
handler at first hash and on idle expiry (`:557`); it stays the H hash, because the
`system_hash` trigger is now the re-anchor arm.

## 7. Pass mechanics, accounting, LKG

### 7.1 Pass taxonomy after the change

SOFT+ (cache_hit) is unchanged: stored region served verbatim, tail moves where queued
drops land. SOFT-as-m[1]-refresh disappears: there is no m[1], and a marker move without a
boundary is byte-identical. HARD fold becomes region rotation at the §4 boundaries. The
m[0]-decay-re-tier-only-on-fold law is preserved and strengthened: decay tiers are frozen
in the stored bytes and can only change at rotation.

### 7.2 One bust permission

The single per-pass bust permission (invariant 4) now also gates rotation, as one more
consumer of the R12 `systemReclaimAllowed` predicate (`transform-postprocess-phase.ts:2042-2050`),
not a parallel gate. Frozen-base note: on v0.45.0 the pending-op vocabulary is a single
`drop` operation (no FPE-era `auto_drop` origin class), so the carried R12 gate is
all-or-nothing — the whole queue rides the byte-change permission or waits, with a
`pending ops held — reason=system-reclaim-ride-required` receipt. The constitution's L4
is stated against this shape; when the FPE lane rebases, its origin-class filter may
re-narrow, never widen, the same permission. Every mutation
lane (queued `ctx_reduce` drops, age sweeps, heuristics, synthetic todo, sentinel
first-application, and now rotation) consults the same permission; a veto that applies to
one lane and not another remains a defect (the ALF split-bust precedent). The
`compartmentRunning` veto keeps its emergency bypass: a boundary that is already busting
(force band, re-anchor, or the fold-executed predicate) bypasses the veto and drains the
rotation into the known bust (drain-into-the-known-bust invariant, unchanged).

### 7.3 Pressure accounting for system-resident bytes

The array tokenizer no longer sees panel bytes; the served-system estimate already does.
The hash handler estimates the full served system content and persists it as
`sessionMeta.systemPromptTokens` (`system-prompt-hash.ts:573-586`), and
`estimateFinalWireInputTokens` folds that in beside the array and tool estimates with the
calibrated `systemRatio` (`final-wire-token-estimate.ts:267-298`). Requirements:

- The estimate must be taken on the full served `output.system` (H + P), which is what
  today's site does, so no new estimator lane is added.
- Region assembly keeps charging every panel against its own budget at rotation time
  (history, memory, profile budgets and their identities, `renderBudgetIdentity`,
  `inject-compartments.ts:1139-1145`), so the region cannot grow unbounded between
  rotations.
- Force-band and 95% refusal thresholds read the combined estimate and are unchanged in
  semantics; they now cover the region through `systemPromptTokens`. The 95% refusal and
  emergency reclaim must be able to fire a force-band rotation (rotation is the region-side
  reclaim: rotating shrinks the region when the store shrank; it never shrinks below the
  empty-region floor, and drops/reclaim in the array are unaffected).

### 7.4 LKG and persistence interaction

An LKG slot captures the message-array prefix (`jsonPrefix`); the region is not in the slot
and never was. Consequences:

- Replay serves the current stored region with the replayed array. After a rotation the
  replayed array is stale-by-one-generation only in the sense that it was built against an
  older region; since a rotation is a priced bust, and replay only fires on fault, the
  slots are kept across rotations (no new fence; owner ruling, §12.6: a rotation is
  itself a bust pass, so the capture refreshes on the same pass and no boot-rebuild
  window opens between rotation and first capture). Stale panels on a fault replay are
  acceptable and cheaper than dropping the recovery ladder.
- Boot-cache-bust honesty (landed, step 2, prerequisite commits `8953bc4ee` + `dd67ed427`
  on the rebased base; was `1210bf8c3`/`a49c8611e` pre-rebase): the observed
  wipe (22 chunks to 0 rows, `captured_at` reading NULL, zero `lkg_capture_declined`
  lines) was reproduced red-first and closed at every silent path. `captureSlot` and the
  durable writer now share `lkgSlotStructuralRejection` (`lkg-slot.ts:381-395`, reasons
  `empty_prefix`, `missing_anchor`, `invalid_captured_at`), so a slot that
  `parsePersistedLkgSlot` could never read back is refused before install;
  `saveLkgSlotToDb` (`lkg-persist.ts:221`) runs the same pure check before its
  chunk-deleting transaction and logs `lkg_persist_declined`; `dropSlot` emits
  `lkg_slot_dropped reason=...` (`lkg-slot.ts:576`); `loadPersistedLkgSlot` names its
  parse-failure clear (`lkg-persist.ts:372-378`); `captureLkgSlot` logs
  `lkg_capture_declined reason=build_<cause>` on the prefix-build falsy path
  (`lkg-replay.ts:393`) that precedes the slot store's reason logic, and the bust path's
  `dropSlot(sessionId, "lkg_refresh_declined")` into the store is now visible; the Rust
  capture site no longer short-circuits around `captureSlot`'s refusal receipt. Law
  tests: `lkg-store-honesty.test.ts` (9 tests). `lkgReplayStateLabel`
  (`lkg-persist.ts:321-332`) keeps reporting mem/disk/absent from row existence, which is
  honest now that no unlogged path can empty a row.
- Storage: `context.db` and the Rust `store.db` remain one consistency unit; if the region
  is mirrored into the module store (§9), it restores from the same backup.

## 8. Observability

Rotations must be as loud as folds. New receipt beside the fold decision line
(`transform-postprocess-phase.ts:2019`):
`system-region rotation: reason=<boundary> markers=<moved set> bytes=<n> executed=<bool>`.
The `reason=unknown executed=false` class the work item measured becomes detectable: any
panel-visible change reaching the model either rides a rotation line or did not reach the
model. Serve-path bytes come from one stored string, so "no rotation line + different wire
bytes" becomes a contradiction that the law tests (§10) can pin.

## 9. Lane port plan

OpenCode 1 (`src/hooks/magic-context/`, `src/plugin/`):
region assembly reuses the `renderM0`/`renderM1` block renderers; serve and watcher split in
`system-prompt-hash.ts`; rotation eligibility in the transform pass replaces
`prepareCompartmentInjection`/`materializeM0` call sites; postprocess gates consult the
shared bust permission.

OpenCode 2 (`src/v2/`): fold ownership lives in the v2 seam (`src/v2/hooks/context.ts`);
rotation attaches there behind the same shared decision function. The hidden-completion
executor and store reader must be re-audited for head-shape assumptions
(`degraded-pass` tests reference `syntheticHead`).

Pi (`packages/pi-plugin/src/`): delete `prependM0M1Messages` (`inject-compartments-pi.ts:2553`);
compose the region into the system string beside the guidance block
(`composeMagicContextSystemPrompt`, `system-prompt.ts:89`), never as a mid-array
`PiSystemEntry`, because Pi transports read the index-zero system for the initial-tools
contract (`system-entry-pi.ts:45-83`); the watcher split mirrors
`processSystemPromptForCache` (`system-prompt.ts:121-234`) with the same H/P separation.
`placePiInitialSystemAtHead` stays (it places Pi's own system entry, not MC content), and its
"two synthetic history messages" insertion index collapses to zero. `PARITY.md` records the
deliberate differences.

Rust (`crates/`): the module today encodes the heads itself (`ck_wire.rs:255,310`;
`memory_render.rs` `M0_EMPTY_BODY:27`, `render_m0`). Plan: the module stops emitting head
items; region assembly and marker comparison mirror `mustMaterialize` in `injection.rs`;
the TS coordinator keeps the system-channel serve (the `experimental.chat.system.transform`
hook stays TS even in Rust mode), and the region bytes flow TS to module in the state sync
(`module-state-sync.ts`) so the module never re-renders served bytes. Failure mode: module
fault replays the LKG array under the TS-served region, which is already the §7.4 contract.
This port is [inferred] at plan level; its station arms land with red tests against the
hermetic subc harness before any Rust-mode enablement.

## 10. Law tests (red first)

The user rulings become executable laws, one test each, written red before the
implementation, with an inert-gate negative control per arm (a control proving the gate
discriminates: disable the gate, the law test must fail):

1. Boot after a panel-store mutation serves byte-identical region bytes: mutate memories,
   profile, docs, publish a compartment; restart; assert served `system[0]` equals the
   stored region, zero `system prompt hash changed` lines, zero rotation lines, and the
   fold receipt stays `executed=false`.
2. Same-build restart with edited AGENTS.md or guidance bytes at the source still folds:
   re-anchor preserved. Assert the hash-change arm fires, the three refresh sets receive
   the session, and the rotation rides the same pass.
3. Panel rotation is observable only at materialization boundaries: with markers moved,
   ordinary defer passes produce no rotation line; each §4 boundary produces exactly one
   rotation line naming its reason.
4. Byte-identical boot replay (V5 product target): two boots with no boundary event serve
   the same region bytes and the same array prefix digest.
5. Single bust permission: a marker move plus queued drops on a defer pass rotates nothing
   and drops nothing; the next boundary pass does both in one bust.
6. Pressure accounting: region bytes are included in the combined estimate feeding the
   force band and the 95% refusal.

Implementation status (2026-11-03): landed as `system-region.test.ts` (store + R11
reader), `system-region-rotation.test.ts` (decision arms + receipts + inert-gate
controls; law 3 named-reason rows), `system-region-serve.test.ts` (laws 1, 2, 8: steady
replay, watcher split, pressure estimate, gate-off, date-freeze containment),
`system-region-fold.test.ts` (law 6 capture==served, gate-off control, legacy-row
replacement, marker atomicity) — 41 rows, each with a verified negative control.
Landed since: `system-region-wiring.test.ts` (16 rows — gate-on head collapse, gate-off
control, `region_first_install`, sentinel-aware replay plumbing, and eight
`regionRotationPromotion` laws incl. ride-only decline and non-trigger preservation);
serve rows for L2 boot-replay (fresh handler on reopened store, byte-identical, zero
bust-schedule sets) and L1 zero-read (instrumented `prepare`: exactly one session_meta
SELECT, zero region/panel-table reads; control: an extra meta read reddens the row);
rotation row for L6 persist-throw (propagates, no executed=true receipt). Remaining:
the pass-level integration of promotion through the real postprocess entry (covered at
the predicate level today) and the Rust lane port.

## 11. What gets deleted

- `prependM0M1Messages` both lanes (`inject-compartments.ts:3346`, `inject-compartments-pi.ts:2553`)
  and the m[0]/m[1] injection call sites.
- `info.syntheticHead` (`tag-messages.ts:243`), `isSyntheticHeadMessage` and its head walks
  (`transform-postprocess-phase.ts:222,253,1293`), the Rust-served head parse
  (`rust-served-m0.ts:37`).
- Part-level `synthetic: true` flags on head parts, `M0_EMPTY_BODY` (TS `:1152`, Rust
  `memory_render.rs:27`) and `M1_EMPTY_PLACEHOLDER` with their empty-head classes.
- The #129 phantom-turn special cases and the ID-less-head carve-out comment arms in
  `plugin/messages-transform.ts:605-618` (the guard itself stays for real persisted rows).
- The head-adjacency special cases in `openai-compat-adjacency.ts` for the leading
  user-user pair, the `cached_m1_bytes` render lane, and the deprecated key-files
  remnants its comments still describe (`system-prompt-hash.ts:403-408`).
- The mural head carriage (`cached_m0_mural_data_url` on the m[0] parts). Owner ruling:
  this deployment never uses the mural, so no tail-part special case is built. If the
  surface is kept at all it is a base64 PNG embedded in the region text blob like any
  other model-readable chunk; stub-or-delete is the preferred minimal-effort candidate,
  decided at implementation.

## 12. Rulings and open items

Ruled by the owner (2026-11-03 review of this document):

1. Mural: no tail-part special case; base64 into the region blob if kept, stub-or-delete
   preferred (§11).
2. Notes: out of scope, confirmed. They ride the nudge lane (`note-nudger.ts`,
   `note-visibility.ts`), not the heads; the work item's panel list was loose.
3. Storage: reuse `session_meta.cached_m0_bytes` as the region BLOB, no new column. Same
   payload, different placement; the persistence layer stays untouched. The coordinator's
   column-hygiene objection was overruled; the reader contract (stored bytes are region
   bytes, never legacy m[0] text) is covered by re-pinned tests instead of schema
   separation: the boot path must prove a row written by the old lane is treated as
   first-render (rotated fresh), not served as region bytes.
4. Triggers: no new rotation trigger; `/ctx-wrapup` is THE user-facing rotation trigger
   (publishes history, an existing `publishedHistory` boundary arm, §4). The earlier
   "dead on compaction-off installs" claim was retracted: those handlers gate on MC's own
   `compaction` config key, not the host's, and are live on this deployment's default
   config. RPC command surfaces stay untouched.
5. Freshness contract: accepted as specified. No new boundary mechanism: rotation reuses
   the merged R12 `systemReclaimAllowed` / `rideSignals` enumeration
   (`transform-postprocess-phase.ts:2042-2081`) as its boundary and bust-permission
   pattern, with the FPE lane as the reference.

6. (Ruled, 2026-11-03) LKG slots survive rotations without a fence (§7.4). A rotation
   pass is by construction a bust pass (the served prefix moves at the boundary), so the
   capture refreshes on that same pass; keeping the durable row across the rotation event
   is consistent with the capture-on-bust cadence and avoids manufacturing a boot-rebuild
   window between rotation and first capture.

Open:
7. ARCHITECTURE.md's `mc:protected` region documents m[0]/m[1] as the head architecture and
   is human-edit-only. After implementation it needs a deliberate human rewrite; the lane
   will flag it rather than touch it.

## 13. Review round 2 (independent design review, baseline e48a34e69)

Three sustained findings, each fixed red-first with an inert-control on its law.

**C3 — region-mode flag omitted at the two top-of-pass decision sites.**
`foldDueDecision` (postprocess) and `protectionFoldWillBust` (transform) called
`mustMaterialize` without `systemRegionMode`, so a valid region row (whose
`cached_m1_bytes` is legitimately NULL) read `cached_m1_missing` on *every*
pass: a standing false `m[0] HARD fold decision: reason=cached_m1_missing
executed=false` receipt (an L7/L9 violation), the fold block executing every
warm pass, and `protectionCacheBustingPass` pinned true — freezing the §7.3
semantics claim on the tunnel side. Both sites now pass the same lane
predicate the serve/fold paths use. Laws run the real sites: a warm-pass
census emits zero `cached_m1_missing` receipts; an execute boundary with a
new memory rotates exactly once with receipts; warm region passes never
report a fold bust to `sessionDecisionCalibration`. Controls: gate-off head
lane keeps its receipts; unthreading either site reddens its law.
(Fix commit: site threading + three laws.)

**C1 — the contracted column had four un-receipted raw erasers.**
Identity merge, session clone, migrations v26/v30 and the compaction-off
transition all raw-nulled `cached_m0_bytes`, and `clearSystemRegion` had zero
callers — making L3's sole-writer and L7's receipted-clear claims false by
not touching the API. The store module moved to `features/magic-context/`
(services layer; features files must not import `hooks/`), gained bulk
variants with count receipts, and now every eraser routes through it with a
named reason (`identity_merge`, `storage_clone`, `migration_v26`,
`migration_v30`, `compaction_off_transition`); clearing an absent row is no
longer an event and leaves no line. The class stays dead via a census
architecture test: any raw `cached_m0_bytes` assignment in the production
tree outside the funnel + fold-row transaction path fails the build
(planted-rogue discrimination verified). Laws also pin post-merge next-pass
repair through the fold.

**C2 — the gate was v1-TS-scoped in fact but not in surface.**
Rust mode: the hook derives `systemRegionLaneActive` (enabled AND
`transform_mode !== "rust"`); the Rust module composes its own m[0] panel
heads and would have double-served panels from two baselines. Cross-lane
readers: the store exports `isSystemRegionBytes`; head-lane
`mustMaterialize`/`prepareCachedM0M1Replay`/`hasCompleteCachedM0M1` treat a
sentinel row as absent (fold rebuilds head bytes — the region is derived
state), and Pi's `decodeCachedM0` refuses it (seeded-sentinel and
materialized-head laws on both sides, inert-guard controls). The schema
describes the v1-TS-only scope; v2 setup and Pi boot log an ignored-flag
warning on the plugin log (log lines, not laws).

## 14. Review round 3 (class-closure review, coordinator-verified)

Round 3 attacked classes, not instances; the adjudicated list and their closures:

- **A1 (eraser class, census strength)** — the census was narrower than its
  "production tree" claim. Two more erasers found at census time: migration v34's
  clears-list and the central baseline-invalidation funnel `clearCachedM0M1`
  (nine production call sites). The funnel now requires a per-CALL named reason
  (compile-time required, structurally pinned by a call-site law); the bulk
  helpers are single-statement atomic UPDATEs (a pre-SELECT + per-row loop could
  undercount the receipt against concurrent writes); the v34 clear is
  column-existence-safe. The census walks TS under `src/`, Rust under `crates/`
  AND the dashboard's `src-tauri/src` (its cache-format reset is a named,
  reasoned external-editor exemption — reader contract self-heals), with
  deny-shape sub-laws per dynamic-SET file replacing instance allow-lists.
  Zero-consumer `clearCachedM0` deleted (obsoletion duty).
- **A2 (reader census)** — `repairMissingHistoryBoundary` read
  `cached_m0_bytes IS NOT NULL` as head-baseline existence: a foreign region row
  presented as a head baseline, and its stale boundary drove an un-invited
  baseline-reset erasure (the v2-reachable column-eraser path). `readBaseline`
  discriminates the sentinel now; laws pin sentinel→intact with the row alive,
  head bytes→baseline-reset as control. Cosmetic L9 guards: the dashboard
  history meter and both status dialogs refuse to render sentinel bytes as head
  text.
- **A3 (trigger-set drift)** — the doc carried the head-lane non-trigger list
  while the code (correctly, per the round-2 discovery) had made the four delta
  fields bust-gated rotation triggers; §4/§5/L3 now state the two-tier set
  honestly. The contract divergence in `decideSystemRegionRotation` (content and
  install arms ignoring `bustPermission`, dead only because the sole caller
  hard-set true) was closed per L4: every arm requires the permission; installs
  are the fold lane's verdict. The L0 census's reason-enumeration row makes a
  code-only trigger an immediate CI failure.
- **A4 (receipt + permission integrity)** — a promoted pass printed
  `reason=unknown executed=false` on the fold line while the rotation line said
  `executed=true` (L8's shape re-entered via promotion), and the earned bust
  never reached `foldBustsServedPrefixThisPass`, so queue lanes could not ride
  the paid pass. The promotion now counts as the pass's fold decision on the
  region lane; the receipt carries the rotation reason, `executed=true`, and
  `bustsServedPrefix=true` (deliberate amortization, owner-endorsed). Laws run
  a real force-band deferred boundary pass; removing the gate reddens the
  executed/bust assertions.
- **L0 (owner law)** — single writer, schedule-only, added above L1, with the
  per-actor producer census `system-region-producers.test.ts`: rotation executor
  single caller, region writer API reachable only from named actors, closed set
  of `pending_ops` writers, `ctx_reduce` enqueue-only through the queue API, one
  bust-permission definition, and every `systemRegion` reason literal drawn from
  §4's enumeration (planted-rogue verified).

## 15. Review round 4 (class-closure, adjudicated F1–F6)

- **F1 (walk-root honesty)** — both censuses walked only `packages/plugin/src`;
  the CLI migrate command raw-nulled the region column outside the walk. The
  migrate clear now routes through `clearSystemRegion` (reason
  `migrate_session`), and both censuses walk the whole production surface:
  plugin src + scripts, `packages/cli/src`, `packages/pi-plugin/src`
  (zone-tagged rels), Rust roots unchanged. Honest scope statements: the Rust
  deny-shapes catch column literals, `ResetValue::Null` reset lists, and
  staged/format! column names — fully opaque runtime-computed names are beyond
  regex and the census comment says so.
- **F2 (evasion shapes)** — planted-rogue-verified: concatenation-assembled
  `"UPDATE session_meta SET " + cols.join(...)` (offends as dynamic SET),
  `INSERT INTO session_meta (…, cached_m0_bytes, …) VALUES (…, NULL, …)`
  (offends outside the funnel's own upsert), Rust reset-list and format!
  shapes (offend outside the two named reasoned exemptions). The clone
  script's dynamic meta SET now excludes the region column and clears it via
  the funnel (sub-law pins both).
- **F3** — the force-band drain row was silently riding the
  `emergencyInputSample === 0` arm at 88%; restored to 96% AND given a
  non-zero sample so the `>= 95` arm is the only thing that can carry it
  (neutralizing either arm individually: red / green respectively).
- **F4 (vocabulary single source of truth)** — §4 now carries a
  ```` ```rotation-reasons ```` fenced list; `system-region-producers.test.ts`
  parses it at test time and asserts set-equality with the code's reason
  literals in BOTH directions (scanned from the decision tables, the
  `decideSystemRegionRotation` arms, the `mustMaterialize` body — head-lane-only
  `cached_m1_missing` excluded with reason — and the `systemRegion:` call-site
  blocks). First run caught real drift: `project_change` existed in code but
  not in the doc. Both drift directions verified red with planted rogues. The
  reviewer's A3 minor (promotion `boundaryPermission` broader than the prose
  list) is aligned by pinning §2's boundary definition to the predicate that
  is the code's authority.
- **F5 (queue-copy member)** — clone semantics ruled: row-copy of
  already-queued intent, not new intent — `scripts/clone-session.ts` joins the
  closed `pending_ops` writer set as a named member (generic table copy);
  `scripts/bench-store-generation-rebase.ts` joins as the dev-fixture seeder.
  Boundary drain remains the only applier.
- **F6** — both status dialogs import `isSystemRegionBytes` instead of
  hardcoding the sentinel; `markersFromCachedPiRow` and
  `prepareCachedM0M1PiReplay` refuse region rows (the replay path had been
  serving `"" + m1` behind `decodeCachedM0`'s refusal). Law with
  guard-neutralized control.

## 16. Review round 5 (adjudicated G1–G7)

- **G1 (wire defect)** — `replayCompletePiPrefix` served `decodeCachedM0() ?? ""`
  (empty head + m[1] tail) for a region row when materialization lost the lock 3×
  with `allowFreshContentionFallback` off; both contention-fallback callers gated on
  truthiness only. Fixed at both layers: callers discriminate with
  `isSystemRegionBytes` before replaying; the reader throws on region/undecodable
  bytes as the structural floor. Laws: forced-`BEGIN IMMEDIATE` contention over a
  seeded region row serves the fresh head; exported reader-refusal law; predicate
  row. Control (transcript): neutralizing the caller conjunctions reddens the first
  law through the reader's throw.
- **G2** — (a) the per-call receipt-naming census walks all four zones now
  (planted-rogue in `cli/src` caught/removed). (b) The round-4 report claim that
  funnel validation rejected malformed reason tokens was **false at HEAD** — it was
  a test-time-only property. Correction + fix: `requireReasonToken` throws at all
  four funnel entries on any token outside `[a-z][a-z0-9_]{2,47}` (L7 fail-loud).
- **G3** — the `UPDATE session_meta SET` fragment is census scope by itself: the 21
  production holders form a closed named set (per-file reason; the set doubles as
  the session_meta writer census); identifier-led `prepare(<ident> + / .join(`
  assembly in a session_meta file offends. Planted-rogues: const-split and
  array-join-split both caught. Honest boundary (corrected in round 6, §17): the
  census deters accidental and semi-deliberate shapes; character-wise assembly
  AND multi-hop computed fragments (identifiers rebound through helpers before
  reaching `prepare`) are beyond regex — disclosed here and in the census
  comment, same class as the Rust zone. The dominant close is the closed named
  set: any file holding the fragment (whole or split at any single string
  boundary) without a named exemption offends regardless of what it assembles.
- **G4** — `DELETE FROM ${…table…}` arms added to the pending_ops census matcher;
  storage-session-tables (teardown), clone (copy), identity-merge (relocation),
  opencode2-relabel (static rule list, shape-inclusive) join as named reasoned
  members. Row carries the blind-class disclosure (variable table names,
  schema-qualified forms, out-of-root zones).
- **G5** — §4's fence restated as a synchronized review vocabulary (bi-equality;
  authority for review language; consistent renames stay green by design). Scanner
  blind classes: template-literal composites captured by stem (`render_config`,
  added to the fence — 25 members), variable-passed reasons resolved through an
  explicit map (unmapped = red), fence duplicate check. Controls executed both ways.
- **G6** — the force-drain arms are pinned permanently: `>= 95` arm row (96% +
  non-zero sample), sample-arm-alone row (88% + sample 0), neither-arm row (88% +
  non-zero sample, defer: rows stay queued). Standing rule adopted: controls
  reported = controls committed or transcripted.
- **Corrections pass** — the round-4 §15/F4 text's funnel-validation implication is
  superseded by G2's runtime throw; the round-4 style commit additionally touched
  five pre-existing test files with formatting-only (semantics-null) changes,
  verified at review.

## 17. Review round 6 (adjudicated H1–H4)

- **Execution disclosure** — the round-6 reviewer's session host denied test
  execution: all round-6 verdicts (K3/K4/K5 verified-clean, K7, H1–H3 sustained)
  are STATIC analyses. The implementer's re-runs are the only executed evidence
  this round; "verified-clean" for K3/K4/K5 means source-verified, not
  test-executed by the reviewer.
- **H1 (fold-lane wedge, introduced by round 5's G2b adjudication)** — the
  `requireReasonToken` throw was reachable with STORE-derived content: the budget
  arm minted `render_config:budget(<stored>→<current>)` from
  `cached_m0_upgrade_state` (arbitrary text between `|` delimiters); a
  whitespace operand re-minted and threw every pass, and only a successful fold
  rewrites the row — permanent wedge. Fixed at the MINT: `sanitizeReceiptOperand`
  (whitespace→`_`, backtick→`'`, 40-char clamp with visible `~`) keeps the funnel
  throw a pure typo detector. Laws: corrupt stored operand → fold proceeds,
  receipt carries the sanitized token, row self-heals; shrink arm pinned
  parser-gated (its operands must match `^m\d+(\.\d+)?-h\d+$` to mint at all).
  Controls: neutralizing the sanitizer reddens the wedge law (transcripted).
- **H2** — SET-less fragment rule (`"UPDATE session_meta"` closing its quote
  before SET, co-occurring with `+`/`.join(`/`.concat(`) + widened
  identifier-led verbs (`run|all|get|iterate`) and `.concat(`. Three
  planted-rogues with split column names (assignment text never appears as
  literal): two-way fragment split → identifier-led; concat → SET-less rule +
  identifier-led; `db.run(variable)` → closed-set fragment rule. The "cannot
  hide" claim corrected to deterrence wording; disclosed-uncoverable class now
  names character-wise AND multi-hop computed assembly, matching the census
  comment (§16's G3 line updated in place).
- **H3 (property closure)** — `trimPiMessagesToCachedBoundary` truth-tested
  m0/m1 and trusted the head-era boundary column; region installs never touched
  it. Closed at the write site (install nulls the head-era boundary) and
  defensively at the reader (sentinel refusal at the `stored` aggregate covering
  both read paths). Enforced property, to be checked by future closures: **no Pi
  path derives wire-affecting decisions from region rows unguarded** — a
  property, not a caller list. Controls transcripted: write-site removal reddens
  the boundary assertion; reader-guard removal reddens the trim-zero assertion.
- **Brief corrections** — the round-5 commit range is 7 commits including
  `a9d6fffe9` (the brief's count was wrong); the postprocess test base pins
  `forceMaterializationPercentage: 85`, not 70 (the reviewer's own correction,
  accepted).
