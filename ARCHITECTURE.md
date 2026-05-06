# Architecture

> All `src/` paths below are relative to `packages/plugin/` — the published npm package.

## Pattern Overview

**Overall:** Use a plugin-driven orchestration pattern centered on `@opencode-ai/plugin` entrypoints in `src/index.ts`.

**Key Characteristics:**
- Route all OpenCode integration through thin adapters in `src/plugin/` and keep feature logic in `src/hooks/`, `src/features/`, and `src/tools/`.
- Use SQLite-backed durable state from `src/features/magic-context/storage*.ts` for tags, pending ops, compartments, memories, dreamer queue state, and per-session cache-stability watermarks (`cleared_reasoning_through_tag`, `stripped_placeholder_ids`).
- Use hidden subagents from `src/agents/*.ts` plus prompt builders in `src/features/magic-context/dreamer/task-prompts.ts`, `src/features/magic-context/sidekick/agent.ts`, and `src/hooks/magic-context/compartment-prompt.ts`.
- Replay all persistent message mutations (reasoning clearing, placeholder stripping) on every transform pass — including defer passes — so stripped state survives OpenCode's message rebuilds without re-triggering a cache bust.

## Layers

**Plugin bootstrap:**
- Purpose: Register the plugin, load config, wire agents, hooks, commands, and tools.
- Location: `src/index.ts`
- Contains: Plugin factory, config mutation, hidden agent registration.
- Depends on: `src/config/index.ts`, `src/plugin/`, `src/features/builtin-commands/commands.ts`, `src/shared/model-requirements.ts`.
- Used by: Bun build output at `dist/index.js` and OpenCode plugin loading.

**Plugin adapters:**
- Purpose: Keep OpenCode-facing handlers small and delegate real work.
- Location: `src/plugin/event.ts`, `src/plugin/messages-transform.ts`, `src/plugin/tool-registry.ts`, `src/plugin/hooks/create-session-hooks.ts`
- Contains: Hook wrappers, tool registration, per-session hook construction.
- Depends on: `src/hooks/magic-context/`, `src/tools/`, `src/features/magic-context/`.
- Used by: `src/index.ts`.

**Magic-context runtime:**
- Purpose: Execute message transforms, lifecycle hooks, nudging, compaction reactions, command handling, and historian coordination.
- Location: `src/hooks/magic-context/`
- Contains: Transform pipeline, postprocess phase, event handlers, command handlers, prompt hashing, compartment runners.
- Depends on: `src/features/magic-context/`, `src/shared/`, `src/agents/magic-context-prompt.ts`.
- Used by: `src/plugin/hooks/create-session-hooks.ts` and `src/plugin/event.ts`.

**Core feature services:**
- Purpose: Encapsulate reusable stateful services behind pure or narrow APIs.
- Location: `src/features/magic-context/`
- Contains: Storage access, scheduler, tagger, compaction handler, memory system, dreamer queue/runner/scheduler, sidekick support.
- Depends on: `src/shared/` and Bun SQLite.
- Used by: `src/hooks/magic-context/`, `src/plugin/tool-registry.ts`, and `src/index.ts`.

**Tool surface:**
- Purpose: Expose agent tools with validated schemas and storage-backed execution.
- Location: `src/tools/ctx-reduce/tools.ts`, `src/tools/ctx-expand/tools.ts`, `src/tools/ctx-note/tools.ts`, `src/tools/ctx-memory/tools.ts`
- Contains: Tool definitions, argument schemas, action gating, user-facing result formatting.
- Depends on: `src/features/magic-context/` and `src/hooks/magic-context/read-session-chunk.ts`.
- Used by: `src/plugin/tool-registry.ts`.

**Configuration and shared utilities:**
- Purpose: Centralize config parsing, defaults, path resolution, logging, and SDK normalization.
- Location: `src/config/` and `src/shared/`
- Contains: Zod schemas, config merging, data-path helpers, logger, JSONC parsing, model helpers.
- Depends on: Node built-ins and Zod.
- Used by: All other layers.

