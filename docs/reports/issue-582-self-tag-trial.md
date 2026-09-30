# Issue 582: live DeepSeek self-tag trial

**Actual API response identity: `deepseek-flash`.** Every measured benchmark response returned that exact `model` field. DeepSeek's [pricing/model page](https://api-docs.deepseek.com/quick_start/pricing), accessed 2026-09-30, maps this alias to **DeepSeek-V4.1-Flash**; the responses themselves do not expose an immutable v4.1 snapshot ID. The person supplying model access authorized `deepseek-flash` after the API rejected `deepseek-v4.1-flash` and listed `deepseek-flash` as its supported Flash name. No other model was benchmarked.

## Result

**B improves compliance, but does not make self-tagging reliable enough for a byte-identity invariant.** Across seven sessions per variant, stripped-and-retagged text equaled raw provider text for **114/153 A text parts (74.5%)** and **142/153 B text parts (92.8%)**. B's first reply was correct in all seven sessions, but its first text-plus-parallel-tools reply was missing the tag in **every session**. Correct prefix numbers were not the problem: there were **zero wrong numeric prefixes**. Missing prefixes, tag-only tool framing, and mid-text/dangling tags still broke byte identity.

This is a small, controlled benchmark, not a general result about other models, thinking mode, or provider WebSocket cache behavior. The measured property is the exact assistant-text equality those continuation routes need. A 92.8% success rate is not an every-reply guarantee.

## Real tagging rule

Allocation is session-global, not a scan of visible tag-shaped strings. The allocator reconciles the memory counter, persisted counter, and database maximum, then allocates one more; existing identities reuse their number (`packages/plugin/src/features/magic-context/tagger.ts:438-488,809-855`). Removing old message text or tool outputs does not ordinarily rewind the counter.

All abbreviated colon-prefixed references in the following paragraphs refer to `packages/plugin/src/hooks/magic-context/tag-messages.ts`.

`tagMessages` walks messages and parts in array order (`packages/plugin/src/hooks/magic-context/tag-messages.ts:564-581`). Nonblank text uses identity `messageId:p<partIndex>` (`:727-733`), resolves an existing number or assigns a new one (`:805-838`), and gets the production prefix at `:862-864`. Fresh whitespace-only assistant text consumes no tag (`:731-800`). Reasoning is accounted on text/tool tags, not independently prefixed (`:572-575,826-836,917-938`).

An invocation without a completed output does not allocate a fresh tool tag. Completed tool outputs allocate through `assignToolTag`, keyed by session, owner message, and call ID (`:588-725,888-938`); separate tool-result messages pair to the invocation owner through FIFO resolution (`:590-615`). Parallel completed tools consume successive numbers in part order. OpenCode normally stores completed tool parts on the invoking assistant message.

Cases executed through the production tagger, with a preceding user text already tagged 1:

| New parts, in order | Actual assigned numbers |
|---|---|
| one text | 2 |
| two texts | 2, 3 |
| reasoning, text | reasoning none; text 2 |
| text, completed tool | text 2; output 3 |
| completed tool A, completed tool B, text | outputs 2, 3; text 4 |
| invocation only | none until a result exists |
| whitespace-only assistant text | none |
| invocation plus separate result message | output 2, bound to invocation owner |

Raw arrays and assignments are committed in `issue-582-self-tag-probes.json`. These drive real `tagMessages`, not a simulated counter. The surrounding in-process controls also use `createTransform`, `applyPendingOperations`, and batch finalization.

Consequently “one more than the highest visible tag” is not universally equivalent to allocation: earlier new text/tool parts can consume numbers, absent history can hide the maximum, and quoted head strings can be much larger. In this sample, well-formed emitted text prefixes nevertheless always matched the actual assignments. The head fixture explicitly labels `§9001§` as a quoted literal, so this is not an adversarial test of an unexplained high-numbered string.

## Guidance and execution conditions

A is the product's **full guidance for a primary assistant with the `ctx_reduce` tool available**, unchanged. Its composer is `buildMagicContextSection` (`packages/plugin/src/agents/magic-context-prompt.ts:157-168,203-206`). The harness wrapper first delegates to the real system hook; only B appends this exact additional system entry:

> Start the text of each reply with exactly §N§ followed by one space, where N is one more than the highest tag number in the conversation. Never write tags anywhere else: not mid-text, not in tool arguments, and not on tool-call-only replies.

