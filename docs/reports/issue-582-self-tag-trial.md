# Issue 582: self-tag trial — harness delivered, live measurement blocked

## Status and decision boundary

**No real models were called. This report cannot answer whether models reliably self-tag.** Live measurement is blocked on the operator's credential decision. The task owner explicitly narrowed this delivery to the real tagging probes, trial plumbing, and an isolated OpenCode 1.18.30 mock-provider proof, and instructed the worker to stop before any real model call.

Broca was not used. Its historian route takes `prompt` and optional `system` (`crates/mc-module/src/historian_producer.rs:801-854`); the owner confirmed that Broca owns the transcript/tool loop and cannot replay the required native tagged history. There was no approved connection-file environment in this worker. No credentials, live configuration, or live databases were read or copied.

**Do not use the offline/control percentages below as evidence of model compliance.** They exercise plumbing. In offline variant B the harness deliberately constructs the expected number from real tagger assignments; this is an oracle control, not an LLM.

## Exact tagging rule, read and exercised

The counter is session-global, not per-message and not derived by scanning visible `§N§` strings. Allocation uses the maximum of memory counter, persisted counter, and database maximum, plus one (`packages/plugin/src/features/magic-context/tagger.ts:438-488`; reload reconciliation at `:809-855`). Existing identities reuse their numbers. Numbers do not ordinarily rewind after a drop.

The tagger walks messages and parts in array order (`packages/plugin/src/hooks/magic-context/tag-messages.ts:564-581`). Each nonblank text part with a message ID uses the identity `messageId:p<partIndex>` (`:727-733`), resolves an existing identity, or assigns the next number (`:805-838`). Prefix injection is exactly the production `prependTag` call (`:862-864`). Fresh whitespace-only assistant parts consume no number (`:731-800`). Reasoning is accounted on text/tool tags, not tagged independently (`:572-575`, `:826-836`, `:917-938`).

Tools are important: an invocation without a completed output does **not** allocate a fresh number. Output-bearing tool parts allocate through `assignToolTag` only when needed, using `(session, owner message, call ID)` (`:588-725`, `:888-938`). Separate results pair to owners through FIFO resolution (`:590-615`). Parallel completed tools each consume a number in part order. An existing tool result reuses its assigned tool tag. In OpenCode, completed tool parts live on the assistant message.

Observed first-pass probes (one user part already received `§1§`):

| New assistant parts, in order | Numbers observed |
|---|---|
| text `one` | text 2 |
| text `one`, text `two` | text 2, text 3 |
| reasoning, text | reasoning none, text 2 |
| text, completed tool | text 2, tool output 3 |
| completed tool A, completed tool B, text | tool output 2, tool output 3, text 4 |
| invocation only | none until its result exists |
| whitespace-only text | none |
| invocation plus separate tool-result message | output 2, bound to invocation owner |

Raw probe arrays and assignments are in `issue-582-self-tag-probes.json`; these are produced by **real `tagMessages`**, not a numbering simulation. Unit tests additionally exercise persistence, parallel output order, and materialized reduction.

### Implication for the proposed instruction

“One more than the highest visible tag” is sufficient only when that visible maximum equals the allocator counter and no earlier newly allocated part precedes the text. It is not a universal allocation rule: multiple text parts require distinct numbers; completed tools preceding text consume numbers; dropped/absent content can hide the maximum; quoted head strings can exceed the actual counter. The mock head contains literal `§9001§`, while the next assistant gets 2, not 9002. This is a structural ambiguity worth testing live, not proof that any particular model fails.

## Guidance variants

Base A uses the **full primary, with-`ctx_reduce`** section from `buildMagicContextSection(null, 0, true)` unchanged (`packages/plugin/src/agents/magic-context-prompt.ts:157-168,203-206`). In the real host, Magic Context composes the normal system guidance; the wrapper delegates first, then appends B as an additional system entry. The mock proof records both system surfaces and checks that only B contains the addition.

B adds exactly:

> Start the text of each reply with exactly §N§ followed by one space, where N is one more than the highest tag number in the conversation. Never write tags anywhere else: not mid-text, not in tool arguments, and not on tool-call-only replies.

C was not attempted: no live B failure exists to justify an example.

## Harness and reproducibility

All committed implementation is under `packages/plugin/scripts/self-tag-trial/`. No product code, product guidance, tagger, architecture document, or structure document was changed.

