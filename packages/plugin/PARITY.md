# OpenCode 2 scenario parity

The general adapter contract remains in [the repository parity document](../../PARITY.md).
This table records real-host scenario adjudications against `@opencode/cli@2.0.5`.

## Native todos

| Difference | Imposed or chosen | Host surface and executable evidence |
| --- | --- | --- |
| No native `todowrite` tool or host todo snapshot | Host-imposed | GA 2.0.5's actual provider tool inventory contains `shell`, `subagent`, `execute`, and the registered ctx_* tools, but no todo writer. `tests/todo-synthesis.test.ts` boots the real host, requires ctx_note on the wire, asserts the absence of a todo writer, and verifies the durable todo state remains empty. |
| No replacement todo application implemented by Magic Context | Chosen | The adapter does not invent a native host tool or persist a fictional host todo snapshot. Synthetic replay and todo-triggered nudges apply only to hosts with a real todo writer. |

Existing host-imposed differences also include [native fold ownership](../../PARITY.md#2-fold-ownership), unparented hidden completions, and the notification and thinking carriers documented in the repository parity contract. No new v1 behavior is waived.

## Native folds

| Difference | Imposed or chosen | Evidence |
| --- | --- | --- |
| Publication does not write a v1 pending marker; the host creates the compaction row | Host-imposed | GA `SessionCompaction.result` returns a summary, not a chosen sequence cut; `Context.session` has no `compact` method. See the [fold-ownership surface](../../PARITY.md#2-fold-ownership). The deferred-marker scenario requires a real published compartment and a completed native row with no additional provider call. |
| Native auto-compaction is not treated as a conflicting second summarizer | Chosen integration on the imposed hook carrier | The adapter answers the host's compaction hook locally. The conflict scenario explicitly requests a real native fold, requires zero competing model calls, and observes the checkpoint on the subsequent wire request. |
