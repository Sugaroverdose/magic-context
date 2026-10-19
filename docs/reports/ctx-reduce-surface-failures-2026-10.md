# ctx_reduce v1 live-call failure audit — issue surfaces, fixes, history

Date: 2026-10-19. Branch: `feat/ctx-reduce-v1-v045` (post-rebase onto `feat/fpe-v045`).
Installed instance at audit time: `@0.45.0-ctxv1`.

This document is the recurrence baseline: if any class below reappears, its
signature, root cause, verdict, and fix state are recorded here — do not
re-derive.

## Method

Source: the host store (`~/.local/share/opencode/opencode.db`), all
`ctx_reduce` tool parts in the 2.2-day window, joined against the MC store
(`~/.local/share/cortexkit/magic-context/context.db`) for ground truth:

- phrase entries: FTS mirror (`message_history_fts`, same `content MATCH`
  construction the resolver uses) + raw `part.data` LIKE (ESCAPE-quoted) for
  byte presence and part-type attribution;
- id entries: `tags.message_id` registry membership;
- every failure's `named` entry is the one the resolver reports (calls are
  all-or-nothing: only the first failing entry is named — the remaining
  entries of a failed call are collateral, not verdicts).

Totals: 79 `ctx_reduce` calls, 49 failed (74 v1 calls, 48 failed, 26 clean;
4 vanilla `drop=` calls — the pre-v1 session residue, 1 failed).
Failed calls carried 450 entries total; 401 of them collateral.

Headline: **zero silent mispoints** — every failure was loud, and the log
shows self-repair (26 clean calls).

## Catalog (named-entry classes)

| class | n | share | example |
|---|---|---|---|
| Copy of tool-output text (phrase) | 24 | 50% | `FAILED test_login - assert 401 == 200`, `VALIDATION FAILED`, `b14/u840.txt`, `SCADA-система ЭНТЕК` |
| Copy of tool-output text (range endpoint) | 7 | 15% | `call_301b…..call_1a5b…`-shaped ranges over `===== u420 …` decorations |
| Fabricated call ids | 8 | 17% | `call_2264454746222959` (digit-run), 24-hex `call_bb86515f99ecdb80894c1566` |
| Fabricated range endpoints | 3 | 6% | same, as range endpoints |
| found-twice (decoration collisions) | 2 | 4% | `===== u90 =====` ×2, `##### u100 #####` |
| Copy of swept prose | 3 | 6% | `the census changes the economics table` (real prose, 4 raw hits, 0 mirror rows) |
| Paraphrase / never-said | 1 | 2% | `Call the specific function`, `in_ses_f8d5-3.json` (truncated) |

## Issue surfaces

### S-1 · Prompt ambiguity: phrase scope vs tool output — **FIXED (adopted 2026-10-19)**

Symptom: the dominant class (33/48). The model copies tool-output lines as
phrase/endpoint entries; the resolver correctly answers not-found.

Root cause: the definition text said "the shortest phrase copied word-for-word
from the item that only that one item on the desk matches" — "item" covers
tool outputs on the desk, so a cold reader is following the prompt as written.
The form→class ruling (phrase = messages, id = calls) was a code-scope ruling
that never propagated to the model-facing sentence.

Evidence it is prompt, not model: blind probe P1 (fresh context, current text,
185B-class serve) reproduced the violation unprompted; P2 (proposed text)
produced `["call_toolu_auth1..call_toolu_auth2"]` in the identical scenario.

Fix (adopted, both sites, all surfaces):
- definition (full): "…from a message's text (your prose, and what you were
  given as prose) that only that one item on the desk matches — a tool call is
  released by its call id, never by its output text…"
- parenthetical form in list/param/light/desk-light renders: "(prose — a tool
  call releases by its call id, never by its output text)"; light form:
  "(tool calls release by call id, not output text)".
- failure site: not-found tail → "A phrase names a message — prose you wrote
  or were given; a tool call releases by its call id, not by its output text.
  Copy the words exactly, …"; range hint gains "Endpoints inside tool output
  are call ids."

Surfaces updated: `constants.ts`, `tools.ts`, `parameter-descriptions.ts`,
`light-descriptions.ts`, `magic-context-prompt.ts` (×2), Pi `ctx-reduce.ts`,
`reduce-response.ts`, Rust `guidance_primary.txt` + `guidance_light_primary.txt`,
A1 golden, light-mapping (19 quotes), budget fixture. Blind validation:
P1 reproduced / P2 clean / P3=P4 (report site measured neutral — adopted as
teaching, not behavior fix).