No C variant was run. OpenCode 1.18.30 hosted the built Magic Context dist from this worktree. Provider generation was non-thinking (`thinking.type=disabled`) with a 512-token output cap, applied identically by the relay. The small fixture answers did not require long output; no benchmark response finished with a length-limit reason. No fixed seed or temperature was imposed.

### Primary and supplemental cohorts

“Fresh” starts an empty session. “Reduced” requests removal of an older fixture tool output via `ctx_reduce`. “Literal-head” adds quoted `§9001§` text to the injected memory/history head. A dropped output is represented by `[dropped §N§]` when production rules retain its tool-call skeleton.

- **Primary:** six sessions per variant, two each of fresh, reduced, and literal-head; 16 user turns each, including requested 3–6-step tool loops on turns 3 and 8, mixed text/tools and parallel calls. Every session actually made parallel calls. Reply positions extend beyond 20. Requested real `ctx_reduce` calls ran, but these sessions did **not** serve a dropped placeholder.
- **Supplemental:** one reduced session per variant, 18 user turns each. A deterministic large **tool result**, not user-only padding, displaced the protected tail. Pending reductions still did not materialize until the host was restarted and the session continued, creating a fresh transform/cache decision. Both continued sessions then served the target placeholder to actual DeepSeek requests before counting the scenario as fulfilled.

There were harness setup mistakes, retained rather than hidden: early configuration used invalid `protected_tokens=0`; the primary and first supplemental attempt also used invalid `transform_mode=typescript` instead of `ts`. Magic Context therefore fell back to its product defaults. Both variants in the primary cohort used the same defaults and real full guidance; the tagging measurements remain real, but the intended reduced protection setting was not active. The final supplemental host validates its configuration with the production schema, uses `transform_mode=ts` and `protected_tokens=4000`, and disables background historian/dreamer work. **Do not treat the pooled results as one perfectly homogeneous configuration.** Primary results are also reported separately below.

The failed supplemental attempt, interrupted pilot, and their spend are preserved separately and excluded from benchmark rates. The valid A supplemental session was resumed, not discarded and replaced with a nicer answer. B was likewise resumed after its pending operation failed to appear on the wire. No product code was changed to force a drop or repair a model answer.

## What the loop measured

The host owns native roles, history and tool execution. `host-plugin.mjs` wraps the real built plugin rather than relying on relative ordering of two separate plugins:

1. The actual messages transform composes tags and synthetic head messages m[0]/m[1], the two leading history/memory records. The literal-head scenario appends the quoted memory fixture to the real m[0].
2. The relay forwards the provider request; it never records HTTP headers. It separately observes streamed raw text, tool arguments, actual response model, finish reason and usage.
3. `experimental.text.complete` captures raw text **before** delegating to Magic Context, then records the stripped text.
4. The next real transform is observed. Raw message/part IDs locate the first subsequent replay; the allocated number is independently read from the same session's throwaway tag database.
5. A final flush runs the real transform, captures the last reply, then throws **before** any further provider call. Both mock and live adapters assert that flushing did not increment request count. Flushes are not counted as paid replies or user benchmark turns.

Every benchmark session verifies that provider-stream text and the pre-strip hook text agree, and that paid provider calls correspond one-to-one with observed assistant replies. There are no unobserved final replies counted as successes.

The production strip removes leading, global complete, malformed, dangling and stray tag notation, then trims whitespace (`packages/plugin/src/hooks/magic-context/tag-content-primitives.ts:88-96`). Correct numbers alone do not establish byte equality. Comparisons are exact string/UTF-8 text identity, with no normalization of spaces or punctuation.

Metric definitions: `wellFormed` means a closed leading `§digits§`; `canonicalPrefix` additionally requires the following ASCII space. `malformed` detects lettered, dangling or otherwise incomplete section-mark notation, including mid-text instances. A closed tag-only frame such as `§34§` is not malformed notation, but it is misplaced tool framing, has no taggable persisted text, and is not a correct-number success. Tool-only replies with **no raw text** have separate denominators. Raw streamed arguments are checked as well as arguments delivered to native tools.

## Overall benchmark results — seven sessions per variant

Each provider reply had at most one raw text part in this run. The 325 benchmark replies contain 306 raw text parts and 19 genuinely text-free tool-only replies.

