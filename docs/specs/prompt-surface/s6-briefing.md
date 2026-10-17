# Prompt batch S6 — surface inventory and constraints (2026-10-17)

Branch: `feat/ctx-reduce-v1-v045`. Code implements the Rev-5.3 pointing
grammar (`ctx_handles` form resolution, ordinal-native echo, D18-amended
ranges, bulk default). The model-facing TEACHING is half-migrated: the
ctx_reduce description is drafted v1-native; everything else still teaches
the retired `§N§` stamp regime. This file is the work list for the prompt
session: every surface, the ruling each replacement must satisfy, the
constraints, and the existing drafts.

## Ground rules from the code arc (non-negotiable, inherited rulings)

1. **No §N§ priming.** Tags are internal addressing (database + plugin
   logs), never a model-facing handle. Nothing on the wire shows `§N§`;
   the desk copy must not mention tags, stamping, or `tag=N`.
2. **One numeral space: message ordinals.** Handles the model copies are
   call ids and verbatim text; handles the model gets back are message
   ordinals, the same space as `<session-history>` headings and
   `ctx_search` ranges. `ctx_expand(message=N)` / `(start=,end=)` is the
   single recovery route.
3. **The response contract is a state machine; teach it mechanically**
   (input mirrors output slot-for-slot; `ctx_handles:` array = released
   ordinals; report lines = facts; `error:` = whole batch rejected, fix
   and resend the same batch). Do not restate the engine's internals.
4. **Range semantics (D18 amendment):** a range is direction-agnostic;
   endpoints bound a registration span. Text must not teach "start must
   precede end".
5. **Keep upstream byte-parity where the surface is upstream's** (e.g.
   ctx_expand's vanilla shape) — changes land as named, minimal
   deviations, never as rewrites.

## Surfaces to rewrite (with current state)

| # | surface | file:line | current state | must do |
|---|---|---|---|---|
| 1 | Desk copy (full render) | `packages/plugin/src/agents/magic-context-prompt.ts:59-65` (`BASE_INTRO`) | teaches "arrives with a §N§ tag — the tag is the item's handle", stamping ritual, `ctx_expand(tag=N)` | release-verb swap (stamp→release, tag→copied handle), pointing clause = call ids/verbatim text, recovery clause = `ctx_expand(message=N)`; archive/anti-scarcity/pinboard/markings clauses stay byte-identical |
| 2 | Desk copy (light render) | same file, `BASE_INTRO_LIGHT` | same §N§ regime, compressed | same mapping as #1 |
| 3 | SELF_TAG guidance | same file:155, appended by :181/:207/:209 | teaches a reply-start tag ritual | DELETE outright (ruled): zero consumers; all three render sites drop the interpolation |
| 4 | Subagent intros | same file:142+ (`SUBAGENT_REDUCE_INTRO`) | teaches numeric `drop` grammar ("3-5", "1,2,9") | handle grammar: ids/text/`a..b`; no ranges-of-tags, no bulk mention beyond "release used outputs" |
| 5 | ctx_reduce description | `packages/plugin/src/tools/ctx-reduce/constants.ts` | v1 draft, ~350 tokens, negotiated in-code | prompt-session review only; fix any drift from the contract (the draft's range sentence needs the D18-amendment pass: no direction rule) |
| 6 | ctx_expand description | `packages/plugin/src/tools/ctx-expand/constants.ts:2` | teaches `tag=N` "the number from a §N§ tag" | ordinal-native: `tag=N` bullet DE-advertised (engine path stays, same pattern as `drop=`), `message=N` + `start/end` + `verbose` taught, search-companion clause. Draft exists in the design doc (Rev 5.2 D-notes) |
| 7 | Light descriptions | `packages/plugin/src/tools/light-descriptions.ts:4` | ctx_expand light text: "tag=N (a §N§ ... number)" | same as #6 in light form |
| 8 | Param descriptions | `packages/plugin/src/tools/parameter-descriptions.ts:9,52` | `tag: "Tag number from a §N§ tag..."` (ctx_expand param) | drop the § reference; keep the param (vanilla-echo ruling), neutral wording |
| 9 | Nudge copy | `packages/plugin/src/hooks/magic-context/ctx-reduce-nudge.ts:486,498` (+ Pi twin `ctx-reduce-nudge-pi.ts`) | "Still unstamped ... Stamp the ones you've used ... with ctx_reduce now" | release-verb copy; reclaim hints already carry copyable handles (E2b) — the line must point at those bytes, not at tags |
| 10 | Compaction-channel prose | compartment/placeholder text mentioning `[dropped §N§]` (detector `inject-compartments.ts:849` keeps the legacy matcher) | detector stays for stored gen-1 bytes (compat); model-facing phrasing of placeholders already opaque (`...`) | verify no teaching text emits § bytes into new sessions; legacy matcher stays (storage compat, do not "clean") |

Pi mirrors: every OpenCode surface has a Pi twin (`pi-plugin/src/`:
`pi-system-prompt.ts`, `ctx-reduce.ts` descriptions, nudge). Same text,
byte-identical where the surfaces are shared; Pi mint/echo verified
ordinal-native (E2).

## Token budget (resident, full render, current → target)

- desk copy ~350 → ~150 (handle clause replaces stamp ritual)
- SELF_TAG ~180 → 0
- subagent intro ~110 → ~80
- ctx_reduce description: ~350, roughly stays (grammar must be taught)
- net resident teaching: ~-500 tokens

## Derived assets (regenerate AFTER text is final — S6c)

- `shared/prompt-surface-a1-golden.md` (A1 golden) via export script
- `docs/specs/prompt-surface/budget-fixture.json`, `checklist.json` via generators
- Rust guidance assets `crates/mc-module` (regen from TS renderer; no cargo on host — CI/build host runs module tests)
- prompt-surface gate tests (`constants.test.ts`, light-mapping quotes) migrate with final text

## Sequencing

1. Prompt session negotiates text for surfaces 1-4, 6-9 (5 = review).
2. S6b: apply text verbatim; no engine changes.
3. S6c: regenerate derived assets; migrate golden/budget/quote tests.
4. C5 install + live smoke (first production run of v1 wire + prompts).