**CLI (separate package):**
- Purpose: Provide a unified, harness-aware interactive setup/doctor wizard runnable via `npx` outside of OpenCode/Pi.
- Location: `packages/cli/src/` (NOT in `packages/plugin/`; the per-plugin CLI bins were collapsed into one shared package in v0.16.1).
- Contains: Setup/doctor commands (`packages/cli/src/commands/`), harness adapters for OpenCode and Pi (`packages/cli/src/adapters/`), shared prompt/path utilities (`packages/cli/src/lib/`).
- Depends on: `@clack/prompts`, Node built-ins; no dependency on plugin runtime layers.
- Used by: Published as `@cortexkit/magic-context` on npm; invoked as `npx @cortexkit/magic-context@latest <subcommand>`.

## Data Flow

**Plugin startup:**
1. Load and merge config from `src/config/index.ts` — prefer project-root `magic-context.jsonc`, then `.opencode/magic-context.*`, then user config.
2. Build session hooks in `src/plugin/hooks/create-session-hooks.ts` — create the tagger, scheduler, and compaction handler.
3. Register tools in `src/plugin/tool-registry.ts` — open the SQLite database, initialize embeddings, and expose `ctx_reduce`, `ctx_expand`, `ctx_note`, and conditional `ctx_memory`.
4. Register OpenCode entrypoints in `src/index.ts` — bind message transforms, event hooks, command hooks, and hidden agents.

**Session transform pipeline:**
1. Enter `createMagicContextHook()` in `src/hooks/magic-context/hook.ts` — open persistent storage, set up in-memory maps, and create the transform.
2. Run the transform from `src/hooks/magic-context/transform.ts` — tag messages, load session state, prepare compartment injection, and schedule deferred work. On every pass (including defer), replay persisted reasoning clearing using `replayClearedReasoning()` and `replayStrippedInlineThinking()` from `src/hooks/magic-context/strip-content.ts` to maintain stripped state when OpenCode rebuilds messages from its own DB.
3. Run postprocessing in `src/hooks/magic-context/transform-postprocess-phase.ts` — apply pending ops, heuristic cleanup, reasoning cleanup, stale reduce-call cleanup, compartment rendering, and nudge placement. Stripped placeholder message IDs are read from `stripped_placeholder_ids` in `session_meta` (via `src/features/magic-context/storage-meta-persisted.ts`) and replayed on every pass; the persisted set is updated when new empty shells are detected on cache-busting passes only.
4. Persist session state through storage helpers exported by `src/features/magic-context/storage.ts`.

**System prompt stability:**
- Freeze the `Today's date:` line in the system prompt on defer passes using a per-session `stickyDateBySession` map in `src/hooks/magic-context/system-prompt-hash.ts`. Update the sticky date only on cache-busting passes. This prevents a midnight date flip from causing a spurious cache rebuild.
- Track the reasoning-clearing watermark (`cleared_reasoning_through_tag` column in `session_meta`) as a persisted integer so clearing survives across OpenCode message rebuilds.

**Note nudge trigger gating:**
- The todowrite note-nudge fires in `src/hooks/magic-context/hook-handlers.ts` only when ALL todo items have a terminal status (`completed` or `cancelled`). Intermediate todowrite calls during active work do not trigger the nudge.

**Memory and search flow:**
1. Create, update, merge, archive, list, or search memories through `src/tools/ctx-memory/tools.ts`.
2. Store canonical records in `src/features/magic-context/memory/storage-memory.ts` and sync full-text search through the FTS triggers created in `src/features/magic-context/storage-db.ts`.
3. Generate and store embeddings through `src/features/magic-context/memory/embedding.ts` and `src/features/magic-context/memory/storage-memory-embeddings.ts`.
4. Inject cached project memories into `<session-history>` through `src/hooks/magic-context/inject-compartments.ts`.

**Dreamer flow:**
1. Detect eligible projects during `message.updated` handling in `src/hooks/magic-context/hook.ts`.
2. Enqueue projects on a schedule through `src/features/magic-context/dreamer/scheduler.ts` and `src/features/magic-context/dreamer/queue.ts`.
3. Serialize dream runs with the lease in `src/features/magic-context/dreamer/lease.ts`.
4. Spawn one child session per task from `src/features/magic-context/dreamer/runner.ts` using prompts from `src/features/magic-context/dreamer/task-prompts.ts`.

