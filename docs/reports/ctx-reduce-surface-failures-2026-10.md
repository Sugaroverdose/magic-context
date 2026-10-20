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

### S-2 · FTS token-skeleton matching vs the "verbatim" contract — **FIXED (2026-10-20, implemented red-first, test rows 1–8 + survivors≥2 + S-4 interaction, all green)**

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

Fix: see the design ruling and implementation spec below (superseding
two earlier proposals: always-verify, scan-on-emptiness, and a
`mirror_bytes` table — all rejected in-session, reasons recorded).

Measured 2026-10-19 on a read-only copy of the live store (47,163 mirror
rows, all sessions): FTS phrase path median **0.1 ms** (max 3.9); raw
`LIKE` full-table scan **49.1 ms**; "session-scoped" LIKE 15.1 ms — that
row measures empty-scan overhead, not content matching (the FTS5 table has
no index on `session_id`, so every scan is a full-table walk + filter).
The user's premise — "scan only the visible window, not super slow" — needs
an indexed scope, and a new table is not how to get it. **Design ruling
(2026-10-19, final after two revisions): verify-on-collision, scan-on-
emptiness. Zero new structures.**

1. Phrase MATCH (today's lane, unchanged) → **unique hit → stamp.**
   Absorbed semantics (case/whitespace/morphology) stay the accepted
   surface — byte-verify-always was rejected the same session it was
   proposed: it makes the resolver stricter than today (`test failed`
   vs `tests failed` copy-drift passes the index, fails bytes, becomes
   a not-found), i.e. fixes the ghost class by manufacturing new ghost
   retries. The index never touches bytes; it only ranks the work.
2. **Multiple hits → `LIKE … ESCAPE` over the shortlisted rows.**
   Byte truth exists exactly where the skeleton can't discriminate;
   survivors decide, ghosts die (u90), "found twice" names messages
   that visibly contain the text. Predicate = **substring** (`%entry%`),
   not equality: boundary punctuation is free (models deliberately
   trim head/tail punctuation — `test failed` matches `test failed.`
   for free), interior punctuation is faithful (that's where the
   identity signal lives; interior drops are the one case the trim
   ruling does not cover, and stays not-a-survivor by design).
3. **Entry tokenizes to zero tokens** (pure punctuation/arrows/marks) →
   **not-found, final — no scan.** The index is mute about them (no
   terms to query), and a scan is not the answer: there is no
   window-scoped scan (the FTS table has no session index — the
   measured 49 ms full-table walk, linear growth, rejected by
   measurement), a scan "capped" answers not-found on truncated
   evidence = a lie, and the pointing form it served is taught out of
   existence by S-1 (pure decoration is not prose; the thing it
   decorates is a tool row, lane = call id). Report names the shape:
   the entry carries no searchable text — point by prose words or the
   call id.

Consequence: the engine performs **no substring scan on any path**.
LIKE runs only over rows MATCH hands it (rule 2), where scope is free.

Implementation spec — the complete decision gate (every branch, every
test row; nothing trimmed):

```
index hits == 1   → stamp. LIKE never runs.
index hits >= 2   → byte substring over the hit rows (settled as `LIKE '%entry%' ESCAPE '!'`; landed as the collapse predicate — see predicate note):
      survivors == 1  → stamp that one, normal success echo
      survivors == 0  → not-found (ghost candidates not named)
      survivors >= 2  → found-twice, listing survivors only
index hits == 0   → not-found (S-3 wording)
zero-token entry  → not-found + "entry has no searchable text"
```

Predicate: SQLite `LIKE` — ASCII-case-insensitive by default (case
absorption matches the index lane); substring (boundary punctuation
free, interior faithful).

**Final arbiter (user ruling 2026-10-20, measured basis):** copies of
column-aligned tool output (table rows) carry whitespace runs — 11/545 real
ctx_reduce entries (2%) have interior double spaces; the mirror normalizes all
runs at write (0/48,204 rows carry a run). Such a copy MUST match: a not-found
on it would be a plugin failure, not wrong input. This is the production
justification for the collapse predicate over raw LIKE (the whitespace-variance
pins exercise fixture geometry the writer cannot produce — 0 real occurrences —
and are contract codifications, not the arbiter). Leading/trailing-space
entries: 0/545 (the JSON emit path trims).

**Glyph-form fold (added same day, user's "exact line" case).** The collapse
also folds look-alike punctuation to ASCII on both sides: curly quotes
(`‘ ’ ‛` → `'`, `“ ”` → `"`), dashes (`– — −` → `-`), ellipsis (`…` → `...`).
Rationale = index parity: unicode61 strips all of these as token separators,
so the index is blind to the form; a verbatim copy carrying either form must
resolve (plugin-failure ruling). Session evidence: the byte-exact-tool
instances of the class (two anchor-mismatch no-ops in doc edits — outside the
resolver, discipline surface: anchors from machine output, scripted, never
retyped). Store census: 10 dash-form entries (all resolved — unique-hit rule
1, byte lane never ran), 6 Cyrillic (resolved; no fold for letters — form
folding is punctuation-only, letters stay faithful), curly quotes 0 in
entries / 336 content rows (latent side). Red-first rows pinned: en-dash↔
hyphen and straight↔curly collision pairs. `..` and all FTS-syntax handling
unchanged (phrase-first precedence, range as strict fallback — pinned at
ctx-handles.test.ts:724; endpoint ≥2 hits → loud per S-4).

**Implementation note (predicate deviation, recorded at landing).** The byte
truth landed as a JS substring check (`collapse(content).includes(collapse(entry))`
— whitespace runs collapsed to one space, ASCII-lowered) over the MATCH
shortlist's **full** content, not SQLite `LIKE`. SQLite LIKE was rejected on
three grounds: (a) it cannot express the whitespace absorption the index lane
provides — raw-byte LIKE would make tab/multi-space twin copies non-survivors,
manufacturing exactly the copy-drift ghost not-founds the byte-verify-always
rejection forbids; (b) `%`/`_` escaping — inert by construction in JS
(no wildcards exist); (c) a `substr(…,120)` excerpt column truncates targets
beyond 120 chars into false not-founds. Ruling semantics identical: case
absorbed, head/tail trim free, interior punctuation faithful (whitespace is
absorbed surface, not identity signal). Contract codification: the two
pre-existing absorption pins in `ctx-handles.test.ts` (whitespace-variance
cases) — red under raw LIKE, green under the collapse predicate.

Test table (red-first, one row per branch, all branches):

1. unique index hit, bytes do NOT match (entry `test failed`, sole hit
   contains `tests failed`) → stamps, no verify (rule 1; absorbed
   semantics preserved)
2. collision, exactly one byte survivor (skeleton twin in second
   message) → stamps the survivor, success echo, NO found-twice
3. collision, byte `test failed` vs skeleton-twin `testing failure` →
   stamps the byte one
4. collision, head/tail trim (entry `test failed` vs survivor row
   `test failed.`) → survivor passes free (substring)
5. collision, interior trim (entry `test failed` vs row
   `test, failed`) → NOT a survivor (by design)
6. `50%` literal in prose → LIKE escaping inert, stamps
7. zero-token entry `→→→` → not-found + "no searchable text"
8. audit geometry (entry `===== u90 =====`, prose hits contain `u90`
   only) → collision → 0 survivors → not-found, no ghosts named

Residual accepted by standard (user's fidelity-not-integrity ruling on
stamping): decorated copy whose skeleton is unique (
`===== u90 =====` → single narration message) stamps the narration —
topic-true, recoverable, and the canonical lane for tool rows is the
call id (S-1 text, both sites).

Beats a new session-indexed table (`mirror_bytes` proposal, superseded)
on every axis: no schema, no double-write sync surface (the mirror has
drift history — the hash ledger exists for a reason), no new failure
modes; byte checks read the same `_content` MATCH reads.

Family census for context: the mirror is `message_history_source` (73,498
rows — indexed `(session_id, message_id)`/`(session_id, ordinal)` ledger of
EVERY indexed message, metadata + `normalized_content_hash`, no content),
`message_history_fts` (47,163 — the live window, self-contained FTS5),
`message_history_index` (per-session cursors). The 26K-row gap is the
swept population — the substrate S-3's report precision can name (a
message present in source with no FTS row = out-of-window, measured, not
inferred).

Signature: "found twice" where the named entry's punctuation is absent from
the quoted candidates.

### S-3 · Swept-text phrases reported as plain not-found — **OPEN (report precision, queued)**

Symptom: phrases from the model's own prose that compaction swept return
"matches nothing in this session" — false statement about the store (raw
hits exist; mirror rows = 0). The model re-issues ghost strings (observed:
2 retries per swept string).

Fix applied 2026-10-19 (user ruling: rephrase so the sentence is true for
ctx_reduce): not-found now reads "…matches it in **your current context
window**." The ctx-expand "in this session" strings are a separate lane
(they speak about the stored history, where the claim is true) and stay.

Root cause: `resolvePhrase` lumps out-of-window (registry `dropped`/absent
mirror) into the same not-found as never-said. The `dead` row set exists in
the resolver; only the report flattens it.

Queued fix: report split — "out of your window — it is archive material
(ctx_expand/ctx_search), not a desk item" vs "matches nothing you said".
The form→class text in the same tail teaches the model the desk scope.

Signature: not-found whose text has raw `part.data` hits on `text`-type
parts of messages whose registry tags are `dropped`/absent.

### S-4 · All-or-nothing collateral rejection — **FIXED (2026-10-19, `0ea75381a`)**

Ruling (user): graceful noop only for a plain not-found entry with
resolvable siblings; loud whole-call failure stays for range entries
with a dead endpoint, ambiguous entries, all-failed calls, and mint
failure. Landing: gate in tools.ts, per-entry not-found line in the
success assembly, description sentence migrated, golden + budget
fixture re-measured, 5 new tests + 2 migrated pins.


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

Considered 2026-10-19 (user: consider carefully which errors become
verbose noop). From the resolver source, the outcome taxonomy is already
mostly partial-accept: per-entry outcomes are `released`, `deferred`
(protected — reported per entry, never aborts), `noop` ×4 (`queued`,
`released`, `compacted`, `inert` — the "reported, not retried" classes),
`range`, and `error`. The atomic layer (tools.ts) gates **only** `error`,
which has exactly two reasons:

- `not-found` (id / phrase / range-endpoint variants) — stamps nothing by
  construction; the safe verbose-noop class. Re-issue safety: a later
  re-issue of a sibling that did stamp lands as noop `queued` — dedupe is
  per-tag, no double-queue.
- `ambiguous` (found-twice) — stamps nothing by construction; the report
  already lists the colliding candidates. Same re-issue safety.

Every other class is *already* a verbose noop. The mint-failure global error
("positions could not be resolved") must stay atomic — it means the
registry read itself failed, so per-entry verdicts are meaningless.

Cost of the flip, named: loudness dilution. Today a call with one poisoned
entry is 100% error text; under partial accept the failure is one line
among N success lines, and a skimming model may not re-point the entry.
Mitigation: the response stays slot-for-slot with the failed entry quoted
and named. Net: two classes flip, everything else unchanged.

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
- 2026-10-19: S-3 fixed (`7fdbe42d0`); S-1 blind probes P1–P4 ran (definition
  site confirmed as the class-A manufacturer; adopted).
- 2026-10-19: S-4 ruled (graceful noop for individual not-found; loud for
  ranges / ambiguous / lone / all-failed) and implemented (`0ea75381a`).
- 2026-10-20: S-2 implemented red-first (this commit): gate tree in
  `reduce-resolver.ts` (unique hit stamps without verify; collision → byte
  substring over the MATCH shortlist — collapse predicate, see the
  implementation note; zero survivors → not-found, ghosts unnamed; survivors
  ≥2 → found-twice, survivors only; zero-token → not-found + shape clause,
  no scan). Test rows 1–8 + survivors-≥2 + S-4 interaction green. Predicate
  arbiter: the entry-side whitespace-run census (11/545) + the ruling that a
  faithful table-row copy must match. All audit
  surfaces now closed except S-5 (model-side, no engine fix).
