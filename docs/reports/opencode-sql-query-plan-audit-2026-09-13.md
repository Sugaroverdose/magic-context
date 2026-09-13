# OpenCode SQLite query-plan audit for issue #440

Date: 2026-09-13  
Scope: every Magic Context statement that opens or receives `opencode.db` in the plugin paths named in #440.  
Stock schema: OpenCode v1.18.30 `MessageTable` and `PartTable` from [`packages/core/src/session/sql.ts`](https://github.com/anomalyco/opencode/blob/v1.18.30/packages/core/src/session/sql.ts): `message_session_time_created_id_idx(session_id,time_created,id)`, `part_session_idx(session_id)`, and `part_message_id_id_idx(message_id,id)`, plus the text primary keys. No Magic Context index, `ANALYZE`, cache, or schema change is used.

The checked `EXPLAIN QUERY PLAN` fixture is in `packages/plugin/src/hooks/magic-context/opencode-query-plan.test.ts`. It runs through the shipped SQLite adapter under Bun and checks both an absent `sqlite_stat1` table and adversarial statistics. A standalone `node:sqlite` run also verified all four bundled reader shapes against Node's runtime adapter; both runtimes selected `part_message_id_id_idx` and never `part_session_idx`.

## Read-only statements

| Statement / owner | Stock-schema plan | Verdict |
|---|---|---|
| Session message count excluding completed summaries (`read-session-db.ts`, `getRawSessionMessageCountFromDb`) | `SEARCH message USING INDEX message_session_time_created_id_idx (session_id=?)` | Expected one session-message scan. |
| Latest assistant / latest assistant model (`read-session-db.ts`) | `SEARCH message USING INDEX message_session_time_created_id_idx (session_id=?)` plus backward order | Expected bounded tail search; no per-row query. |
| Newer real user probe (`read-session-db.ts`, `hasNewerRealUserMessage`) | range search on `message_session_time_created_id_idx`; correlated part existence probes use `part_message_id_id_idx(message_id=?)` | Expected; part probes are ID-driven. |
| Awaiting-tool parts (`read-session-db.ts`, `assistantAwaitingToolsFromOpenCodeDb`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** `+session_id` prevents `part_session_idx`; plan pinned. |
| Batched message times (`read-session-db.ts`, `getMessageTimesFromOpenCodeDb`) | repeated primary-key lookup on `message.id`, then session filter | Expected bounded ID set. |
| Full raw message rows / ID ordinals (`read-session-raw.ts`) | `SEARCH message USING INDEX message_session_time_created_id_idx (session_id=?)` | Expected one ordered session scan. |
| Full-reader bounded parts (`readRawSessionMessagesFromDb`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)`; temp B-tree only for requested ordering | **Fixed:** never `part_session_idx`, absent/adversarial stats pinned. |
| Paged message rows (`readRawSessionMessagePageFromDb`) | session index with ordered LIMIT/OFFSET | Expected bounded page; #437 paging/yields retained. |
| Paged-reader bounded parts (`readRawSessionMessagePageFromDb`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** never `part_session_idx`, absent/adversarial stats pinned. |
| Message counts (`countRawSessionMessageOrdinalsFromDb`, `countStoredRawSessionMessagesFromDb`) | session index (covering for stored count) | Expected aggregate over one session. |
| Message ordinal keyset pages (`readRawSessionMessageOrdinalPageFromDb`) | range search on `message_session_time_created_id_idx` | Expected bounded keyset page. |
| Tail anchor (`readRawSessionTailFromDb`) | primary-key lookup on `message.id`, then session filter | Expected point lookup. |
| Tail message range (`readRawSessionTailFromDb`) | range search on `message_session_time_created_id_idx` | Expected one suffix scan. |
| Tail bounded parts (`readRawSessionTailFromDb`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** never `part_session_idx`, absent/adversarial stats pinned. |
| Point message and point parts (`readRawSessionMessagePartsByIdFromDb`, `readRawSessionMessageByIdFromDb`) | message primary key; parts use `part_message_id_id_idx(message_id=?)` | **Fixed sibling:** unary-plus plan pinned and text-session result checked. |
| Ordinal by message ID (`readRawSessionMessageOrdinalByIdFromDb`) | target primary key plus candidate range on `message_session_time_created_id_idx` | Expected one target lookup and one session prefix count. |
| Seed-tail CTE and part join (`readRawSeedTailFromDb`) | ordered session scan for canonical rows; each join lookup uses `part_message_id_id_idx(message_id=?)` | **Fixed sibling:** `+p.session_id` prevents a part-session nested scan; plan pinned. |
| Retrospective messages since / before (`retrospective-raw-provider.ts`) | range search on `message_session_time_created_id_idx` | Expected bounded ordered windows. |
| Retrospective oldest time by session batch | repeated searches on `message_session_time_created_id_idx` | Expected batched session set; no per-row SQL. |
| Retrospective bounded parts (`normalizeOpenCodeRows`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** never `part_session_idx`, absent/adversarial stats pinned. |
| Marker target/sort-key/existence reads (`compaction-marker.ts`) | message primary-key lookup, with session/JSON post-filter | Expected point lookups. |
| Prior user boundary (`findBoundaryUserMessage`) | range search on `message_session_time_created_id_idx` in reverse order | Expected one session-message range search. |
| Legacy summary ownership (`removeLegacyMarkerLineageRows`) | one session-message scan; correlated text-part probe uses `part_message_id_id_idx(message_id=?)` | **Fixed sibling:** `+p.session_id` plan pinned. |
| Actionable marker summaries (`listSessionCompactionMarkers`) | `SEARCH message USING INDEX message_session_time_created_id_idx (session_id=?)` | Expected exactly one session-message scan. |
| Actionable marker part pages (`listSessionCompactionMarkers`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** ≤800 boundary IDs, never `part_session_idx`, absent/adversarial stats pinned. |
| Compaction-off canonical/legacy summaries (`removeMcOwnedCompactionMarkers`) | two session-message scans; legacy correlated text-part probes use `part_message_id_id_idx` | Expected transition-only scans; no messages-per-marker loop. |
| Compaction-off all compaction parts / message tail refs | `part_session_idx(session_id=?)` / `message_session_time_created_id_idx(session_id=?)` | Intentional full-session safety preflight: input is not a bounded ID set. |
| Startup marker row existence (`compaction-marker-manager.ts`) | message/part primary-key lookup | Expected diagnostic-only point probes; current non-destructive boot behavior retained. |
| OpenCode session existence during index orphan sweep (`message-index.ts`) | primary-key lookup on `session.id` | Expected point lookup. All other `message-index*.ts` statements target `context.db`, not `opencode.db`. |

## Write statements

| Statement / owner | Stock-schema plan | Verdict |
|---|---|---|
| Marker row upserts (`injectCompactionMarker`) | primary-key conflict lookup on message/part IDs | Expected bounded writes. |
| Delete summary parts by message ID (legacy cleanup, foreign cleanup, compaction-off cleanup) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** `+session_id` prevents whole-session deletion scans; plan pinned. |
| Delete message or part by row ID (all marker removal paths) | text primary-key lookup | Expected bounded writes. |
| Delete stale boundary compaction parts (`removeLegacyMarkerLineageRows`) | `SEARCH part USING INDEX part_message_id_id_idx (message_id=?)` | **Fixed:** bounded message ID now disqualifies `part_session_idx`. |

## Shared-reader and paging check

`read-session-chunk.ts` and `compartment-drop-pagination.test.ts` issue no SQL themselves; they call the paged raw readers above and retain the #437 page size and event-loop yields. `message-index-async.ts` likewise delegates OpenCode reads to `read-session-raw.ts`. Dashboard Rust readers and CLI migration readers do not import or share these plugin reader implementations, so changing them would be a separate product/runtime change; they were inspected for sharing and excluded from this patch.

## Result-equivalence evidence

The plan test executes each of the four shipped bounded-reader SQL shapes before and after adding unary `+`, compares the complete ordered rows, expects 400 same-session rows, and thereby re-proves exclusion of a same-message-ID row whose TEXT `session_id` is `other`. Marker differential tests run the legacy discovery query and reversed implementation on native/orphan markers, multiple summaries and parts, cross-session data, 900 boundaries, and a missing boundary. The reconciliation caller additionally proves the same actionable removal and retry behavior when ownership is stale or deletion fails.

## Proposed four-line #440 reply

> The slowdown came from SQLite choosing `part_session_idx` for bounded message-ID reads, plus marker discovery scanning every session part and then messages once per marker.  
> We now disqualify the session-only index for bounded part lookups and discover marker summaries once before fetching their boundary parts in pages of at most 800.  
> Stock-schema plan assertions, Bun and Node SQLite checks, TEXT-session result equivalence, and legacy/new marker reconciliation differentials pass; the fix is targeted for v0.42.3.  
> Thank you @null-axiom for the exact SQL fingerprints, standalone reproduction, planner evidence, and validated local fix.
