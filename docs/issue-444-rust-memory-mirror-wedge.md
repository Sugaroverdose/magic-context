# Rust memory-mirror wedge diagnosis and repair

## Diagnosis

### Findings

The proposed deadlock is not the source shape in this tree. The memories mirror has two normal triggers:

| Trigger | Production call site | Requires a successful memory mutation? |
| --- | --- | --- |
| Every successful Rust transform whose memory projection is not acknowledged | `packages/plugin/src/hooks/magic-context/rust-mode-transform.ts:3650` → `pullMemoryMirrorOnce`; `packages/plugin/src/features/magic-context/context-authority.ts:2486` → `drainMirrorPages` | No |
| Successful module memory facade mutation | `packages/plugin/src/hooks/magic-context/hook.ts:991` → `syncModuleMemories`; `hook.ts:858` → `drainMirrorPages` | Yes |
| Memory-expiry maintenance | `packages/plugin/src/features/magic-context/dreamer/expire-memories.ts:117` → `drainMirrorPages` | Yes, maintenance-triggered |

`drainMirrorPages` itself is at `packages/plugin/src/features/magic-context/context-authority.ts:2442`. `authority.status` does not pull a mirror page.

Before this repair, a transform drain used the default page size of 100, not 1,000. The bounded pass was therefore 20 × 100 = 2,000 feed records. A move from 1,726 to 3,726 is the exact signature of one exhausted pass, not evidence that a 20,000-row budget stopped early. Source and the pre-existing budget regression both show that an exhausted pass does not stamp the projection and is eligible on the next successful transform.

The interruption paths that `drainMirrorPages` can produce are:

- page-budget exhaustion: returns `complete: false`; the next transform retries;
- module/page rejection, reconnect, or host SQLite apply error: rejects the flight; the `finally` path releases the flight and the next transform retries;
- process restart: loses the in-memory projection acknowledgement, so the first successful transform retries from the durable cursor;
- a producer page with `has_more=true` and no cursor movement: returns incomplete rather than spinning; later transforms retry, although only producer repair can make that cursor move;
- an indefinitely pending page is not an expected state because the module transport has a bounded request deadline.

The injected page-failure and budget-stop regressions both resumed on the next transform. A deterministic SIGKILL between the real module's 1,000-row pages was not available without adding a production fault seam; the real 2,505-row activation completed three pages in one bounded ride-along. The hermetic test instead exercised a source-confirmed freeze that the old projection key allowed: after a complete drain, a module-owned memory write which did not alter the rendered memory IDs or session row version advanced the memory changefeed but left the host projection key unchanged. Subsequent healthy transforms did not pull. The repaired module publishes the memory feed head on every transform, so that append changes the key and the next transform catches up.

The exact reported 3,726 freeze cannot be uniquely assigned from the supplied values because `MAX(memories.id)` is not the mirror frontier; `MAX(mc_changefeed.feed_seq)` is. The 2,000-record delta identifies a budget stop, but this source would retry it. The additional hidden-feed append mechanism is executable and did freeze the old key, but the report did not record the module feed head or per-pass mirror trigger. Those two candidates cannot be separated retrospectively.

### Why reads returned MC-C02

`authority.status` is not a separate runtime authority cache. `crates/mc-module/src/lib.rs` handles it by reading `mc_authority` through `authority_status`, so the persisted row and a successful query for the same `{context_store_uuid, project, domain}` cannot disagree.

The real-module harness reproduced the refusal with `mc_authority=MODULE` and a complete mirror. The host authority probe returned MODULE and entered the module facade. OpenCode 2's route used the `opencode2` harness label, but the facade's transform-provenance bypass recognized only `opencode`. It therefore tried `session.resolve` before serving a project-scoped read; that resolver timed out after two seconds. The host mapped the facade failure to MC-C02 (and a write to MC-C01), which made a durable route defect look transient. Thus reads were not gated on mirror completeness and were not refused by a second live authority state. They were blocked by session resolution after authority had already routed them module-side.

Both OpenCode harness labels now accept the same server-observed transform provenance. Project-scoped reads and writes use that proven session without waiting for `session.resolve`; authority routes alone remain insufficient so they cannot rebind a known project to a second root. Reads are served from the module, never from the partial host mirror. A returned host-marker/module-authority mismatch is separately surfaced as MC-M02 instead of being described as a momentary sync.

## Repair

- Transform responses now carry `memory_mirror_head`. The host includes it in the projection key, so a hidden memory feed append re-arms the bounded transform ride-along. Incomplete/error paths remain unstamped and retry as before.
- The normal page limit is now 1,000, retaining the 20-page cap while covering 20,000 feed rows per pass.
- The stable frontier path performs no `mirror.pull`. The regression runs three stable passes, observes an unchanged cursor timestamp, and pins identical served bytes for identical defer input. Hermetic steady passes measured 6.9–16.5 ms total with `mirror_pull:0.0 ms`; no page fetch was issued.
- Module `session.status` includes memory feed head, module live-row count, last observed host cursor, cursor age, pending rows, and MC-M01 stalled state. Module health exposes the same atomics-only status and degrades after 40 seconds when live rows exist and the observed host cursor remains behind the feed head.
- Host `/ctx-status` compares `context.db` cursor/timestamp/live rows with the module feed head. It emits MC-M01 only when the cursor is behind and at least 40 seconds old, so a completed old cursor and a slow advancing drain read differently.
- `/ctx-status` also compares the host authority marker with module session-status authority and emits MC-M02 for a durable mismatch. `ctx_memory` routes a returned null/TS state with a managed marker to the same non-transient code.
- `doctor drain-authority` now clears project rows from `mirror_live_memory_rows` after memories return to TS ownership. TS-authority memory reads do not consume this table, but leaving it populated could contaminate the next mirror generation's identity/live-row checks; activation's resnapshot swap clears it only when a new live snapshot is installed, not at every authority transition.
- No schema or store migration was added. Store fences remain unchanged. Pi has no Rust adapter, so no Pi code was changed.

## Executed evidence

- Real module, 2,505 host memories: authority activation produced a 2,505-record memory feed and drained it over three 1,000-record pages.
- A direct module write advanced the feed from 2,505 to 2,506 while the host cursor remained 2,505. The next transform advanced the host to 2,506.
- Three subsequent samples were `[{cursor:2506, updated_at:1789411531973}, {cursor:2506, updated_at:1789411531973}, {cursor:2506, updated_at:1789411531973}]`. Module status reported `feed_head=2506`, `host_cursor=2506`, `stalled=false`; its host-cursor observation timestamp was also unchanged, proving that no no-op page fetch occurred.
- The same hermetic session then completed `ctx_memory get` and `ctx_memory write` through the host tool without MC-C01, MC-C02, or MC-M02.

## Gates and mutation checks

Gate commands and mutation evidence are recorded in the delivery declaration. The hermetic regression command is:

`bun test --timeout 600000 --max-concurrency=1 tests/rust-memory-mirror-resume.test.ts`
