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

### Reasoning invalidated by tool and text drops (OpenCode)

The audit in `reclaim-lanes-provider-matrix.md` (rows 3 and 4) found a second, larger source. When a tool or text tag was dropped, `clearThinkingParts` (`tool-drop-target.ts`) and the text-tag `setContent` (`tag-messages.ts`) wrote `[cleared]` into the related reasoning parts on every provider. Only canonical Anthropic converted those parts to an empty sentinel afterwards. Elsewhere the literal went to the wire:

- on Vertex, Bedrock and Copilot Claude, inside a signed block;
- on OpenAI, as a summary beside the untouched `encrypted_content`. In tonight's dump, 516 of 609 items had this shape and still held 2.1 MB.

**Change.** Both write sites now call `neutralizeDroppedReasoningPart`, and `[cleared]` is never written by a drop.

- The part object is rewritten in place to exactly the shape `makeSentinel(part)` produced: `{type:"text",text:""}`, keeping any cache marker.
- On canonical Anthropic that is the same output the old `[cleared]` → `stripClearedReasoning` conversion gave, so the bytes do not change. The one exception is `compactionOff`, where the old conversion was skipped and `[cleared]` reached the wire.
- On every other route the part carries a hidden mark. `removeNeutralizedReasoningParts` splices it out at final representation, together with all of its provider metadata.
- Redacted parts (no `thinking` or `text`) are left alone, as before.
- `clearOldReasoning` and `replayClearedReasoning` skip parts that are already neutralized, so the age lane never writes `[cleared]` into them.

**Same rules as the age lane.**

| Rule | How the drop path meets it |
|---|---|
| Rebuild pass | A drop is first applied only on a rebuilding pass. |
| Frozen replay | The drop is persisted (tag status and drop mode) and replayed on every pass, so the reasoning removal replays with it. No extra state is needed. |
| Contiguous prefix on prefix-bound models | On non-Anthropic routes for these models, every reasoning part older than the newest message that lost reasoning to a drop is removed as well, so the survivors are a contiguous newest suffix. |

**What this leaves as before.**

- The newest assistant is not exempted on this path. The drop decides, as before, and the protected window keeps recent tags from being dropped.
- Canonical Anthropic gets no new prefix closure, which keeps its bytes identical.

**One-time change after upgrade.** On non-Anthropic routes, a session that already holds drops beside reasoning sees its `[cleared]` reasoning leave the wire on the first pass after the upgrade. That rewrites the cached prefix once. It cannot be deferred without writing `[cleared]` again.

### Forced call skeleton beside reasoning (OpenCode)

`requiresToolArcSkeleton` (issue 423) keeps the real arguments of a dropped call whose assistant message carries reasoning, so Anthropic cannot merge signed turns. It applied on every provider and kept 190 KB (about 47K tokens) of call arguments in tonight's request.

It now applies only on Anthropic-family routes (`isAnthropicFamilyRoute`):

- canonical `anthropic`;
- any provider id containing `anthropic` (Vertex and custom ids);
- Bedrock;
- any Claude model behind another provider, such as Copilot or OpenRouter.

On other routes the flag is cleared on the tag targets right after tagging, so emergency drops and the legacy conversion remove the pair fully. An unknown provider keeps the skeleton. Skeletons already persisted as `skeleton_real` keep replaying; only new decisions change.

### Pi (packages/pi-plugin)

Pi is the parity reference. It already clears typed thinking on every provider. `clearOldReasoningPi` has no provider gate. It empties `thinking` and drops `thinkingSignature`, which carries the OpenAI reasoning item and its encrypted content. Every Pi serializer drops empty thinking, so the block already leaves the wire on every route. Two guards are missing, and this change adds them:

- **Newest assistant:** never selected. The newest assistant has the highest tag, and replay covers only tags at or below the watermark, so a watermark below its tag cannot reach it on a later defer pass.
- **Prefix-bound models:** the selection watermark is clamped to just below the first reasoning-bearing assistant that cannot be cleared (a redacted block, or an untagged message), so no gap opens.

The emptied shape stays as it is. Changing it to a splice would change Pi's working array for existing sessions without changing the wire. Native `providerPayload` reasoning (`canClearNativeReasoning`) keeps its existing gate. That gate concerns a different payload, Responses history captured by OMP, and is out of scope.

### Rust module (crates/mc-module)

Rust already has a whole-block removal lane: the `reasoning_age` frozen strip unit, used by Claude Code and replayed by `remove_frozen_historical_reasoning`. For the OpenCode profile on a provider other than canonical `anthropic`, the reasoning cutoff is now captured on bust passes, and `reasoning_age` units are minted for eligible messages. The eligibility rules are the ones listed above. Canonical Anthropic keeps its `reasoning_clear` lane unchanged. Units are minted only when `is_bust_pass` holds, persisted with the other frozen units, and replayed unchanged on defers.

## 2. Emergency drop: a minimum reclaim per pass

