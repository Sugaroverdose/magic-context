export const CTX_NOTE_DESCRIPTION = `Session notes: information you have now, attached to work you are deliberately not doing now.

Write a note when losing the detail would cost real work to rebuild — an investigation's findings, a decision with its reasons, a backlog item with its evidence — or when the user asks for one. Not for the next few steps, a plan you are about to execute, or restart/fold insurance: the conversation and the history keep those. A fact that stays true regardless of pending work (a rule, an architecture fact, a constraint) is ctx_memory, not a note. When the detail already lives in a file (plan, design, report, prompt), the note carries the path and a one-line reason to come back, never a copy. First line is the title, under 80 characters; blank line; then the detail.

Actions:
- write: save a note (content). Add surface_condition to make it a smart note.
- read: one row per note — \`#id · age · title\` — ready smart notes first, then newest; rows untouched 30+ days are marked stale. Pass note_ids to read full bodies; limit/offset page; filter selects other states.
- update: change one note (note_ids=[N]). dismiss: retire 1–50 notes (note_ids=[...]).

Smart notes: with surface_condition the note is parked and re-checked for you on the dreamer's schedule (nightly by default) against signals outside this conversation — repository files, git history and tags, GitHub state, web pages — and brought back as ready only when the condition holds. The condition must be a fact those sources can answer:
✓ "When PR #42 in cortexkit/magic-context is merged"
✓ "When the latest release tag is >= v0.22.0"
✓ "When packages/plugin/src/foo.ts contains a function named bar"
✗ "When the user mentions X" / "after we finish this refactor" — no external signal; write a regular note.
Example: ctx_note(action="write", content="Re-run the perf benchmark once the boundary rework ships", surface_condition="When the latest release tag is >= v0.23.0")`;
