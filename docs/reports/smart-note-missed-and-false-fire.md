# Smart-note missed and false fires

## Findings

- The compiler dry-ran generated checks through QuickJS and the guarded HTTP capability. A response over 64 KiB became a persistent compilation failure immediately. There was no feedback-driven repair attempt.
- Persistent failures stored `ready_reason` but left the smart note pending. Search could expose that reason, but normal nudges selected active session notes and ready smart notes, not pending smart notes. Consequently, recording a reason did not notify the owner.
- `gitTag()` returns a single nearest reachable tag, not the repository's tag set or ancestry. Retina's `git_tag_matching` similarly cannot express the reported two-clause ancestry/exclusion condition. Neither is an appropriate implementation of that condition.
- The historical compiled check for #3071 was deleted when the condition was rewritten. Its exact defect cannot be established from the available evidence without that check. The fixture reproduces a plausible false fire: `name !== A || name !== B` is true for either allowed tag. This is a reproduction of the semantic failure, **not** proof that the deleted production check used that expression.

## Changes

- Compiler guidance now specifies bounded GitHub release/tag endpoints, numeric version comparisons, correct tag-object parsing, complete pagination, and the direction of ancestry comparisons. `gitTag()` is explicitly documented as a scalar nearest-tag operation.
- A persistent body-too-large dry-run error triggers one recompile, carrying the actual error and instructions to use smaller endpoints. The second failure terminates normally; the deadline and cancellation signal still apply. The 64 KiB security limit is unchanged.
- The reported tag-condition syntax has a deterministic compiler branch in the production `compileSmartNoteCheck` path. It parses actual tag names, excludes both allowed names, and uses `compare/BASE...TAG?per_page=1`: behind/identical means ancestral, ahead/diverged means non-ancestral. Tags use explicit 100-item pages, at most ten. HTTP/schema/comparison errors and exhausted pagination do not produce a positive verdict. Other prose still uses the existing language-model compiler.
- Permanent compilation failures, and compilation failures reaching the fallback threshold, create a separate session notice containing the condition and error. The smart note remains pending. Notices target its bound owner session (or the evaluator's parent session for legacy unbound notes), trigger a normal nudge, and take priority over ordinary reminders. Successful anchored delivery atomically dismisses only the notice. The dismissed notice is retained to deduplicate retries of the same note/condition. Sticky anchor replay remains available. No live-store migration or modification is performed.

## Verification

- `bun install --frozen-lockfile`: passed; no manifest or lockfile changes.
- Plugin `bun run typecheck`: passed.
- Plugin `bun run lint`: passed (1,093 files).
- Smart-note suites plus owner nudger and ctx-note renderer: 121 tests passed. After final wording/comment changes, the affected integration and owner-nudger suites passed again (18 tests); plugin typecheck and lint also passed again.
- All new tests use injected HTTP responses and disposable Git repositories. New SQLite fixtures are under `$TMPDIR/magic-context/smart-notes-fix/`; no live stores or live GitHub requests were used. The compiler transport retry tests inject settled model output, not a live model.
- Local-fs was investigated but not changed; its tests are not needed for this patch.
- Mutation probes: replacing both-name exclusion with OR fails only the two-ancestor-tag negative regression; disabling repair fails the bounded-latest regression; disabling notice acknowledgement fails only the once-only owner-notice regression. Each probe had a nonempty working diff while applied and an empty working diff after restoring the staged implementation.

## Limits

The original lost check remains unavailable, so the historical cause is not conclusively attributed. The deterministic branch prevents recurrence for the original wording without trusting newly generated model code for that predicate. The release repair test proves the real compiler transport/feedback/dry-run path using fixture model output; it does not measure a live model's compliance with the prompt. GitHub compare responses can still exceed the unchanged body limit for large divergent histories; those are errors, not false fires. A legacy note with neither an owner binding nor an evaluator parent session has no session to notify; its stored failure reason remains available to search. Delivery requires the owner session to resume and reach a new message, preserving the existing prompt-cache boundary rules.