- `bootstrap.ts`: isolates HOME, XDG paths, plugin storage, logging, and host DB before dynamic imports. Throwaway DBs live below `$TMPDIR/magic-context/self-tag-trial/`.
- `engine.ts`: OpenCode-shaped arrays; actual `createTransform`; actual `tagMessages`, `applyPendingOperations`, batch finalization; persistence strip; append; next-pass assignment and text readback. The direct engine has no host client, so no real synthetic m[0]/m[1] (the two leading injected history/memory messages) is composed there. It explicitly drives pending operations with a set protecting the five newest allocated tags to exercise their materialization independently of host usage scheduling. Reduction queues the same storage operation consumed by the production helper; it does not implement an alternative drop algorithm.
- `probes.ts`, `engine.test.ts`: exact part-numbering and byte-identity controls.
- `offline.ts`: six deterministic multi-turn plumbing sessions (A/B × fresh/reduced/literal record), each 12 user turns; four-step tool loops on turns 3 and 8, mixed text/tools, parallel tools, reasoning, and tool-only responses. Reduced sessions queue a `ctx_reduce`-shaped operation for tool 31; production passes produce `[dropped §31§]`. Final sessions reach reply positions above 20. The literal-record offline case is a user record, **not** a real head; real head testing belongs to the host proof.
- `scenarios.ts`: 12-turn prompt manifests for the eventual host-driven live sessions. Their tools are deterministic fixture read, echo, and list. Real live runs are intentionally not wired to credentials.
- `host-adapter.ts`: one native model-caller interface (`send`, `close`) and the OpenCode implementation. The only currently enabled factory is mock-backed; an operator-authorized provider factory must be added before live runs. OpenCode, not a flattened prompt adapter, owns the native roles/tool loop and persistence.
- `host-plugin.mjs`: harness-only wrapper around this worktree's built `dist/index.js`. It captures `experimental.text.complete` **before** delegating to Magic Context, then records the stripped text. It records messages after the real transform and system after the real composer. The raw capture does not depend on ordering two independently registered plugins. It adds deterministic `trial_read`, `trial_echo`, `trial_list`; `ctx_reduce` remains Magic Context's real tool. For the literal-head proof only, it appends a quoted memory string to the real synthetic m[0] **after** delegation. No test-only product hook is needed.
- `host-probe.ts`: A/B pinned-host proof, two text turns plus one parallel mixed tool turn; validates raw capture, persisted strip, next-pass replay, B guidance, deterministic tools, real head literals, and sampled `lsof` isolation. Rows lacking a subsequent pass are marked `pending-next-pass`, never counted as byte-identical successes.

From repository root:

```sh
bun install --frozen-lockfile
bun run --cwd packages/plugin build
BASE="${TMPDIR:-/tmp}/magic-context/self-tag-trial"
mkdir -p "$BASE/host"
bun add --cwd "$BASE/host" --exact opencode-ai@1.18.30
bun packages/plugin/scripts/self-tag-trial/probes.ts docs/reports/issue-582-self-tag-probes.json
bun packages/plugin/scripts/self-tag-trial/offline.ts docs/reports/issue-582-self-tag-offline.jsonl
PATH="$BASE/host/node_modules/.bin:$PATH" bun packages/plugin/scripts/self-tag-trial/host-probe.ts docs/reports/issue-582-self-tag-host-proof.json
bun run --cwd packages/plugin typecheck
bun test packages/plugin/scripts/self-tag-trial/engine.test.ts
```

Verification: package typecheck passed; five focused unit tests passed; A/B mock host proof passed. A safe fence mutation returned no forbidden paths: only `live-store fence rejects forbidden lsof entries` failed, while the four tagging/persistence tests stayed green; staging/restoration left no mutation diff. Formatting was attempted with `bunx --no-install biome format --write packages/plugin/scripts/self-tag-trial` but the repository's existing `biome.json` contains a `rules.preset` key rejected by the installed Biome. No formatter edits occurred.

The dependency install modified no tracked manifest or lockfile. The pinned host was installed only in the throwaway root. The worktree's standard build succeeded; generated files remained unchanged/untracked build output was not committed.

## Mock host end-to-end evidence

`issue-582-self-tag-host-proof.json` contains the provider request bodies, instrumented native messages including actual synthetic m[0]/m[1], raw/stripped hook events, and full sampled `lsof -Fn -p <host pid>` output for each variant. `issue-582-self-tag-host-proof-rows.jsonl` contains the measured reply rows. These are **mock provider responses, not model behavior**.

For both A and B:

| Boundary | Observed text |
|---|---|
| Scripted provider text / pre-strip hook capture | `§2§ RAW_SENTINEL` |
| Post-Magic Context persistence hook | `RAW_SENTINEL` |
| Next actual host transform | `§2§ RAW_SENTINEL` |

The proof asserts those three values directly, rather than computing the expected tag with the implementation under test. A later scripted reply mixes `§6§ Inspecting fixtures.` with parallel `trial_read`/`trial_list` calls. The actual next loop contains fixture outputs `apples=3` and `README.md` and literal `§9001§` in the head.