**Command augmentation flow:**
1. Register `/ctx-status`, `/ctx-flush`, `/ctx-recomp`, `/ctx-aug`, and `/ctx-dream` in `src/features/builtin-commands/commands.ts`.
2. Intercept command execution in `src/hooks/magic-context/command-handler.ts`.
3. Run sidekick augmentation from `src/features/magic-context/sidekick/agent.ts` or queue dream work through `src/features/magic-context/dreamer/runner.ts`.
4. Send ignored notifications or real user prompts through `src/hooks/magic-context/send-session-notification.ts`.

## Key Abstractions

**Magic Context hook:**
- Purpose: Own the runtime state for one plugin instance.
- Location: `src/hooks/magic-context/hook.ts`, `src/hooks/magic-context/index.ts`
- Pattern: Composition root that returns OpenCode hook handlers.

**Tool registry:**
- Purpose: Gate tool availability by config and persistent-storage readiness.
- Location: `src/plugin/tool-registry.ts`
- Pattern: Registry builder with conditional feature exposure.

**Memory store:**
- Purpose: Keep project-scoped durable knowledge searchable and mergeable.
- Location: `src/features/magic-context/memory/storage-memory.ts`, `src/features/magic-context/memory/storage-memory-fts.ts`, `src/features/magic-context/memory/storage-memory-embeddings.ts`
- Pattern: SQLite repository plus FTS and embedding side tables.

**Dream queue and lease:**
- Purpose: Run at most one dream worker at a time and survive restarts.
- Location: `src/features/magic-context/dreamer/queue.ts`, `src/features/magic-context/dreamer/lease.ts`, `src/features/magic-context/dreamer/storage-dream-state.ts`
- Pattern: SQLite-backed queue plus cooperative lease lock.

**User memory pipeline:**
- Purpose: Extract user behavioral observations from historian output, collect candidates, and promote recurring patterns to stable user memories.
- Location: `src/features/magic-context/user-memory/storage-user-memory.ts`, `src/features/magic-context/user-memory/review-user-memories.ts`
- Pattern: Historian extracts candidates, dreamer reviews and promotes, system prompt injects stable memories.

**Plugin message bus:**
- Purpose: Enable asynchronous communication between the TUI plugin and server plugin via SQLite.
- Location: `src/features/magic-context/plugin-messages.ts`
- Pattern: SQLite-backed message queue with direction, type, and payload columns; consumed atomically.

**Compaction markers:**
- Purpose: Inject OpenCode-compatible compaction boundaries into the message table so `filterCompacted` stops at historian's last compartment boundary.
- Location: `src/hooks/magic-context/compaction-marker.ts`, `src/hooks/magic-context/compaction-marker-manager.ts`
- Pattern: Write summary/compaction rows into OpenCode's DB after historian publishes; filter them out from raw reads.

**Agent prompt pack:**
- Purpose: Keep hidden-agent identities and prompt text isolated from runtime wiring.
- Location: `src/agents/dreamer.ts`, `src/agents/historian.ts`, `src/agents/sidekick.ts`, `src/agents/magic-context-prompt.ts`
- Pattern: Constants plus prompt builders.

**Content stripping and replay:**
- Purpose: Strip reasoning, inline thinking, placeholder shells, and structural noise from messages, and replay those operations on every transform pass to maintain stable message content across OpenCode's message rebuilds.
- Location: `src/hooks/magic-context/strip-content.ts`
- Pattern: Stateless strip functions paired with persisted watermarks (`cleared_reasoning_through_tag`, `stripped_placeholder_ids`) read from `session_meta` via `src/features/magic-context/storage-meta-persisted.ts`.

**Persisted session meta:**
- Purpose: Store per-session scalars and JSON blobs that must survive across transform passes and OpenCode restarts.
- Location: `src/features/magic-context/storage-meta-shared.ts`, `src/features/magic-context/storage-meta-persisted.ts`, `src/features/magic-context/storage-meta-session.ts`
- Pattern: `session_meta` SQLite table with `ensureColumn()` migrations; typed row interfaces with runtime guards.

## Entry Points

