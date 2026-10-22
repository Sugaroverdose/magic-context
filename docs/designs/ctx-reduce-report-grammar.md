# ctx_reduce response grammar — design invariants

The ctx_reduce response is a model-facing contract: its shape is *taught* at the
definition site (`packages/plugin/src/tools/ctx-reduce/constants.ts`, the tool
description) and byte-pinned by the suites. Changing the response wire requires
auditing every invariant below against the definition site FIRST — a chat
example is not a spec. History: Rev 5.2/5.3 (+D18) prose grammar; Rev 6 (this
branch, user ruling 2026-10-20) structured JSON.

## Current wire form (Rev 6 + positional mirror)

```json
{"ctx_handles":[12041,12042,"12045-12048",null],
 "stamped":[12041,"12045-12048"],
 "noop":{"queued":[12042]},
 "held":[12045],
 "errors":[{"class":"not-found","entry":"…","candidates":[101,100],"note":"…"}],
 "note":"…"}
```

## Invariants (contract text in parentheses = definition-site sentence)

- **I1 — Positional mirror.** `"ctx_handles"` is the first key: one slot PER
  ENTRY, exact input order; ordinal for a positioned item, `"a-b"` for a range,
  `null` for a failed entry; repeats repeat (`[5,5]`).
  ("The response answers the list slot for slot, in the order you sent it, with
  each item's position in your context.")
- **I2 — Ordinal semantics.** Every bare number is a message ordinal — the
  number `ctx_expand(message=N)` eats. No tag numbers on the pointing surface.
- **I3 — Span slots.** A range slot is `"first-last"` and feeds
  `ctx_expand(start=first, end=last)`.
  ("a span slot reports its ordinal range (`\"10-12\"`) and feeds ctx_expand(start=10, end=12)")
- **I4 — S-4 loud/graceful.** Plain not-found with resolvable siblings =
  graceful: siblings stamp, slot `null`, class line with
  `"the rest of the batch was stamped"`. Lone not-found, ambiguous, dead range
  endpoint, all-failed = loud: `renderPointingError` — a single `errors[0]`,
  NO mirror (a rejected batch must not echo partial position), note ends
  `"Nothing was stamped; resend the corrected batch."` Mint failure =
  `class:"mint-unavailable"`.
- **I5 — Teaching clauses ride `note`.** The S-1 form clause ("a phrase names a
  message… a tool call releases by its call id"), the S-3 window wording
  ("current context window"), the S-4 closers, and the range hint ("Endpoints
  inside tool output are call ids.") are contract text; migrate them with the
  surface rulings, never ad hoc (docs/reports/ctx-reduce-surface-failures-2026-10.md
  in the research repo owns the rulings).
- **I6 — Class views are machine views.** `stamped/noop/held/errors` are
  deduped per-class conveniences; position is authoritative in the mirror.
  Bulk (no-arg) path has no mirror (no input handles) — stamped/noop/note only.
- **I7 — All-noop closer.** fresh == 0 ⇒ `"note"` opens
  "All requested tags were already queued or processed…".
- **I8 — One renderer, both harnesses.** `reduce-response.ts` is the single
  source; Pi parity pins must ride any change.

## Rev 6 delta log (2026-10-20)

- Prose → JSON; ordinals as arrays; per-entry mirror restored as
  `"ctx_handles"` after the first commit (`a6a4211be` dropped it — violating
  the definition-site contract — fixed same day by `c587e32b2`; the lesson:
  audit I1-I8 before touching the surface).
- Failed slot `?` (prose) → `null` (JSON).
- Ambiguous candidates: prose excerpts (`100: "the quarterly…"`) → ordinal
  array in bm25 order; definition site teaches the fix instruction
  ("copy a longer run…"), not excerpts.
- Protected promise line: entry echo → mirror slot + `held`.
- Blind probe (n=1 × 4 formats, fresh readers): all arms parse spans, re-issue
  cleanly, mirror no report prose; JSON chosen on token cost (-40%), fixed
  vocabulary (no mirrorable prose corpus at ~2K reports/heavy session — the
  priming-hygiene law), and parseability for a future audit block.

## Tests that pin the contract

`src/tools/ctx-reduce/ctx-handles.test.ts` — mirror pins per shape (position,
repeat, null, span, noop-inside-range, loud=no-mirror); Pi:
`src/tools/ctx-reduce-v1.test.ts`. Definition-site bytes: constants golden +
prompt-surface gates.
