# First Rust-mode seed cost after the single-store migration

## Reproduction and performance fix

Measured on 2026-09-30 with Bun 1.4.2 using `bun --cpu-prof` and direct
`buildModuleStateSyncPayload` calls, fresh sender state, `force: true`, and
inventory `{ boundaryId: null, contextBoundariesResolved: false }`. APFS `cp -c`
cloned context.db (7.0 GiB), opencode.db (32 GiB), and their WAL/SHM files into
`$TMPDIR/magic-context/seed-cost/pool-1193/`. Free space was 188 GiB before
cloning, comfortably above the 20 GiB reserve. OpenCode was opened read-only;
context writes, profiles and payload captures stayed in the throwaway root.
`lsof` confirmed the profiler and isolated module never opened a live store.
The incident log was read in place, not copied.

The top five sessions by tag count, joined through `session_projects` and the
cloned OpenCode session directory, were all fleet projects:

| Project / session | Tags | Before payload ms | After payload ms | Raw messages before → after |
| --- | ---: | ---: | ---: | ---: |
| MC / `ses_331acff95fferWZOYF1pG0cjOn` | 195228 | 367309.6 | 914.4 | 147367 → 416 |
| AFT / `ses_313660571ffeZTsf4koSJwk50Q` | 148121 | 285963.6 | 832.7 | 134427 → 460 |
| ALF / `ses_227ce5788ffeRPA9THoPLOQreO` | 121956 | 307399.8 | 806.8 | 122381 → 654 |
| SUBC / `ses_12a4fa38dffe81Fz7Y2AsWb5Cg` | 95582 | 2634.8 | 238.8 | 83939 → 1172 |
| BROCA / `ses_114f158ccffet7znXAgI7lc3Kp` | 61783 | 39902.6 | 386.5 | 50574 → 1832 |

Wall times measure assembly, not process startup or writing the captured JSON.
Two independent baseline processes ran concurrently; the five-session after
profile ran sequentially. These are snapshot measurements, not extrapolations
from the incident's 134431-message count.

### Measured root cause

The dominant cost was **not canonical JSON or block mapping**. In the combined
AFT/ALF CPU profile, native SQLite `get` self-time was 537567 ms; 536751 ms was
under `readRawSessionMessageOrdinalByIdFromDb → endpoint`. Resolving each
compartment's two endpoints rescanned session history. SQLite `all` self-time
was 51068 ms, including 46942 ms in the unbounded raw seed-tail query and
3505 ms in dropped-tag collection. JSON parsing contributed 2957 ms;
canonical JSON and block mapping contributed only 51 ms and 45 ms respectively.
The other baseline profile attributed 376222 ms to endpoint ordinal scans.

The fix reads the message-ID ordinal map once per boundary resolution and
caches endpoint parts by message ID. Payload assembly resolves shared boundaries
before reading seed data. With no module boundary, it uses the persisted
OpenCode compaction marker's **boundary message**, not its later summary target,
to bound seed eligibility. The marker row remains included. Existing module trim
boundary semantics are unchanged: filtering hidden host seeds does not itself
authorize dropping the module's cached prefix. Raw block mappings are reused per
owner, and canonical drop-seed JSON is computed once per candidate, not inside
sort comparisons. Existing SQL JSON-set filters now receive only visible-tail
addresses rather than all historical parts.

All five after profiles completed under one second; the AFT two-second assembly
budget is met. The after profile's largest native self-time totals across all
five sessions were raw-tail `all` 977 ms, ordinal-count `get` 567 ms,
ordinal-map `all` 410 ms, endpoint parts `all` 256 ms, and dropped-tag reads
258 ms. No chunk yielding was needed after removing repeated scans.

### Equality and regression evidence

Captured before/after payloads were compared using independently selected raw
eligible IDs. All post-boundary drop, pending-drop, hint, strip and note-anchor
seeds were canonical-JSON identical, including order, for all five sessions.
Resolved compartment boundaries, module trim boundary, watermarks, todo state,
emergency state and pending compaction markers were also identical. AFT/ALF
have no eligible drops in this snapshot; MC/SUBC/BROCA have respectively
37/606/1692 drops, 284/410/110 pending drops and 68/228/419 hints.

Synthetic tests cover 100000 messages/tags with a null inventory and published
host marker (two eligible messages, one raw query, assembly below 2000 ms), and
2000 legacy compartments over 100000 messages (one ordinal-map read and two
unique endpoint-part reads). Forced payload timing logs `rust.state_sync_detail
phase=seed` in a finally block before transport, even when assembly fails;
the full pass continues to log `phase=pass` in its existing finally block.

Mutation controls proved the guards fail: neutralizing the marker fallback
failed only `cold inventory bounds 100K-message seeds at the published host
marker` (27 others passed); restoring per-endpoint ordinal scans failed only
`large legacy compartment history reads the ordinal basis once` (4000 reads
instead of 1; four others passed). Each mutant was staged safely against the
live implementation, showed a nonempty diff, and was restored to an empty
working diff before further checks.

Plugin typecheck passed. Seed/boundary/Rust-mode tests passed (168 tests), and
seed/boundary/prefix-trim replay tests passed (36 tests). Changed-file Biome
checks passed. Full plugin lint initially found an unrelated existing formatter
error in `scripts/self-tag-trial/host-plugin.mjs`; its formatting is handled
separately. Pure replay differential against the staged implementation returned
`RESULT IDENTICAL defer_passes=4`, with every capture byte-identical.

## Additional first-pass probes (boundary refusal under investigation)

A second disposable context clone backed an isolated ck-subc/ck-mc pair, with
historian production disabled and teardown in finally. Real inventory requests
and forced `syncModuleState` were measured; no host SDK Todo RPC was attempted
because no OpenCode service was started. Local persisted Todo reads were
0.04–0.22 ms.

| Project | Boundary resolver ms | Inventory RPC ms | Whole forced sync ms | Result |
| --- | ---: | ---: | ---: | --- |
| AFT | 488.6 | 11.0 | 763.8 | boundary refusal |
| ALF | 4116.4 | 161.6 | 2228.3 | boundary refusal |
| MC | 2841.8 | 279.8 | 2156.0 | acked |
| SUBC | 31.5 | 37.9 | 2013.3 | acked |
| BROCA | 946.7 | 51.7 | 930.6 | acked |

These timings include real transport and module work and are not the assembly
budget measurements above. The module rejected AFT and ALF with
`state_sync_seed_boundary_mismatch: invalid host-resolved context boundary`.
The original before-fix AFT payload reproduced the identical rejection, proving
it is not introduced by the seed-cost change. Investigation and a separate
boundary fix are required before declaring the fleet restart safe.