| Variant | Replies | Raw text parts | Closed leading tag | Canonical prefix | Correct number | Wrong number | Malformed notation | Misplaced tags | Byte-identical text |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| A | 167 | 153 | 117 | 116 | 116 | 0 | 6 | 6 | 114 (74.5%) |
| B | 158 | 153 | 146 | 145 | 145 | 0 | 3 | 4 | 142 (92.8%) |

A had 14 and B had 5 text-free tool-only replies; none contained tags in arguments. There was one **tag-only text frame accompanying tools** in each variant, counted in the raw-text columns rather than disguised as a successful text-free reply. Malformed and misplaced categories overlap. The signed numeric delta is emitted number minus the tagger's allocated number. None was nonzero; malformed `§28a§` is not converted into a guessed numeric error.

### By reply position (all benchmark sessions)

Buckets are disjoint: 1, 2–5, 6–20, and **strictly greater than 20**. Position counts every assistant reply, including text-free tool replies; denominators below count raw text parts at those positions.

| Variant | Position | Text parts | Closed tag | Correct number | Wrong number | Malformed | Misplaced | Byte-identical |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| A | 1 | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| A | 2–5 | 24 | 12 | 11 | 0 | 0 | 1 | 11 |
| A | 6–20 | 96 | 79 | 79 | 0 | 6 | 5 | 77 |
| A | >20 | 26 | 26 | 26 | 0 | 0 | 0 | 26 |
| B | 1 | 7 | 7 | 7 | 0 | 0 | 0 | 0 | 7 |
| B | 2–5 | 28 | 21 | 21 | 0 | 0 | 0 | 21 |
| B | 6–20 | 101 | 101 | 100 | 0 | 3 | 4 | 97 |
| B | >20 | 17 | 17 | 17 | 0 | 0 | 0 | 17 |

Late-session success is encouraging but does not erase early failures. A's tendency to start copying prefixes after tagged history is served is visible here; B fixes the initial reply but not the first mixed tool reply.

### Cohorts kept separate

| Cohort | Variant | Sessions | Calls | Text parts | Correct number | Byte-identical |
|---|---|---:|---:|---:|---:|---:|
| Primary, product-default fallback | A | 6 | 138 | 129 | 97 | 96 (74.4%) |
| Primary, product-default fallback | B | 6 | 132 | 131 | 124 | 122 (93.1%) |
| Supplemental, validated config and restart | A | 1 | 29 | 24 | 19 | 18 |
| Supplemental, validated config and restart | B | 1 | 26 | 22 | 21 | 20 |

### Real dropped-history proof

| Variant | Supplemental session | Target | Durable status | Provider requests that actually served it |
|---|---|---:|---|---|
| A | `ses_f0d195cb8ffebp1ygdGT8mjsmo` | 28 | dropped | calls 27–29 |
| B | `ses_f0d0ceb8affersrAuCX1brRsg2` | 24 | dropped | calls 53–55 |

The proof checks three independent observations: an actual tool-result placeholder in the transformed wire, durable `tags.status='dropped'`, and the target number in the relay's **outgoing provider tool-result messages**. For resumed B, the relay refused to make a paid call if the required target was absent. It was present. Thus these are not merely queued reductions or model-written placeholder text. The protection window prevents recent tool outputs from being dropped. It considers **tool rows only**, always includes at least the newest three tool tags, and walks backwards until their stored token counts reach the configured budget (`packages/plugin/src/features/magic-context/protection-window.ts:104-118,168-203`); user-only padding was not an adequate way to age this window. No tail-protection product fix is included in this trial.

## Rows and answer quality

Complete raw text, first 60 characters, actual assignment, signed delta, notation/location flags, byte identity, response model and usage are committed in JSONL/CSV, not only percentages. Representative primary rows:

