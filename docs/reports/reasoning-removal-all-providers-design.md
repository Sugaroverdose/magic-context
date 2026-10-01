# Old reasoning removal on every provider, plus two emergency-drop guards: design note

Date: 2026-10-01. Written before the code change. It records what changes on which pass and why replay stays byte-identical.

## Evidence that motivates the change

A long OpenCode subagent on `openai/gpt-6.1-sol` (openai-auth, Responses API over WebSocket, `store:false`) sat at 100% context for its last hour. Its 04:18:49 request body was 2.99 MB:

| Part of the request | Size |
|---|---:|
| 609 `reasoning` input items, each with `encrypted_content` | 2.60 MB |
| tool calls | 255 KB |
| tool results (307 of 330 already `[dropped N]`) | 37 KB |
| messages | 23 KB |

Magic Context's tags recorded only 2,994 reasoning tokens for the session, because opaque reasoning is not counted. Each emergency pass at 100% dropped exactly one tag: the tool result that had arrived under a second earlier. That reclaimed 28 to 149 tokens against a gap of about 9,200. The logged floor was about 326K and the ceiling about 251K.

Two defects explain this:

1. Age-based reasoning cleanup runs only when the provider id is exactly `anthropic`, so every other route keeps all of its reasoning forever.
2. The emergency planner commits a pass that reclaims almost nothing, because its minimum is compared with the gap, not with what the chosen candidates reclaim.

## 1. Remove old reasoning parts on every provider

### Which parts

On assistant messages older than the age cutoff, remove every whole `reasoning`, `thinking` or `redacted_thinking` part. The cutoff is the current rule: the message's tag must be at most `maxTag − clear_reasoning_age`. Removal takes the part's provider metadata with it, including OpenAI's `itemId` and `reasoningEncryptedContent`. Text is never rewritten to `[cleared]`. The wire capture in `reasoning-cleanup-per-provider.md` shows that, on OpenCode 1.18.30, a removed part sends nothing on native Anthropic, Vertex, Bedrock, OpenAI Responses, Gemini and Groq. DeepSeek still sends an empty `reasoning_content`.

A message is never selected when it is one of these:

