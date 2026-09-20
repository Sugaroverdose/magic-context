# Pi transcript system state (issue 485)

## Source contract inspected

The tests pin **Pi 0.86.0** using dev-only aliases `pi-ai-086` and
`pi-coding-agent-086`; the existing 0.83.0 development host remains installed to
exercise the older, system-entry-free lane. No runtime dependency or version gate
was added. The host-behavior e2e resolver selected **0.86.0**.

References below are to the published 0.86.0 package files, inspected in the
isolated install under `packages/e2e-tests/.pi-086/node_modules/` (and reproducible
from the pinned aliases). Paths beginning `pi-ai/` are inside
`@earendil-works/pi-coding-agent/node_modules/@earendil-works/` in that install.

* `pi-ai/dist/types.d.ts:321-346`: `SystemMessage` has `role: "system"`,
  `content: string | TextContent[]`, ordered named `sections` (null deletes),
  `toolsAdded`, `toolsRemoved` (name references), and timestamp. No message-level
  id; the surrounding journal entry supplies its id and parent link.
* `pi-ai/dist/utils/transcript.js:6-16`: initial system content and complete tools,
  timestamp zero. Lines 28-38: role-only predicate; initial-system lookup examines
  **index zero only**. Lines 41-51: tools fold in array order, removing names before
  setting additions. Lines 58-90: content concatenation and ordered section updates
  produce the effective prompt. Lines 195-202: addition-capable transports use
  **the initial message's tools**, otherwise the replayed current tools. Merely
  preserving the entries somewhere in the array is insufficient.
* `pi-ai/dist/api/openai-responses.js:209`,
  `openai-responses-shared.js:91`, `openai-codex-responses.js:378`,
  `azure-openai-responses.js:205`, `openai-completions.js:566,895`: adapters use
  `resolveTranscriptTools(context.messages, ...)`.
* `pi-ai/dist/api/anthropic-messages.js:336,866`,
  `mistral-conversations.js:362`, `google-vertex.js:357`,
  `google-generative-ai.js:287`, `bedrock-converse-stream.js:153`: current tools
  come from transcript system entries, not MC's live registry. Transcript
  normalization/collapse (`utils/transcript.js:96-104`) retains system semantics
  for adapters that cannot send mid-conversation system messages.
* `@earendil-works/pi-coding-agent/dist/core/session-manager.js:835-851`:
  `appendCompaction` resolves the current system state **before** appending and
  records `systemMessage` with the marker's timestamp. Lines 187-189 re-emit
  `[systemMessage, summary]`. Lines 216-227 skip pre-marker system messages even
  in the kept window, then append post-marker entries without filtering.