| Variant / scenario | Session | Position | Raw beginning | Assigned | Outcome |
|---|---|---:|---|---:|---|
| A / fresh | `ses_f0d2dc6dfffe5HvngA0c8pWK6k` | 1 | `Apples: 3, pears: 4, total: 7.` | 2 | no prefix; byte mismatch |
| B / fresh | `ses_f0d2d307effePqboiMimisWXLM` | 3 | `I'll start by reading the fixture and listing the directory` | 6 | missing prefix with parallel calls |
| A / literal-head | `ses_f0d2aae28ffe2FwtvetaVLVwH7` | 16 | `§28a§ 3 plus 4 equals 7.` | 29 | malformed prefix; no guessed numeric delta |
| B / reduced | `ses_f0d2731deffeAcXLQC6sJgo6Y1` | 16 | `§34§` | none | tag-only tool framing; byte mismatch |
| B / reduced | `ses_f0d2c9f01ffesqMT1l2ohzrewN` | 17 | `§35§ Done — I queued a drop for §25,` | 35 | correct leading number; dangling mid-text tag; byte mismatch |

Three actual answer/trace examples from this one model (A/B variants):

1. **Mixed-tool preamble:** B wrote “I'll start by reading the fixture and listing the directory in parallel.” It is a useful explanation and the native parallel calls really happened, but the missing leading tag defeats the instruction. This failure recurred in all seven B sessions.
2. **Normal arithmetic with malformed tagging:** A wrote “§28a§ 3 plus 4 equals 7.” The arithmetic is correct; the notation is not. B generally preserved normal concise prose while adding a correct prefix. No quality score is assigned and no broad claim about coding ability follows from fruit arithmetic.
3. **Correct prefix, damaged retained trace:** B wrote “§35§ Done — I queued a drop for §25, the completed directory-listing output; it's held for now…” and then correctly explained 3+4=7. Persistence removed the dangling tag reference. A also wrote “Stamped — §25's drop is queued…”; its retained text lost the handle and became awkward. The instruction did not eliminate these inline-tag/trace defects.

The quoted fixture answers are substantively correct. There is no obvious degradation from B in these selected examples, but the unnecessary tag-only tool frame and inline malformed handles are real damage, not numerical successes to gloss over. The literal-head sessions never produced a well-formed 9002 prefix (one more than the quoted 9001); all their well-formed prefixes used the real lower allocation numbers.

## Calls, tokens and spend

| Phase | Provider calls | Input tokens | Output tokens | Included in benchmark rates? |
|---|---:|---:|---:|---|
| Primary | 270 | 1,222,444 | 9,009 | yes |
| Successful supplemental sessions, including their continuations | 55 | 379,394 | 1,761 | yes |
| Interrupted pilot | 150 | 563,259 | 5,292 | no |
| Failed supplemental configuration attempt | 25 | 346,320 | 1,030 | no |
| Unsupported model spelling setup | 2 HTTP 400 requests | no completion usage | none | no |

**Total: 502 requests, 500 model calls with completion usage, 2,511,417 input tokens and 17,092 output tokens.** Input splits into 2,313,344 cache-hit and 198,073 cache-miss tokens. One pilot call was not checkpointed when its host was stopped; its usage was recovered from the isolated host's recorded end-of-model-step token counters. Its response-model field was not recovered or guessed. All 325 benchmark responses have independently captured model identity and pre-strip text.

Using the cited DeepSeek Flash rates, estimated spend for **all phases**, including debugging, is **$0.0469 off-peak to $0.0938 peak**. This is a token-based estimate, not a read of the operator's balance or invoice. The documentation lists cache-hit $0.003/$0.006, cache-miss $0.15/$0.30, and output $0.60/$1.20 per million tokens for off-peak/peak. No credential or billing endpoint was queried to calculate cost.

## Credential handling and isolation

The operator staged only the DeepSeek entry under `$TMPDIR/magic-context/self-tag-trial/creds/auth.json`, mode 600. It was copied, without printing its contents, into each throwaway host's `data/opencode/auth.json` and kept mode 600. The original staging file was deleted after the primary cohort; the operator explicitly restaged it for the supplemental sessions.

**The staging file, including its restaged replacement at the same path, and all known copied auth files are now deleted.** Deletion was checked for the primary, pilot, failed supplemental, and final supplemental roots. No live auth file, live config, live database, or credential table was read. No key appears in report/data. The relay never records headers, so no Authorization header is present in the dumps; error messages are additionally sanitized against both the complete authorization value and bare key before recording.

Hosts use fresh HOME/XDG/config/cache/store directories under the trial temporary root and a minimal child environment, with only `deepseek` enabled. The sole live endpoint is the relay forwarding to `https://api.deepseek.com/v1/chat/completions`. Native file/network tools are disabled for the agent; deterministic fixture tools and real `ctx_reduce` are available. Title generation is disabled. `lsof -Fn -p <host pid>` before/after sessions is committed in the summaries, and every sampled forbidden-live-path list is empty. These are sampled host-PID checks, not continuous tracing of every descendant.