Signature for recurrence: not-found entries whose text is present in
`part.data` of `tool`-type parts (raw LIKE hits, mirror = 0).

### S-2 · FTS token-skeleton matching vs the "verbatim" contract — **OPEN (engine fix queued)**

Symptom: `===== u90 =====` → "found twice" with candidates that do not
visually contain the phrase; any phrase whose FTS tokenization collapses to
its bare words (decorations stripped) matches prose by word-token. The
contract promises "verbatim run"; the lane delivers a token skeleton.

Root cause: `ftsPhraseQuery` quotes the entry into an FTS5 `"phrase"`;
unicode61 strips punctuation, so decorations are invisible and single-token
phrases match any message containing the word. Mirror probe:
`===== u90 =====` and bare `u90` return identical row sets.

Risk ladder: found-twice (loud, seen 2×) → **single-token silent mispoint**
(one prose message containing the word = a stamp on the wrong item). Not
observed in the window; construction permits it.

Queued fix: byte-exact substring lane (`LIKE … ESCAPE`) over the mirror
content, run when the FTS lane yields no live hit (and as authority over
token-skeleton artifacts). Approves trivially against the ruling: the
registry scoping stays; the FTS lane keeps absorbing case/whitespace.

Signature: "found twice" where the named entry's punctuation is absent from
the quoted candidates.

### S-3 · Swept-text phrases reported as plain not-found — **OPEN (report precision, queued)**

Symptom: phrases from the model's own prose that compaction swept return
"matches nothing in this session" — false statement about the store (raw
hits exist; mirror rows = 0). The model re-issues ghost strings (observed:
2 retries per swept string).

Root cause: `resolvePhrase` lumps out-of-window (registry `dropped`/absent
mirror) into the same not-found as never-said. The `dead` row set exists in
the resolver; only the report flattens it.

Queued fix: report split — "out of your window — it is archive material
(ctx_expand/ctx_search), not a desk item" vs "matches nothing you said".
The form→class text in the same tail teaches the model the desk scope.

Signature: not-found whose text has raw `part.data` hits on `text`-type
parts of messages whose registry tags are `dropped`/absent.

### S-4 · All-or-nothing collateral rejection — **OPEN (policy, ruling pending)**

Symptom: 401/450 failed-call entries were collateral — perfectly resolvable
entries rejected because one entry in the list failed (8.4 per failure). The
model's response to a rejection is frequently a full re-issue, so the loop
cost multiplies.

Status: partial-accept (stamp the resolvable, report the rest per slot) is
what the queue machinery supports; atomicity was a design choice, not a
user ruling. Decision owner: user. The S-1/S-2/S-3 fixes shrink the trigger;
the blast radius stays.

Signature: failed calls with `entries_failed ≥ 2` where re-issued subsets
succeed.

### S-5 · Fabricated ids — **NO ENGINE FIX (model-side)**

11/48: ids shaped like `call_*` that exist nowhere (digit-run patterns,
24-hex, remembered strings). Loud not-found; self-repair observed. The
prompt teaches "copied exactly from the call". No engine change warranted —
engine answers correctly. If fabrication rate rises on some serve, the
mitigation is prompt-side, not resolver-side.

### S-6 · Vanilla `drop=` residue — **CLOSED (no action)**

5 pre-v1 calls (1 failed: `§3§`-era tag grammar from an un-migrated client
session). The v1 surface is the only one shipping; nothing to fix.

## Repro / recurrence kit

- catalog script pattern: query `part.data LIKE '%"ctx_reduce"%'` joined to
  `message` on `time_created`, parse `state.input.ctx_handles` + `state.output`,
  classify named entries against `tags` (ids) and FTS+raw LIKE (phrases);
- store paths: MC `context.db` (tags, pending_ops, message_history_fts),
  host `opencode.db` (message, part);
- blind-validation harness: render the shipped description from
  `src/tools/ctx-reduce/constants.ts` into a probe file with a realistic
  desk (tool outputs + prose), dispatch fresh-context subagent, grade the
  produced `ctx_handles` array against the classes above.

## Change log

- 2026-10-19: audit performed (this file); S-1 adopted (definition + report
  text, all 13 surfaces, goldens/gates/budget fixture regenerated); S-2,
  S-3, S-4 opened; S-5/S-6 closed no-action.