`planEmergencyDrop`, used by OpenCode and by Pi, now computes the reclaim its selection would actually achieve and commits only when that clears a minimum:

```
minimum achievable reclaim = 2,000 tokens (EMERGENCY_MIN_ACHIEVABLE_RECLAIM_TOKENS, equal to the rearm constant)
```

**Why this number.** In the evidence, each pass reclaimed 28 to 149 tokens against a 9,200-token gap and rewrote a prefix of roughly 300K tokens every time. A fixed 2,000-token floor blocks every observed pass. A share of the gap (10%) was tried and rejected: it would have skipped a 10K-token reclaim against a 177K gap, a pass worth having, and the existing planner tests encode that case.

**When the pass is skipped:** it is a no-op with a logged reason, and the pressure-episode latch is not consumed.

**Floor above ceiling:** when the estimated fixed floor alone exceeds the ceiling, the reason says so plainly, for example: `fixed floor ≈326000 already exceeds ceiling 251000: tool drops cannot reach the target`.

Rust's `select_emergency` gets the same rule and constant. Instead of a reason string, its assessment records `floor_above_ceiling` and `skipped_below_minimum_reclaim`, and the module logs both through `tracing`. Another mutation that already prices the pass (TS `passAlreadyPriced`, Rust `pass_already_busting`) lifts the minimum, because riding an existing rewrite costs nothing extra.

## Considered and dropped: exempting unseen tool results

A third guard was considered: never let an automatic lane drop a tool result before a completed later step has read it. It was dropped before implementation. Removing old reasoning removes the cause, and the minimum reclaim per emergency pass already stops a pass from discarding a small fresh result for nothing. The unseen check would add a walk of the message array on every pass and three implementations (OpenCode, Pi, Rust) to keep in sync, without preventing anything those two changes do not.

## Where TypeScript and Rust differ from Pi after this change

| Technique | Pi (reference) | OpenCode TS | Rust (`opencode-aisdk`) |
|---|---|---|---|
| Age-based reasoning removal | All providers. Thinking is emptied and its signature dropped, and the serializer then drops the block. The watermark is now bounded below the newest assistant and is a contiguous prefix on bound models. | Canonical Anthropic: unchanged `[cleared]` → sentinel lane. Every other route: whole-part removal from a frozen id set. | Canonical Anthropic: unchanged `reasoning_clear` shells. Every other route: frozen `reasoning_age` whole-block removal. |
| Reasoning side effect of a drop | None; reasoning is left to the age lane. | Removed with the drop (sentinel on Anthropic, splice elsewhere); never `[cleared]`. | None; reasoning is left to the age lane. The native encoder also drops historical reasoning from assistant messages whose parts changed. |
| Forced skeleton beside reasoning | Exempt only for `openai-responses` and `openai-codex-responses`. | Anthropic-family routes only. | No blanket rule; only a targeted separator safeguard. |
| Native Responses reasoning items | Codex API with compat flags (`canClearNativeReasoning`), unchanged. | Covered by whole-part removal, because the encrypted payload lives on the part. | Covered by whole-block removal. |

## Replay and byte identity

| Lane | Selection | Persisted as | Defer pass |
|---|---|---|---|
| OpenCode non-Anthropic removal | rebuilding passes only | message id set in the replay document | splices the same ids at finalize |
| OpenCode drop-path removal | the drop's own rebuilding pass | the persisted drop (tag status and mode) | drop replay neutralizes again; finalize splices (non-Anthropic) |
| Forced skeleton scope | new drops and new legacy conversions only | the persisted `drop_mode` | already persisted modes replay unchanged |
| OpenCode canonical Anthropic | unchanged | unchanged watermark | unchanged |
| Pi | rebuilding passes only | existing watermark, now clamped | existing replay |
| Rust | bust passes only | `reasoning_age` frozen units | existing unit replay |
| Emergency minimum reclaim | only changes what a rebuilding pass selects | nothing new | drops already applied replay as before |

## Real-host wire evidence (recorded after implementation)

**Setup.**

- **Harness:** `packages/e2e-tests/src/repro/reasoning-removal-real-host.ts`.
- **Host:** the installed OpenCode **1.18.30** (`opencode-stock-1.18.30`), running `serve` with the locally built plugin (`packages/plugin/dist`).
- **Fixture:** a plugin listed before Magic Context. On every request it prepends the same single-turn tool loop: 40 assistant steps, each with `step-start`, a reasoning part carrying provider metadata, a completed `bash` call and `step-finish`.
- **Endpoints:** every route is a loopback recorder that rejects the request after OpenCode has serialized it. The captures therefore prove the wire shape and its replay, not provider acceptance.
- **Isolation:** one throwaway root per scenario under `$TMPDIR/magic-context/reasoning-removal/run3/`, holding HOME, all XDG roots, `OPENCODE_DB` and `MAGIC_CONTEXT_STORAGE_DIR`. After every scenario, `lsof -p <host pid>` listed only the `wire.db` and `context.db` files (plus their WAL and SHM files) inside that root.