**CLI entry:**
- Location: `packages/cli/src/index.ts` (separate `@cortexkit/magic-context` package).
- Triggers: Executed as the unified `magic-context` bin target via `npx @cortexkit/magic-context@latest <subcommand>`.
- Responsibilities: Detect installed harnesses (OpenCode, Pi) and dispatch `setup` / `doctor` flows; print usage on unknown commands.

**Plugin entry:**
- Location: `src/index.ts`
- Triggers: OpenCode loads the package entry declared in `package.json`.
- Responsibilities: Load config, disable the plugin when OpenCode auto-compaction is active, register hidden agents, hooks, commands, and tools.

**Message transform entry:**
- Location: `src/plugin/messages-transform.ts`
- Triggers: `experimental.chat.messages.transform`
- Responsibilities: Delegate the mutable message pipeline to the magic-context hook.

**Event entry:**
- Location: `src/plugin/event.ts`
- Triggers: OpenCode session and message lifecycle events.
- Responsibilities: Forward lifecycle events to the runtime event handler.

**Tool entry:**
- Location: `src/plugin/tool-registry.ts`
- Triggers: Plugin initialization.
- Responsibilities: Open storage, normalize arg schemas, and expose the supported tool set.

## Session Modes

Magic Context runs in three effective modes depending on `ctx_reduce_enabled` and whether the session is a subagent. The mode decides which of the heavier features (historian, nudges, prompt-adjunct injections) run for that session, while tag/drop/heuristic plumbing stays on everywhere so any subsequent manual or automated reduction still works.

| Feature | Primary + `ctx_reduce_enabled: true` | Primary + `ctx_reduce_enabled: false` | Subagents (any `ctx_reduce_enabled`) |
|---|---|---|---|
| Tag DB records | ✓ | ✓ | ✓ |
| `§N§` tag prefix injection in message text | ✓ | ✗ | ✗ |
| `ctx_reduce` tool | ✓ | ✗ | ✗ |
| Historian / compartments / compressor | ✓ | ✓ | ✗ |
| Compartment injection (`<session-history>`) | ✓ | ✓ | ✗ |
| `<project-docs>`, `<user-profile>`, `<key-files>` system-prompt blocks | ✓ | ✓ | ✗ |
| Rolling / tool-heavy / sticky / deferred-note nudges | ✓ | ✗ | ✗ |
| Heuristic tool drops at execute threshold | ✓ | ✓ | ✓ |
| Heuristic reasoning clearing | ✓ | ✓ | ✓ |
| 85 % force-materialization | ✓ | ✓ | ✗ |
| 95 % block + emergency recovery | ✓ | ✓ | ✗ |
| Experimental age-tier caveman text compression | ✗ | opt-in | ✗ |

**Subagent rationale:** subagents are driven by a parent agent, have bounded lifetimes, and often run in parallel (council, historian, sidekick, dreamer child sessions). They still benefit from automatic heuristic drops on their own context at execute passes, but turning on historian, nudges, or prompt-adjunct injections in each subagent would create redundant work and per-agent cache churn. Subagents that run into overflow fall back to the existing `overflow-detection.ts` path rather than Magic Context's own 85/95 thresholds.