* `.../dist/core/extensions/runner.js:551-553`: the runtime extension context
  returns the actual session manager. MC's existing
  `context-handler.ts::resolvePiAppendCompaction` binds its `appendCompaction`
  method reflectively (it is not in Pi's readonly public interface).
  `compaction-marker-manager-pi.ts::applyDeferredPiCompactionMarker` calls that
  method, **not a direct journal writer**. The 0.86.0 physical-session regression
  proves that this route records the host system snapshot. If a future host stops
  exposing the method, the existing unavailable-method path keeps the marker
  pending; no unsafe direct-write fallback was added.

Installed OMP here is **18.2.6**, not the separate peer's 17.0.4.
`node_modules/.bun/@oh-my-pi+pi-ai@18.2.6/node_modules/@oh-my-pi/pi-ai/src/types.ts:1384-1388`
still declares `Context { systemPrompt?: string[]; messages; tools? }`; no
`toolsAdded`/`toolsRemoved` shape is present. The role predicate is inert for that
host's current transcript.

## Audit of mutation paths

All paths below are in `packages/pi-plugin/src/` unless explicitly described as
shared consumers. Existing role-specific guards are retained rather than adding
redundant guards to every assistant/user operation.

| Site | Previous treatment of system entries | Required behavior / delivered verification |
| --- | --- | --- |
| `inject-compartments-pi.ts::trimPiMessagesToBoundary` | Every prefix index entered removal set; both fold and cached replay lost declarations | Shared predicate exempts every system entry, preserving order and aligned ids; trim regression and mutation proof |
| `prependM0M1Messages`, `replayCompletePiPrefix`, prepared-prefix replay | Unshifted two users ahead of initial system | Insert after the entire leading system run. Synthetic prefix span includes that run, while saved prepared bytes contain only MC's two users. Five-pass byte test pins initial tools and exact roles |
| `transcript-pi.ts::buildTranscriptView` | Surfaced system as opaque transcript messages with zero mutable parts (already untagged) | Omit from the mutable transcript view, retain original source entry; no tag targets or shared drop/caveman/image/reasoning operations can reach it |
| Shared `tagTranscript` / Pi `tools/ctx-reduce.ts` / pending and persisted drop application | Operate on transcript/tag targets | System entries never acquire new tags or targets. Requested nonexistent system tag rejected; no pending operation. Existing stale persisted tags cannot acquire a mutable system target |
| `heuristic-cleanup-pi.ts`, shared emergency planner, age reclaim | Target-based cleanup; tool fingerprinting reads assistant/toolResult | Exclusion at transcript boundary prevents targeting. Tests supply usagePercentage=95, 95,000 input / 65,000 ceiling; mixed interleaved fixture proves actual tool reclamation and exact system bytes survive |
| `tail-hygiene-walk-pi.ts` | Already classified role=system as synthetic | Uses shared predicate now; zero reclaimable t/u and excluded zero-token parts are asserted |
| `read-session-pi.ts::convertEntriesToRawMessageRange` | Unknown role emitted as empty raw message and consumed an ordinal | System entries no longer consume foldable ordinals or historian chunk space. They are protocol state, not historian prose. Session journal remains authoritative; no tool definitions are sent to the summarizer |
| `pi-historian-runner.ts::findFirstKeptEntryId` | Derives boundary from raw conversion | System entries cannot be selected as new foldable boundaries because conversion excludes them. Existing supplied boundaries are host-handled: snapshot carries the complete pre-marker state even if a kept-window system is skipped |
| `compaction-marker-manager-pi.ts` and context-handler drain | Calls real host `appendCompaction`; old projection assumed summary only | Keep host consolidation per parent ruling. On the successful drain pass, adopt its system snapshot immediately; remove MC-owned summary at offset 1 on later reads, mirror two-entry alignment, skip already-consolidated system entries in kept-window id projection |
| `pi-lkg.ts` | Serialized full arrays but prefix shaving could discard system-owned entries; old slots could replay lost declarations | Preserve system entries in prefix filter; do not label head system as synthetic ownership. Reject legacy slots missing current system entries. Full snapshot, shaving, and legacy rejection tests plus mutations |
| `native-replay-pi.ts` / `native-replay-state-pi.ts` | State replay already assistant-only; low-level envelope helpers accepted arbitrary roles | Low-level envelope lookup also excludes system, so even an opaque provider payload is unchanged; targeted mutation test |
| `clone-inheritance.ts::createCloneFilter` | Copies MC state, not source message arrays; uses raw conversion | No source system rewriting. Message tags/boundary ordinals inherit only foldable raw messages after conversion exclusion; normal clone suite passes |
| `strip-placeholders-pi.ts` | Explicit assistant-only removal | Verified guard retained; no system deletion |
| `temporal-awareness-pi.ts` | Only user content receives/loses temporal markers | Verified user-role guards; system bytes unchanged |
| `pi-todo-inject.ts` | Assistant-only anchors and paired result insertion | Verified assistant guards; no system mutation |
| `auto-search-pi.ts` | Latest meaningful user anchor only | Verified user guard; no system mutation |
| `tokenize-pi-messages.ts` | Conversation accounting for user/assistant; tool accounting for toolResult | No system mass enters reclaimable conversation/tool totals |

## Position, marker, cache, and compatibility evidence

Before native consolidation, the example fold serves
`[initial system, promoted system delta, m0 user, m1 user, retained user]`.
Later deltas that still have intervening retained content stay in place. The
leading system run is never reordered relative to itself. Initial lookup and
anchored request tools therefore retain all 70 definitions.

The parent explicitly ruled that native compaction may consolidate original
system entries, provided **effective prompt and tools** remain equal. The physical
0.86.0 test includes 70 initial tools, a 15-tool re-addition, a tool removal, empty
system content, and a section replacement/deletion. Pi's own resolvers prove equal
prompt text and tools before/after the actual marker. MC user prefix messages
cannot enter the snapshot because the host resolves its journal, and only system
roles contribute. The marker pass immediately serves the host snapshot at zero,
then m0/m1. Its timestamps match subsequent replay injection. Four consecutive
defer passes, a reopened physical session with cleared handler state, and LKG
replay are byte-identical. A later tool addition is retained after the marker and
resolves against the snapshot head.

Thus both failure vectors are addressed: **fold-time tool loss** and **head
injection hiding the initial declarations**. Pi's consolidation snapshot also
matches the pre-marker effective state. No permanent suppression of native
markers was introduced.

System-entry-free compatibility is exercised by the unchanged pure-replay and
marker fixtures in the full suite (development host 0.83.0; this proves the old
message shape, not a separate installed 0.85 binary). The existing deploy
transition fixture printed identical pre/defer1/defer2/restart SHA-256
`cff0f81850cc8413c11d6d0d7a17aa20817ef9bece6f6639b71feac2f58ad416`.

## Verification

* Red-first: the initial three new tests all failed on the original trim,
  transcript view, and historian ordinal behavior.
* `bun run typecheck` at repository root: passed.
* Biome **2.5.1**, both packages: plugin passed; Pi full lint has an unchanged
  formatting error at `src/clone-inheritance.test.ts:204` and 41 warnings.
  Changed-file lint passed with only two pre-existing context-handler warnings.
* Full Pi suite: **1205 pass, 1 skip, 0 fail** (1206 tests / 99 files).
* `bun run build` in Pi package: passed.
* `bun test tests/pi-*.test.ts` in e2e package: **7 pass, 0 fail**, host resolver
  **0.86.0**. First attempt required building Pi dist; rerun after build passed.
* No shared `packages/plugin/src/` files changed; full OpenCode suite was not
  required. Its typecheck and pinned lint passed.
* AFT inspection had unavailable LSP producers; tsc is the authoritative check.
* Root frozen install and post-alias frozen install passed. Aliases are test-only.
* Ten independent mutations each failed exactly its selected named test; every
  mutant was staged-safe, marked `NON-VACUITY BREAK`, restored, touched, and
  verified with empty unstaged diff. Details: `issue-485-mutations.json`.

The transcript-view mutation asserts structural exclusion (zero exposed messages),
not a pre-existing tag-prefix corruption: the old opaque path already had zero
parts. The emergency exclusion test verifies that there is no system mutation
target; the separate mixed fixture additionally requires actual tool reclamation
at 95 percent with unchanged interleaved system entries.
It does not claim that emergency can reclaim any system tokens.
