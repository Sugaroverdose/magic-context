# Frozen system-region residency for store-backed panels

Status: **reviewed, owner rulings recorded (§12).** The decisions in §3 through §8 are law
for the implementation. Two items remain open with the proposed default in force (§12.6,
§12.7). Step 2 (durable-slot honesty) is authorized to proceed.

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

## 1. Problem

The heads are built in `inject-compartments.ts:3303` (`prependM0M1Messages`) as
`role: "user"` with `info.syntheticHead: true` and part-level `synthetic: true`. The
user-role wrapper exists only because the April 2026 host pipeline forces it: OpenCode's
`toModelMessagesEffect` filters on `ignored` (not `synthetic`), and the title-generation
gate counts any non-all-synthetic user message as a real turn, which is the #129
phantom-turn fix documented at `inject-compartments.ts:3310-3321`.

The measured costs (work item, live install):

1. A panel-store edit (profile, memory, docs, compartment publish) rotates the array-head
   bytes. The provider cache busts from array token 0 with no fold and no log line: the
   pass reports `reason=unknown executed=false` at the fold-decision receipt
   (`transform-postprocess-phase.ts:2018`). There is no fold, so nothing prices or records
   the bust.
2. Authority confabulation: the model attributes panel content to the user (Nov 2
   delete-confabulation quoted the `<user-profile>` block). A user-role wrapper is an
   authority lie the panel should never have carried.
3. Role-keyed breakage. Every role-or-position-keyed guard in the pipeline must know about
   the fake heads: `isSyntheticHeadMessage` head walks
   (`transform-postprocess-phase.ts:222,253,1293`), the Rust-served head parse
   (`rust-served-m0.ts:37`), the ID-less-head carve-out in the `IncompleteUserMessageError`
   guard (`plugin/messages-transform.ts:605-618`), and the empty-fake-user-turn provider
   rejections.

The system channel is the proven alternative, but only for byte-constant content: the
handler appends the MC guidance block to `system[0]` at `system-prompt-hash.ts:396`, and any
mutable byte in `output.system` trips the whole-content hash watcher
(`system-prompt-hash.ts:491-519`), which schedules a flush and fold on every change. That
watcher behavior is exactly what must change: constant bytes re-anchor immediately,
store-backed bytes rotate only at boundaries.

## 2. Definitions

- System region (P): the store-backed panel bytes, one string: `<project-docs>`,
  `<user-profile>`, `<project-memory>`, `<session-history>` (decay-rendered compartments),
  plus the delta blocks that m[1] carries today (`<memory-updates>`,
  `<new-compartments>`, `<new-memories>`, `<new-user-profile>`). Assembled from
  `context.db` at rotation time and stored per session.
- Host-guidance segment (H): the host prompt + the MC guidance block appended at
  `system-prompt-hash.ts:376-401` + the sticky date line. Mutable only by re-anchor events
  (build upgrade, guidance/AGENTS source edit, prompt-surface or ctx_reduce verdict settle).
- Rotation: replacing the stored region bytes with a fresh assembly. A rotation is a cache
  bust at the region start: everything after H is re-cached.
- Materialization boundary: a pass that is already busting the served prefix for a
  legitimate reason (§4). Only these passes may rotate.

## 3. Frozen region contract

Serve path (boot and live): read the stored bytes and append them after H in `system[0]`.
No store reads, no re-assembly, no re-tiering, no budget re-decisions on the serve path.
The never-re-decide-at-serve rule (the `drop_mode` lesson) applies: the region's shape was
decided at the rotation that captured it.

The append stays inside `system[0]` rather than a second array entry, for the reason pinned
at `system-prompt-hash.ts:389-395`: OpenAI-compatible serializers emit one wire message per
entry and strict chat templates reject a second system message.

Boot after a panel-store mutation must serve the stored bytes even though the markers have
moved. Post-restart rotation is illegitimate by definition; the user ruling. A restart is
not a boundary. The trigger list in §4 is event-keyed, never boot-keyed. When a restart
does coincide with a real boundary (idle past TTL with `lastResponseTime` newer than the
last rotation), the rotation rides the TTL arm, not the restart.

## 4. Rotation boundaries