**`ctx_reduce_enabled: false` rationale:** removes agent-facing reduction machinery (the tool itself, nudges asking the agent to use it, and `§N§` prefix injection the agent can't act on) while keeping the deterministic parts (historian, heuristic drops, compartment injection, memory). Users who want a fully automatic pipeline can opt in and optionally enable caveman age-tier compression to recover most of the win that manual `ctx_reduce` gives for long user / assistant text parts.

## Error Handling

**Strategy:** Fail closed when persistent storage is unavailable in `src/plugin/tool-registry.ts` and `src/hooks/magic-context/hook.ts`; fail open inside per-turn handlers by logging and skipping unsafe mutations; stop OpenCode command fallthrough with sentinel errors from `src/hooks/magic-context/command-handler.ts`.

## Cross-Cutting Concerns

**Logging:** Use buffered file logging from `src/shared/logger.ts` and write to the temp-file path returned by `getLogFilePath()`.

**Caching:** Use deferred reductions, cached memory-block injection, per-session TTL tracking, and anchored nudge placement from `src/hooks/magic-context/`.

**Storage:** Use the SQLite database created by `src/features/magic-context/storage-db.ts` under the OpenCode data directory resolved by `src/shared/data-path.ts`.

## Tag Identity (v3.3.1+)

**Tag types:** `message`, `file`, `tool`. Each row in the `tags` table represents one source-content unit that can be tagged with `§N§` and dropped/truncated/replayed by the runtime.

**Identity composition by type:**

- **`message` and `file` tags:** identified by `(session_id, message_id)`. The `message_id` for these is a synthetic content id (`<msgId>:p<partIndex>` for text, `<msgId>:fileN` for files). These ids are globally unique within a session.

- **`tool` tags:** identified by `(session_id, message_id, tool_owner_message_id)` — a *composite* identity. For tool tags, `message_id` is the OpenCode-generated callID (e.g. `read:32`). Pre-v3.3.1 the runtime keyed tool tags by callID alone, but OpenCode reuses a callID counter per assistant turn — so two assistant turns that each invoke `read:32` produced the SAME callID for different invocations. The fix: include the *owning assistant message id* in the key so each invocation gets its own row.

**Schema enforcement:** schema migration v10 (`src/features/magic-context/migrations.ts`) adds `tool_owner_message_id` (`TEXT NULL`), a partial UNIQUE index `idx_tags_tool_composite` on `(session_id, message_id, tool_owner_message_id) WHERE type='tool' AND tool_owner_message_id IS NOT NULL`, and a partial lookup index `idx_tags_tool_null_owner` on `(session_id, message_id) WHERE type='tool' AND tool_owner_message_id IS NULL` to back lazy adoption.

**Helper API surface (`src/features/magic-context/storage-tags.ts`):**

- `getToolTagNumberByOwner(db, sessionId, callId, ownerMsgId)`: composite-identity lookup.
- `getNullOwnerToolTag(db, sessionId, callId)`: find a legacy NULL-owner orphan to lazily adopt.
- `adoptNullOwnerToolTag(db, tagId, ownerMsgId)`: attempt to claim a NULL-owner row (NULL guard ensures first claim wins).
- `getPersistedToolOwnerNearestPrior(db, sessionId, callId, beforeMessageId)`: derive the most recent prior owner for a tool result whose invocation isn't in the visible window.
- `deleteToolTagsByOwner(db, sessionId, ownerMsgId)`: cascade delete on `message.removed`.

**Owner derivation (`src/hooks/magic-context/tag-messages.ts`):**

For each tool observation in a transform pass:

1. **Invocation parts** (`tool-invocation` / `tool_use`): owner = the message hosting the part.
2. **Result parts** (`tool` with output / `tool_result`): pop the FIFO queue of unpaired invocations for that callId; owner = the popped invocation's message id.
3. **Result-only window** (invocation compacted away): fall back to `getPersistedToolOwnerNearestPrior` for the most recent prior persisted owner; if none found, last-resort owner = the result's own message id.

The same logic mirrors in `src/hooks/magic-context/read-session-chunk.ts: getRawSessionTagKeysThrough` so the drop queue produces composite keys that match what the tagger persisted.

**Cleanup paths:**

- `deleteTagsByMessageId(db, sessionId, messageId)` (called from `event-handler.ts` on `message.removed`) deletes BOTH content-id-scoped tags (text/file on the removed message) AND owner-scoped tool tags (`tool_owner_message_id == messageId`).
- `applyHeuristicCleanup` keys both the tag-side index and fingerprint-side map by composite `<ownerMsgId>\x00<callId>`. The fingerprint VALUE includes ownerMsgId too, so cross-owner pairs with same `(toolName, args)` produce DISTINCT fingerprints and are NOT merged.

**Legacy NULL-owner handling:** rows written by pre-v3.3.1 plugin versions have `tool_owner_message_id = NULL`. The Layer B backfill (`src/features/magic-context/tool-owner-backfill.ts`) populates those rows from OpenCode's session DB on plugin upgrade (lease-based concurrency, batched commits). When backfill is skipped (no OpenCode DB attached) lazy adoption converts orphans to non-NULL on the next observation. Drop queue and heuristic cleanup gracefully fall back to bare-callId match for unbackfilled NULL-owner rows.
