# Changelog

All notable changes to `opencode-magic-context` are documented here.
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — v3.3.1: Tag-Owner Identity Fix

### Fixed

- **Tool-call collision bug**: when two assistant turns within a single session reused the same OpenCode-generated tool callID (e.g. both invoked `read:32`), the runtime keyed both invocations to the SAME tag row by `messageId == callId`. Dropping the first turn's tag silently propagated to the second turn's content, corrupting the conversation. The fix adds **composite identity** for tool tags: each row is now uniquely identified by `(session_id, message_id, tool_owner_message_id)` where `tool_owner_message_id` is the assistant message hosting the invocation.

  This was the bug class behind several user-visible symptoms:
  - "My recent search results just disappeared after I edited a file."
  - Reasoning preservation reverting on a fresh assistant turn even though no `ctx_reduce` was issued.
  - Heuristic dedup silently merging two semantically distinct tool invocations.

- **Drop queue cross-compartment matching**: `compartment-runner-drop-queue` no longer queues drops for tool tags whose owner lies outside the compartment range. Pre-fix it matched by bare callId, so a callId reused outside the compartment matched an in-compartment tag by string equality and got wrongly dropped.

- **Heuristic dedup cross-owner false positives**: `applyHeuristicCleanup` now keys both the tag-side index AND the fingerprint-side map by composite `(ownerMsgId, callId)`, with the fingerprint VALUE also including ownerMsgId. Cross-owner pairs with same `(toolName, args)` now produce DISTINCT fingerprints and are NOT merged. Within-same-owner duplicates (Pi parallel-tool-calls shape) still group correctly.

- **`message.removed` cleanup cascade**: `deleteTagsByMessageId` now also deletes tool tags whose `tool_owner_message_id` matches the removed message id. Pre-fix, removing an assistant message left its tool tag rows orphaned in the DB.

### Added

- **Schema migration v10** (`migrations.ts`): adds `tool_owner_message_id` (`TEXT NULL`) column, partial UNIQUE index `idx_tags_tool_composite`, and partial lookup index `idx_tags_tool_null_owner` to back lazy adoption.

- **Layer B backfill** (`tool-owner-backfill.ts`): one-shot lease-based backfill that reads OpenCode's session DB and populates `tool_owner_message_id` on legacy NULL-owner rows. Validated against the user's real 370MB DB (17.86s for 3,284 sessions).

- **Tagger composite identity API** (`tagger.ts`):
  - `assignToolTag(sessionId, callId, ownerMsgId, ...)` — allocate or reuse a tool tag scoped by composite identity.
  - `getToolTag(sessionId, callId, ownerMsgId)` — composite-identity lookup.
  - `bindToolTag(sessionId, callId, ownerMsgId, tagNumber)` — recovery binding.
  - `assignTag` / `getTag` are narrowed to non-tool types (`message` / `file`) — TS forbids passing `"tool"` to them.

- **Lazy adoption fallback**: when a transform pass observes a tool call whose composite key has no match in the in-memory map, the tagger queries `getNullOwnerToolTag` for legacy orphans and atomically claims one via `adoptNullOwnerToolTag` (NULL guard ensures first claim wins). This handles unbackfilled NULL-owner rows incrementally.

- **End-to-end collision-repro test** (`packages/e2e-tests/tests/tag-owner-collision.test.ts`): drives a real OpenCode + magic-context plugin pair through the bug-class scenario and verifies the schema, indexes, and DB-level invariants hold.

- **Microbenchmark for nearest-prior owner derivation** (`packages/plugin/scripts/benchmark-nearest-prior.ts`): documents plan Test #45's exit criterion (0.0455 ms avg on a 30k-tag session — 10× under the 0.5 ms budget).

### Changed

- **Tag-transcript Pi pipeline** (`tag-transcript.ts`): removed the outer `db.transaction()` wrapper. Per-tag SAVEPOINTs inside `assignToolTag` / `assignTag` already provide the atomicity needed; the outer wrapper was a cache-bust amplifier that rolled back ALL tag inserts in a pass on a single late UNIQUE collision while leaving in-memory message mutations and `§N§` prefixes already applied.

- **Drop queue API** (`read-session-chunk.ts: getRawSessionTagKeysThrough`): now returns `RawSessionTagKeys` with `messageFileKeys: Set<string>` and `toolObservations: Map<string, Set<string>>` instead of one collapsed `Set<string>`. The split allows tool tags to be matched by composite identity while message/file tags continue using globally-unique content ids.

### Compatibility

- **Pre-v3.3.1 sessions**: rows written before this version have `tool_owner_message_id = NULL`. The Layer B backfill populates them from OpenCode's session DB on plugin upgrade. Sessions for which OpenCode's DB is unavailable (foreign-harness sessions, deleted DB) fall back to lazy adoption — orphans are converted to non-NULL on the next observation. Drop queue and heuristic cleanup gracefully degrade to bare-callId match for unbackfilled rows (plan §Risk #20).

- **Cache stability**: composite-key migration deterministically produces the same `§N§` prefix across passes for the same observation. Anthropic prompt-cache prefix stability is preserved on defer passes (verified via existing `cache-stability.test.ts` and the new collision-repro tests).

---

For prior versions, see git history.
