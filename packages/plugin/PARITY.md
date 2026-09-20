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

## Known gaps on OpenCode 2

| Gap | Imposed or chosen | Host surface and evidence |
| --- | --- | --- |
| A model-echoed `§N§` at the start of an assistant reply is persisted and rendered verbatim | Host-imposed | OpenCode 1.x fires `experimental.text.complete` once per completed assistant text; `src/hooks/magic-context/text-complete.ts` strips the echoed tag there before the host persists the part (the tag is visible while streaming and gone on completion). OpenCode 2 has no equivalent seam: every `session` trigger site in `@opencode/core@2.0.5` and `2.0.11` (`prompt`, `context`, `compaction`, `generate`, `title`, `model.request`, `http.request`, `http.response`, `retry`, `experimental.ws.*`) is on the outbound path, `session.update` cannot rewrite messages, and the TUI renders `part.text.trim()` with no part-level render seam. The wire is unchanged (the next request strips and re-tags the echo exactly as on 1.x), so only the transcript view differs, most visibly on weak models that echo often. Rewriting the provider stream in `http.response` would work but couples us to every provider wire format and is not taken. Resolution: an upstream hook equivalent to `experimental.text.complete`; until then this is a documented OpenCode 2 limitation. |
| The sidebar is hidden by default | Host-imposed | `sidebar.content` is toggled with `ctrl+x b` on the host. The OpenCode 1 sidebar component itself is what paints there (`src/v2/tui/sidebar-mount.ts`, loaded from `src/tui-compiled/` through the host's `opentui:runtime-module:*` registry); the plain-text projection in `src/v2/tui/index.ts` is reached only on a host that registers no runtime modules, pinned by `src/v2/tui/sidebar-fallback.test.ts`. |

## Other existing host-carrier exclusions

These rows were already declared before this repair; they are not newly waived failing
assertions from the selected 20-scenario lane.

| Scenario | Imposed or chosen | GA surface |
| --- | --- | --- |
| Parented subagent behavior | Host-imposed | GA `Context.session.create` has no parent-link input; hidden work uses unparented roots. The dedicated GA hidden-child test continues to pass. See [hidden completions](../../PARITY.md#3-hidden-completions). |
| Ignored-notice loop race | Host-imposed | `@opencode/plugin@2.0.5/dist/promise/session.d.ts` exposes `SessionPrompt.delivery` and synthetic delivery, not v1 `noReply`/ignored MessageV2 rows and parentID loop-exit ordering. |
| V1 signed-thinking store projection | Host-imposed carrier difference | GA stores ordered `session_message` JSON and provider metadata, not v1 message/part rows. The v1-store scenario remains excluded rather than querying a fabricated legacy store. This does not waive signed-thinking preservation. See [host store reader](../../PARITY.md#5-host-store-reader). |