**What each scenario does.**

- **age** (`clear_reasoning_age=10`): passes 1 to 3 are three prompts in one session. Pass 1 is the session's first pass, which is a rebuilding pass. Passes 2 and 3 are defer passes.
- **drop** (age lane idle): passes 1 and 2 serve the loop as is. A `drop` is then queued for `call_fx_5`, and `/ctx-flush` makes pass 3 a rebuilding pass. Pass 4 is a defer pass.
- **Prefix hash:** compares the serialized history before the newest tool-result segment.

| Route (adapter) | Lane | Reasoning blocks of 40 on the wire, by pass | Encrypted payloads / signatures | `[cleared]` | Fixture prefix hash across later passes |
|---|---|---|---|---|---|
| `anthropic` (`@ai-sdk/anthropic`, signed thinking) | age | 1 / 1 / 1 | 1 signature | 0 | identical on passes 1–3 |
| `anthropic` | drop | 2 / 2 / 2 / 2 (tool calls 40 → 39) | 2 signatures | 0 | identical on 1–2; identical on 3–4 |
| `vertex-eu-anthropic` (`@ai-sdk/google-vertex/anthropic`) | age | 9 / 9 / 9 | 9 signatures | 0 | identical on 1–3 |
| `vertex-eu-anthropic` | drop | 40 / 40 / **38** / 38 (tools 40 → 39) | 40 → 38 signatures | 0 | identical on 1–2; identical on 3–4 |
| `openai` (`@ai-sdk/openai` Responses, `store:false`) | age | 9 / 9 / 9 | 9 `encrypted_content` | 0 | identical on 1–3 |
| `openai` | drop | 40 / 40 / **38** / 38 (tools 40 → 39) | 40 → 38 `encrypted_content` | 0 | identical on 1–2; identical on 3–4 |
| `google` (`@ai-sdk/google`, Gemini 2.5 Pro) | age | 9 / 9 / 9 | 9 `thoughtSignature` | 0 | identical on 1–3 |
| `google` | drop | 40 / 40 / **38** / 38 (tools 40 → 39) | 40 → 38 thought signatures | 0 | identical on 1–2; identical on 3–4 |

**Reading the rows.**

- The newest assistant's reasoning and the newest tool result were on the wire in every pass.
- Canonical Anthropic keeps only one or two blocks because its existing merged-reasoning lane keeps at most one reasoning block per run of consecutive assistant messages. That lane is unchanged.
- On the drop rows, the drop removed the tool call and its owner message. The reasoning the drop invalidated left the wire with no `[cleared]` text, on the rebuilding pass only.

**Worker shape (OpenAI, 300 steps, about 3 KB `encrypted_content` each).**

| Run | Request bytes | Reasoning items | Newest tool result present |
|---|---:|---:|---|
| age lane idle (control) | 1,458,451 | 300 | yes |
| this change | **494,863** (−66 %) | 9 | yes |

The 494,863-byte request was byte-identical in its fixture prefix across the two defer passes that followed. At about 0.25 tokens per byte, the control is about 365K tokens and the new request about 124K. That is below the ~251K ceiling logged in the incident, and the reduction comes without dropping any tool result.

**Not covered by this run.** The forced-skeleton scope needs a pressure-driven emergency drop, which requires provider usage numbers; the recorder returns none. It is covered by the unit test of `isAnthropicFamilyRoute` and by the transform wiring, but not on a real host.

## What this note cannot settle offline

Provider acceptance cannot be proven offline. The open questions, each with the live call that would settle it:

1. **OpenAI Responses (Codex OAuth, `store:false`), removed reasoning mid-turn.** Does the service accept the worker's own turn with the reasoning items of older steps removed while their `function_call` items stay? Send tonight's body twice, as-is and with every reasoning item older than the 10 newest removed, and compare status, `usage.input_tokens` and `cached_tokens`.
2. **OpenAI `previous_response_id` and WebSocket suffix continuation.** openai-auth may send only a suffix and rely on server state. Does a server-held prior response restore reasoning that the client dropped? Run one continuation with `previous_response_id` after a removal pass.
3. **Vertex-Anthropic and Bedrock, removal of an oldest prefix of signed thinking.** Send three completed turns, then a request with the first two thinking blocks removed. On binding models (Opus 5.5, Fable 5.1), add `prefix_mismatch_behavior:"error"`.
4. **Gemini, thought parts removed beside retained function-call signatures.** One Gemini 2.5 call and one Gemini 3 call, each with older thought parts removed.
5. **Copilot Claude, reasoning part (and its `reasoning_opaque`) removed.** One call.
6. **Unsigned chat routes (DeepSeek, Kimi), function-call pairs fully removed.** One call each, with an older pair removed beside retained `reasoning_content`.
