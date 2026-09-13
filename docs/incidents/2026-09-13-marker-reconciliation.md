# Restart marker reconciliation and unpriced wire mutation

## Q1: lookup execution and limits of the historical evidence

**The historical four-false result is not reproduced against the copied store. Its exact cause remains unproven.** A different resolved store in the second OpenCode process remains plausible; a swallowed `SQLITE_BUSY` is not consistent with this source's control flow.

The investigation used APFS clones of `~/.local/share/opencode/opencode.db` and `~/.local/share/cortexkit/magic-context/context.db`, plus copies of their WAL files, in the task worktree. No live database was opened read-write. These are post-incident copies, not an atomic pre-incident snapshot. The current resolver printed:

```
path=/Users/ufukaltinok/.local/share/opencode/opencode.db
source=discovered channel=null
mode=readonly immutable=unset journal_mode=wal
```

The exact `SELECT 1 FROM message WHERE id = ? LIMIT 1` / `SELECT 1 FROM part WHERE id = ? LIMIT 1` queries used by `checkCompactionMarkerConsistency` returned:

| Field | ID | Raw `.get()` |
|---|---|---|
| boundaryMessageId | msg_0953a3916001qs3EQPXeyNMMFT | `{"1":1}` |
| summaryMessageId | msg_0953a3917001V273FwqoEj88dz | `{"1":1}` |
| compactionPartId | prt_0953a39160017VhxyxUk7yc0g4 | `{"1":1}` |
| summaryPartId | prt_0953a3917002faM3iahnGNVJoT | `{"1":1}` |

**The row identity is confirmed, not inferred from the summary text.** In copied context.db, `SELECT * FROM tags WHERE tag_number = 172658` returned session `ses_331acff95fferWZOYF1pG0cjOn`, message_id `msg_0953a3917001V273FwqoEj88dz:p0`, status `active`. The marker's message time_created is `1789210016023` (Sep 12). The tags row has no created-time field. A tag minted on Sep 13 does not imply its source message was created on Sep 13. There were no summary parts containing `Compacted by magic-context` with time_created between Sep 13 08:00Z and 11:33:32Z in that session, but that does not refute the confirmed tag-to-Sep-12-message mapping.

Copied session_meta initially had an empty marker state for this session; there is no session_meta history table in that copy. The four IDs above were recovered from the message/part relations and the tag, not claimed as a recovered historical state blob. For a full-function execution, only the local copy's row was populated with those recovered IDs (ordinal=1 as an explicit probe placeholder); `checkCompactionMarkerConsistency` preserved its JSON byte-for-byte. This is not a reconstruction of the missing historical ordinal/state history.

### Separate-process WAL experiment

On the **23 GB local copy**, a writer process ran `PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0`, inserted two probe message rows and two probe part rows in a committed transaction, and stayed open while a second Bun process ran the exact readonly existence queries. Results under Bun 1.4.2:

| Reader | shm permissions | Message results | Part results | Exit |
|---|---|---|---|---|
| `new Database(path, {readonly:true})` | 0644 | `[{"1":1},{"1":1}]` | `[{"1":1},{"1":1}]` | 0 |
| `new Database(path, {readonly:true})` | 0444 | `[{"1":1},{"1":1}]` | `[{"1":1},{"1":1}]` | 0 |

For the query-only comparison the writer checkpointed again, then updated all four rows to time_updated=2 without checkpointing. Separate readers using `new Database(path); PRAGMA query_only=ON` returned `{"time_updated":2}` for all four rows, with both 0644 and 0444 shm permissions (exit 0). An initial attempt to use `{readonly:false}` was rejected by Bun with `SQLITE_MISUSE: flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE`; the corrected rw constructor above succeeded. No such error became an absence result.

This refutes the proposed silent checkpoint-only view for these reproduced readonly/shm conditions on the available runtime. It does not reconstruct the dead process's runtime, environment, directory permissions, or database path.

### Source findings and missing launch evidence

- `packages/plugin/src/shared/opencode-db-path.ts::resolveOpenCodeDbPath` honors OPENCODE_DB, XDG_DATA_HOME and channel variables. Discovery sorts candidates by **mtime**, with candidate order only breaking ties. `magic-context.db` is not a candidate; cwd does not participate in path resolution. A missing/zero-byte DB with no message schema would throw at prepare, not generate four false results.
- Marker injection/removal's `getOpenCodeDbPath` delegates to that same resolver. Discovery still does not establish the server's writer identity.
- `packages/plugin/src/hooks/magic-context/compaction-marker-manager.ts::checkCompactionMarkerConsistency` had no per-query error swallow. An open/prepare/get failure exits through an outer catch rather than reaching the clear branch.
- Parent clarification: pid 98006 was a **second OpenCode instance**, not the serving process (81975); it opened in `~/Work/orw` and `~/Work/OSS/opencode` and logged resolved-config fetch failure. Its environment/launch command and a pre-boot context.db snapshot are unavailable. Therefore there is no honest way to prove its resolved target from the staged logs alone.

## Q2: why the served summary disappeared

`packages/plugin/src/features/magic-context/compaction-marker.ts::removeCompactionMarker` uses direct SQLite DELETEs, **not the OpenCode API**. It returns true when the transaction succeeds even if every DELETE affected zero rows. The log's cleanup success is not evidence of deleting the serving database's rows, nor of mutating an API-only in-memory session.

`packages/plugin/src/hooks/magic-context/transform-postprocess-phase.ts::reconcileMarkerRepresentation` removes every `info.summary === true` message, drops stale summary tags, and reconstructs only the persisted winner. Before this fix, null state returned immediately after removal. Thus the boot state clear alone makes this transform strip the summary even when the original OpenCode row survives. Both the ordinary postprocess and Rust-host postprocess invoke this reconciler.