Rotation is ride-only. It never originates a bust (invariant 4 of ARCHITECTURE's load-bearing
list). A pass may rotate only if it is already busting for one of these reasons, which are
today's `mustMaterialize` HARD trigger set (`inject-compartments.ts:1754-1954`) with the
m[1]-specific members removed. The mechanism is not invented here: rotation eligibility
cherry-picks the merged R12 system-reclaim boundary law, the `rideSignals` enumeration and
`systemReclaimAllowed` predicate (`transform-postprocess-phase.ts:2060-2107`: hardFold,
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

Genuine content or config change, the region bytes must change anyway:

- first render (no stored region yet; covers the upgrade boot: heads vanishing from the
  array is itself a bust, so the first rotation is free),
- structural compartment mutations (`max_mutation_id`, `:1947-1949`),
- `project_memory_epoch` (dashboard or external mutation, `:1909-1924`),
- render-config changes: `compartment_render_epoch`, `render_config:*` budget/mural arms
  (`:1790-1826`).

Pressure backstop:

- the force band (about 85%) rotates when markers have moved, mirroring
  `forceMaterialization` today,
- the pending-growth refold gate: when the not-yet-visible delta (new memories past the
  captured watermark, unpublished compartments, profile additions, docs drift) exceeds the
  existing m[1] absolute cap (about 20% of the history budget, with a small-region floor)
  or the large memory-mutation count, rotation is due; it lands on the next pass that is
  busting anyway, and the force band is the guarantee it eventually lands.

Explicit non-triggers, preserved deliberately (they are marker moves, not boundaries): a new
compartment sequence, `project_user_profile_version`, `maxMemoryId`, project-docs hash drift,
tool-set hash (`:1853-1856,1925-1946`). They mark the region rotation-pending and change no
bytes this pass.

No new user-facing rotation trigger is designed. The operator's rotation trigger is
`/ctx-wrapup` (owner ruling): wrapup publishes history, and the published-history signal
is a R12 `rideSignals.publishedHistory` arm (`transform-postprocess-phase.ts:2076-2082`),
so a wrapup pass is a rotation boundary (`publishedM1RefreshedThisPass`). Wrapup's shipped
semantics (imports sessions MC does not manage yet, or wraps up when the context window
became smaller) already reach this arm on installs that leave MC's own `compaction` config
key unset, which is the shipped default here. The RPC command surfaces are untouched by
this lane.

## 5. Rotation markers (the generalized profileVersion pattern)

Today the per-panel store-version watermark pattern is `renderM1`'s profile gate
(`inject-compartments.ts:2983-3002`): `getGlobalUserProfileVersion(db)` versus the captured
`markers.projectUserProfileVersion` decides whether the `<new-user-profile>` delta renders.
The generalization: every panel in the region carries a store-version marker captured with
the region bytes at rotation, and rotation eligibility is "any marker differs from the
stored set":

| Panel | Marker (existing) |
|---|---|
| user profile | `cached_m0_project_user_profile_version` |
| project memory | `maxMemoryId` + `memory_mutation_log` high-water (`cached_m0_max_memory_mutation_id`) + `project_memory_epoch` |
| session history | `cached_m0_max_compartment_seq` + `cached_m0_max_mutation_id` |
| project docs | `projectDocsHash` (stored with the rendered bytes) |
| budgets/config | `renderBudgetIdentity`, `compartmentRenderEpoch`, `upgradeState` |

All of these already exist as `session_meta` columns written by the m[0]/m[1] machinery
(`readCurrentM0SnapshotMarkers`, `inject-compartments.ts:1576`; `CachedM0M1Row`,
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
consumer of the R12 `systemReclaimAllowed` predicate (`transform-postprocess-phase.ts:2100-2107`),
not a parallel gate. Every mutation
lane (queued `ctx_reduce` drops, age sweeps, heuristics, synthetic todo, sentinel
first-application, and now rotation) consults the same permission; a veto that applies to
one lane and not another remains a defect (the ALF split-bust precedent). The
`compartmentRunning` veto keeps its emergency bypass: a boundary that is already busting
(force band, re-anchor, or the fold-executed predicate) bypasses the veto and drains the
rotation into the known bust (drain-into-the-known-bust invariant, unchanged).

### 7.3 Pressure accounting for system-resident bytes

The array tokenizer no longer sees panel bytes; the served-system estimate already does.
The hash handler estimates the full served system content and persists it as
`sessionMeta.systemPromptTokens` (`system-prompt-hash.ts:537-547`), and
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
- Boot-cache-bust honesty (landed, prerequisite step 2, commit `a49c8611e`): the observed
  wipe (22 chunks to 0 rows, `captured_at` reading NULL, zero `lkg_capture_declined`
  lines) was reproduced red-first and closed at every silent path. `captureSlot` and the
  durable writer now share `lkgSlotStructuralRejection` (`lkg-slot.ts:381-395`, reasons
  `empty_prefix`, `missing_anchor`, `invalid_captured_at`), so a slot that
  `parsePersistedLkgSlot` could never read back is refused before install;
  `saveLkgSlotToDb` (`lkg-persist.ts:216`) runs the same pure check before its
  chunk-deleting transaction and logs `lkg_persist_declined`; `dropSlot` emits
  `lkg_slot_dropped reason=...` (`lkg-slot.ts:572`); `loadPersistedLkgSlot` names its
  parse-failure clear (`lkg-persist.ts:376`); `captureLkgSlot` logs
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
(`transform-postprocess-phase.ts:2018`):
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

## 11. What gets deleted

- `prependM0M1Messages` both lanes (`inject-compartments.ts:3303`, `inject-compartments-pi.ts:2553`)
  and the m[0]/m[1] injection call sites.
- `info.syntheticHead` (`tag-messages.ts:243`), `isSyntheticHeadMessage` and its head walks
  (`transform-postprocess-phase.ts:222,253,1293`), the Rust-served head parse
  (`rust-served-m0.ts:37`).
- Part-level `synthetic: true` flags on head parts, `M0_EMPTY_BODY` (TS `:1149`, Rust
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
   (`transform-postprocess-phase.ts:2060-2107`) as its boundary and bust-permission
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