- the newest assistant message;
- the newest assistant that still carries replayable content (`findLatestAssistantReasoningMutationExemptMessage`, which skips OpenCode's metadata-only request shell);
- untagged (tag 0);
- a message whose removal would leave no wire content. Wire content means a non-empty text part, a tool part or a file part. This keeps an assistant from becoming an empty message on adapters that do not drop empty messages.

**Prefix-bound models** (Fable 5.1, Opus 5.5 and Sonnet 5.5 via `isPrefixBoundThinkingModel`, on any route): selection walks reasoning-bearing assistants oldest-first. It stops at the first one that is neither already removed nor eligible now, so the removed set is always a contiguous oldest prefix. The set only grows, so a removed block is never restored. On OpenCode primary sessions the existing proactive thinking strip already removes all reasoning on these models on every busting pass. The new lane matters for subagents, which that strip skips. The worker in the evidence was a subagent.

### OpenCode (packages/plugin)

- **Canonical `anthropic`:** unchanged. The existing `clearOldReasoning` → `[cleared]` → empty-sentinel lane and its watermark replay stay exactly as they are, so canonical Anthropic output is byte-identical to today. The new lane does not run there.
- **Every other provider:** a new frozen id set holds the ids of assistant messages whose reasoning was removed.
  - **Storage:** a new `reasoningRemoval` namespace in the existing per-session replay document (`session_meta.trailing_blank_decisions`, v2 envelope, the same document `piNative` lives in). No schema change and no migration.
  - **Selection** runs only where `clearOldReasoning` runs today: inside the heuristics block, when `routineCleanupApplied` is true. That is the same cache-rebuilding permission every other mutation lane uses (ARCHITECTURE.md protected section, invariant 4). New ids are persisted, as a union, before any byte changes. If the write fails, nothing new is applied on that pass and the old set is replayed.
  - **Application** happens on every pass, defer passes included, inside `finalizeMessageRepresentation`. That is the last writer before the tail-hygiene baseline. It splices the reasoning parts out of every message whose id is in the persisted set. The newest assistant is skipped defensively there as well.
- **Why at finalize:** several lanes read or write `message.parts` by index during a pass:
  - text tag content ids are `<messageId>:p<index>`;
  - file-part tag targets write `messageParts[partIndex]` from a closure;
  - the stale-reduce strip records indices;
  - merged-reasoning replay keys frozen parts by index.

  All of them run before finalize, on the unmodified array. OpenCode rebuilds the message array from its own database on every pass, so the next pass tags the original indices again. Removal therefore changes no index that any lane reads. `stripReasoningFromAssistantIds` already uses this splice-at-finalize pattern for binding recovery on non-Anthropic routes. `reasoningByMessage` holds part references, not indices, and is used only by the canonical Anthropic lane.
- **Accounting:** the pass counts removed parts as a mutation (`heuristicOrReasoningDidMutate`), so the usual bust bookkeeping sees it.

### Pi (packages/pi-plugin)

Pi already clears typed thinking on every provider. `clearOldReasoningPi` has no provider gate. It empties `thinking` and drops `thinkingSignature`, which carries the OpenAI reasoning item and its encrypted content. Every Pi serializer drops empty thinking, so the block already leaves the wire on every route. Two guards are missing, and this change adds them:

- **Newest assistant:** never selected. The newest assistant has the highest tag, and replay covers only tags at or below the watermark, so a watermark below its tag cannot reach it on a later defer pass.
- **Prefix-bound models:** the selection watermark is clamped to just below the first reasoning-bearing assistant that cannot be cleared (a redacted block, or an untagged message), so no gap opens.

The emptied shape stays as it is. Changing it to a splice would change Pi's working array for existing sessions without changing the wire. Native `providerPayload` reasoning (`canClearNativeReasoning`) keeps its existing gate. That gate concerns a different payload, Responses history captured by OMP, and is out of scope.

### Rust module (crates/mc-module)

Rust already has a whole-block removal lane: the `reasoning_age` frozen strip unit, used by Claude Code and replayed by `remove_frozen_historical_reasoning`. For the OpenCode profile on a provider other than canonical `anthropic`, the reasoning cutoff is now captured on bust passes, and `reasoning_age` units are minted for eligible messages. The eligibility rules are the ones listed above. Canonical Anthropic keeps its `reasoning_clear` lane unchanged. Units are minted only when `is_bust_pass` holds, persisted with the other frozen units, and replayed unchanged on defers.

## 2. Emergency drop: a minimum reclaim per pass

`planEmergencyDrop`, used by OpenCode and by Pi, now computes the reclaim its selection would actually achieve and commits only when that clears a minimum:

```
minimum = max(EMERGENCY_REARM_MIN_TOKENS (2,000), 10% of the gap)
```

**Why these numbers.** In the evidence, a pass reclaimed 28 to 149 tokens against a 9,200-token gap. Each such pass rewrote a prefix of roughly 300K tokens to gain less than 0.05% of it, then repeated on the next pass. A fixed 2,000-token floor (the existing rearm constant) blocks every observed pass. The 10% share keeps very large gaps from being chased with crumbs: at a 100K gap, a pass must reclaim at least 10K tokens. If the share alone were the rule, a small gap would let trivial passes through, and the fixed floor prevents that.

**When the pass is skipped:** it is a no-op with a logged reason, and the pressure-episode latch is not consumed.

**Floor above ceiling:** when the estimated fixed floor alone exceeds the ceiling, the reason says so plainly, for example: `fixed floor ≈326000 already exceeds ceiling 251000: tool drops cannot reach the target`.

Rust's `select_emergency` gets the same rule, with the same constants and messages.

## Considered and dropped: exempting unseen tool results

A third guard was considered: never let an automatic lane drop a tool result before a completed later step has read it. It was dropped before implementation. Removing old reasoning removes the cause, and the minimum reclaim per emergency pass already stops a pass from discarding a small fresh result for nothing. The unseen check would add a walk of the message array on every pass and three implementations (OpenCode, Pi, Rust) to keep in sync, without preventing anything those two changes do not.

## Replay and byte identity

| Lane | Selection | Persisted as | Defer pass |
|---|---|---|---|
| OpenCode non-Anthropic removal | rebuilding passes only | message id set in the replay document | splices the same ids at finalize |
| OpenCode canonical Anthropic | unchanged | unchanged watermark | unchanged |
| Pi | rebuilding passes only | existing watermark, now clamped | existing replay |
| Rust | bust passes only | `reasoning_age` frozen units | existing unit replay |
| Emergency minimum reclaim | only changes what a rebuilding pass selects | nothing new | drops already applied replay as before |

## What this note cannot settle offline

Whether each backend accepts removed reasoning in the middle of an open tool loop is unproven offline. OpenAI may expect the reasoning items of the current turn alongside function calls. Vertex, Bedrock and Gemini acceptance are likewise unproven, as is OpenAI's behaviour with `previous_response_id` continuation. The delivery lists the live calls that would settle each one.