The staged `all-26-clears.txt` shows the clear at 11:33:32.830Z for this session; the staged log identifies a defer pass at 11:33:45. The 11:33:36 wire still contains tag 172658; the 11:34:01 wire lacks its assistant separator, permitting the first raw user message to merge with the synthetic head. The latter response reports cache_read=275610 and cache_creation=373240, against previous input total 648406. This is a transform-side wire mutation independent of whether the best-effort DELETE reached any row.

## Fix and contract changes

1. Startup reconciliation is now **diagnostic-only**. Missing rows, ambiguous writer identity and errors retain state and surviving rows. Logs include path, resolution source, readonly/WAL-aware mode and the explicit reason destructive reconciliation is skipped. Startup never has cache-busting permission, so no absence result can authorize deletion there. Existing priced publication drainage remains responsible for marker replacement.
2. A logical marker clear retains the previous state inside a `deferredClear` JSON envelope in the existing marker-state column. Ordinary state readers still return null (the envelope has no top-level marker fields); the transform can replay its previous marker durably even if OpenCode stops including the summary row. No schema migration is required.
3. The normal TypeScript lane retires this replay only under its existing `isCacheBustingPass` permission; the Rust-host lane uses a materialized boundary as its permission. A subsequent real marker publication replaces the tombstone through the existing priced drain.
4. The consistency tests intentionally no longer claim that startup clears missing markers: that behavior was the defect. The off-transition interruption test still asserts notice intent precedes the first durable logical clear; its trigger now recognizes both the old empty-string representation and a deferred-clear envelope. The safety claim was retained, not inverted.

Regression coverage includes a deliberately lying four-false reader over a WAL store containing all rows, SHA-256 equality of complete message arrays across defer/clear/defer with the summary absent from incoming arrays, a new-tagger replay, priced clear followed by defer, and cleared/non-cleared variants of the actual deferred marker advance/drain sequence.

## Q4: Pi twin

Refuted for the boot reconciliation shape. `packages/pi-plugin/src/compaction-marker-manager-pi.ts::applyDeferredPiCompactionMarker` reads native branch entries and calls appendCompaction on the deferred drain; it does not open OpenCode SQLite or perform a startup four-row check. `findLatestCompactionFirstKept` examines native compaction entries. No Pi-specific source changes were needed. The complete Pi suite was run because the storage helper is shared.

## Q5: blast radius from available response dumps

The staged log contains **26 distinct session clears** (11:33:32.830–11:33:33.003Z). The table below uses each session's first response dump whose **request filename timestamp** is at or after 11:33:32Z and the immediately preceding response dump for that session. `prevTotal = input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Dumps were only read in place, not staged. A first post-boot request can still carry a transform prepared before the clear, as the principal session demonstrates. Absence of a post-boot dump is not evidence of zero damage, and these data do **not** substantiate a billed miss on all 26 sessions.

| Session | First post-boot request UTC | cache_read | prevTotal |
|---|---|---:|---:|
| ses_331acff95fferWZOYF1pG0cjOn | 11:33:36.667 | 647541 | 647543 |
| ses_313660571ffeZTsf4koSJwk50Q | 11:34:06.548 | 278678 | 611747 |
| ses_22d43cb21ffeP7gd0iEX9qT7TM | 11:33:58.475 | 164596 | 532746 |
| ses_227ce5788ffeRPA9THoPLOQreO | 11:33:34.797 | 606112 | 606114 |
| ses_1c79b4de2ffeFGc4VJ1uWBn7nc | No post-boot dump | — | — |
| ses_13ae8f525ffeCnx9aTNmVDRBdR | No post-boot dump | — | — |
| ses_12f72c654ffe94Fkze4RXRpXng | 11:33:35.551 | 262950 | 262952 |
| ses_12a4fa38dffe81Fz7Y2AsWb5Cg | No post-boot dump | — | — |
| ses_114f158ccffet7znXAgI7lc3Kp | No post-boot dump | — | — |
| ses_110d87916ffeDbfbAjhUgyL8Ps | 11:33:52.566 | 215610 | 536842 |
| ses_100a028aaffeVG0zdK3qwcEXf8 | 11:33:35.013 | 482937 | 482939 |
| ses_0d9602e50ffe0yxsEU1JrCXRVx | No post-boot dump | — | — |
| ses_0d265e156ffeWdDjll9oUjm6eh | No post-boot dump | — | — |
| ses_0cdef06a7fferJh297c1c1cqfW | No post-boot dump | — | — |
| ses_0b80d7b39ffeNAo68snl48kErV | No post-boot dump | — | — |
| ses_0ae6b859effeWSJCG8LoU34szd | No post-boot dump | — | — |
| ses_0ad83017cffexe0g5N8UG0y3LZ | No post-boot dump | — | — |
| ses_099ff1cb2ffeTSE956AjbUYyF3 | No post-boot dump | — | — |
| ses_08df2045bffeBcWcqw60elghER | 11:33:44.395 | 410898 | 410900 |
| ses_OqknfoW2O3LTOcjLvOMQoREVPtz1 | No post-boot dump | — | — |
| ses_089301004ffeI4YKU4R01EiTE0 | No post-boot dump | — | — |
| ses_0758f6ce7ffeJ0A9sV8Qvema7d | No post-boot dump | — | — |
| ses_070d004caffeqpRYKsgKb7SjfG | 11:52:17.071 | 171601 | 408345 |
| ses_06be916fbffezpvuoIO3ac4yMZ | No post-boot dump | — | — |
| ses_00fc88222ffeCS6X6HJOavuOZA | 11:34:20.544 | 151487 | 443109 |
| ses_00ed68536ffeah34foNE2loI5i | No post-boot dump | — | — |