Two mock sessions produced 10 provider requests: 8 main-agent calls plus 2 title-generation calls. Mock-declared usage totals: **980 input tokens, 70 output tokens**. These are synthetic usage values and imply neither paid spend nor live-model token counts. Real-model calls, real-model tokens, and real-model spend: **0**.

`lsof` evidence is a sampled host-PID check, not continuous tracing or a proof about every descendant. Both samples contain **zero forbidden live-store/config paths**, and each host data directory is checked below the trial run's temporary root. Full evidence is committed, not just an assertion in this report.

## Offline rows (plumbing controls only)

Raw rows: `issue-582-self-tag-offline.jsonl` (122 replies, 108 text rows and 14 tool-only rows). Snapshots: `issue-582-self-tag-offline-snapshots.json`. A never constructs self-tags. B constructs correct self-tags on final responses only; intermediate tool-loop text deliberately stays untagged. Therefore these counts are expected by construction and say nothing about instruction efficacy.

| Control variant | Reply positions | Text rows | Well-formed starts | Correct number | Byte-identical |
|---|---|---:|---:|---:|---:|
| A | 1 | 3 | 0 | 0 | 0 |
| A | 2–5 | 9 | 0 | 0 | 0 |
| A | 6–20 | 41 | 0 | 0 | 0 |
| A | 20+ (strictly >20) | 1 | 0 | 0 | 0 |
| B | 1 | 3 | 3 | 3 | 3 |
| B | 2–5 | 9 | 3 | 3 | 3 |
| B | 6–20 | 41 | 29 | 29 | 29 |
| B | 20+ (strictly >20) | 1 | 1 | 1 | 1 |

Example literal rows, not percentages alone. “Assigned” is the actual allocated tag number; byte identity compares raw provider text with stripped-and-retagged text on the next pass:

| Model/control | Variant | Session | Position | Raw beginning | Assigned | Outcome |
|---|---|---|---:|---|---:|---|
| offline-control-not-a-model | A | A-fresh | 1 | `There are seven fruit.` | 2 | untagged; byte mismatch |
| offline-control-not-a-model | B | B-fresh | 1 | `§2§ There are seven fruit.` | 2 | correct; byte identical |
| offline-control-not-a-model | B | B-fresh | 3 | `Inspecting the fixture.` | 6 | untagged tool-loop text; byte mismatch |

The engine records signed numeric error, malformed notation, mid-text tags/tool-argument tags, and byte comparison independently. Unit controls include wrong `§9002§` (assigned 4, delta +8998), malformed `§5\">`, and mid-text `§12§`. The persistence function removes leading, global complete, malformed, dangling and stray notation **and trims whitespace** (`packages/plugin/src/hooks/magic-context/tag-content-primitives.ts:88-96`). A correct number alone is insufficient: trailing whitespace or incidental literal tags still defeat byte identity.

## Live results — blocked, not zero-percent compliance

`issue-582-self-tag-live.csv` has only its schema header. No synthetic model rows are included there. Per-model/per-variant and position-bucket tables remain unmeasured:

| Requested model | A sessions/calls/tokens | B sessions/calls/tokens | Quality examples | Status |
|---|---|---|---|---|
| gpt-5.6-luna | not run | not run | unavailable | credentials decision pending |
| gpt-5.6-sol | not run | not run | unavailable | credentials decision pending |
| Gemini Flash 3.7 or 3.8 | not run | not run | unavailable | credentials decision pending |
| deepseek-v4-flash | not run | not run | unavailable | credentials decision pending |
| Claude Sonnet 5 or Opus 5.5 | not run | not run | unavailable | credentials decision pending |

For each eventual model × variant × bucket (1, 2–5, 6–20, >20), populate well-formed starts, correct numbers, signed wrong-number deltas, malformed notation, misplaced tags, byte identity, and denominators with raw rows. Tool-only messages need separate denominators, not missing-tag failures. Add 2–3 actual quoted answer examples per model, comparing A/B qualitatively. No answer-quality conclusion is possible from a scripted provider.

### Next action for the owner

Authorize the throwaway host's credential/provider route without copying secrets into this repository; add the approved provider factory to the single host adapter; drive the three prompt manifests per model/variant; correlate raw hook message/part IDs with subsequent real transform parts and DB assignments. Flush the last reply through a next pass before counting it. Use the real host's `ctx_reduce` call and confirm placeholders were actually served. Verify full guidance remains A unchanged/B appended, and retain actual usage/call counts. Only then decide whether explicit self-tagging is reliable enough for cache identity. The present delivery is a reproducible prerequisite, **not the completed live trial**.