No product code, product guidance, tagger, ARCHITECTURE.md or STRUCTURE.md changed.

## Artifacts and verification

- `issue-582-self-tag-live.{jsonl,csv}`, `-summary.json`, `-analysis.json`: primary rows, native snapshots, provider stream records, usage and lsof proof.
- `issue-582-self-tag-supplement.*`: actual dropped-history sessions and outgoing `servedDroppedTags` evidence.
- `issue-582-self-tag-all.jsonl`, `-aggregate.json`: 325 benchmark rows with cohort labels and pooled/position tables plus all-phase spend.
- `issue-582-self-tag-pilot.*`, `issue-582-self-tag-supplement-failed.*`: excluded attempts and their raw rows/costs. The interrupted pilot's incomplete session is not counted as a completed session.
- Existing `-probes.json`, `-offline.jsonl`, `-offline-snapshots.json`: real production-code plumbing controls, not model-compliance evidence.
- `issue-582-self-tag-host-proof.json` and `-rows.jsonl`: deterministic pinned-host proof, including a no-paid-call final flush.

Harness entry points are under `packages/plugin/scripts/self-tag-trial/`: `live.ts`, `live-adapter.ts`, `host-plugin.mjs`, `measure.ts`, `analyze.ts`, `aggregate.ts`, and recovery/control scripts. Use `bun .../live.ts <output-prefix>` only with an operator-staged mode-600 credential; it does not discover credentials. The factory validates Magic Context config before host launch. The read tool uses the committed fixture file; echo and listing are deterministic fake results. Adding file-backed fixture reading preserves the exact bytes used in the measured runs. `reduction-supplement` selects two bounded sessions; `resume-A`/`resume-B` continue their existing isolated histories. Successful completion deletes staged and copied files. On failure, the copied credential is deleted while the staged file is retained for an explicitly authorized retry; an operator abandoning the run must delete the staging file.

A safe redaction-control mutation, using only a fake unit-test credential, made exactly `provider errors redact authorization and bare credential values` fail while the other ten tests passed. The staged source was restored and the six measurement tests passed again; no mutated code was committed or used for live calls.

Typical setup and checks, from repository root:

```sh
BASE="${TMPDIR:-/tmp}/magic-context/self-tag-trial"
mkdir -p "$BASE/host"
bun add --cwd "$BASE/host" --exact opencode-ai@1.18.30
bun install --frozen-lockfile
bun run --cwd packages/plugin build
# The operator stages the approved auth.json, without printing it.
bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-live
# Supplemental runs require explicit restaging after primary cleanup.
bun packages/plugin/scripts/self-tag-trial/live.ts docs/reports/issue-582-self-tag-supplement reduction-supplement
bun packages/plugin/scripts/self-tag-trial/analyze.ts docs/reports/issue-582-self-tag-live
bun packages/plugin/scripts/self-tag-trial/analyze.ts docs/reports/issue-582-self-tag-supplement
bun packages/plugin/scripts/self-tag-trial/aggregate.ts
bun run --cwd packages/plugin typecheck
bun test packages/plugin/scripts/self-tag-trial/engine.test.ts packages/plugin/scripts/self-tag-trial/measure.test.ts
```

The current factory fixes the invalid configuration used in the recorded primary cohort; a new run uses the validated configuration rather than reproducing that fallback mistake. Model outputs are not expected to reproduce deterministically.

Verification commands: plugin package typecheck; focused engine/measurement tests; pinned mock host probe; live per-session provider/hook equality, actual DB number readback and last-reply flush guards; independent outgoing placeholder checks; sampled lsof fence; explicit credential deletion checks; and git whitespace checks. No new dependency or lockfile change was required for this follow-up. The earlier standard plugin build supplies unchanged product dist. The repository formatter still rejects its existing `rules.preset` configuration; no unrelated formatter cleanup is included.

**Decision supported by this trial:** explicit self-tagging helps this Flash model, especially on the first reply, but the tested B wording does not meet the required every-reply/cache-byte contract. Fixing the first mixed-tool preamble and preventing inline/tag-only output would require a further experiment or a different mechanism; this report does not assume either fix works.
