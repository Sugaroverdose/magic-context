# Live config read-site report

The schema mark `x-mc-live-reload` is the authoritative live set. A producer samples one validated user → profile → project snapshot before starting work; `sampleLiveConfig` copies **only marked leaves** over the boot config. A failed reload leaves the preceding generation active. The table lists each marked leaf and the run-boundary reader; it is checked against the generated schema by `live-schema-drift.test.ts`.

| Live key | Run-boundary reader |
| --- | --- |
| `commit_cluster_trigger.enabled` | OC1 `hook.ts` → `transform.ts:resolveHistorianRun`; OC2 `v2/hooks/context.ts` → transform; Pi `index.ts:resolveHistorianFromConfig` |
| `commit_cluster_trigger.min_clusters` | Same historian trigger snapshot |
| `dreamer.omp.fallback_models` | Pi/OMP `index.ts:sampleDreamRun` → `dreamer/index.ts`; task executor takes the resulting model chain |
| `dreamer.omp.model` | Same Pi/OMP dream-task snapshot |
| `dreamer.omp.tasks` | Same Pi/OMP dream-task snapshot, task allowlist at task resolution |
| `dreamer.omp.thinking_level` | Same Pi/OMP dream-task snapshot |
| `dreamer.opencode.fallback_models` | OC1 `index.ts:sampleDreamRun` → `dream-timer.ts`; `hook.ts:runManual`; OC2 `v2/hooks/dream-trigger.ts` |
| `dreamer.opencode.model` | Same OC1/OC2 dream-task snapshot |
| `dreamer.opencode.tasks` | Same OC1/OC2 dream-task snapshot, task allowlist at task resolution |
| `dreamer.opencode.variant` | Same OC1/OC2 dream-task snapshot |
| `dreamer.pi.fallback_models` | Pi `index.ts:sampleDreamRun` → `dreamer/index.ts` |
| `dreamer.pi.model` | Same Pi dream-task snapshot |
| `dreamer.pi.tasks` | Same Pi dream-task snapshot, task allowlist at task resolution |
| `dreamer.pi.thinking_level` | Same Pi dream-task snapshot |
| `dreamer.tasks.classify-memories.schedule` | OC1/Pi `dream-timer.ts:runProjectMaintenance`; OC2 `dream-trigger.ts`, each from sampled task config |
| `dreamer.tasks.compress-cues.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.curate.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.evaluate-smart-notes.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.maintain-docs.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.map-memories.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.promote-primers.promotion_threshold` | Same task config, passed to promotion executor |
| `dreamer.tasks.promote-primers.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.refresh-primers.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.retrospective.recency_days` | Same task config, passed to retrospective executor |
| `dreamer.tasks.retrospective.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.review-user-memories.promotion_threshold` | Same task config, passed to review executor |
| `dreamer.tasks.review-user-memories.schedule` | Same task config; also OC1/OC2 `resolveHistorianRun` and Pi historian options sample the candidate-collection gate |
| `dreamer.tasks.verify-broad.schedule` | Same per-tick/per-run task config |
| `dreamer.tasks.verify.schedule` | Same per-tick/per-run task config |
| `historian.omp.fallback_models` | Pi/OMP `index.ts:resolveContextOptionsForProject` and command runtime deps → `resolveHistorianFromConfig` |
| `historian.omp.model` | Same Pi/OMP historian run snapshot |
| `historian.omp.thinking_level` | Same Pi/OMP historian run snapshot |
| `historian.opencode.fallback_models` | OC1 `hook.ts:sampleHistorian` → transform/managed recomp, timer fallback count; OC2 `v2/hooks/context.ts:resolveHistorianRun`; `rpc-handlers.ts:buildManagedCtx` for manual recomp; Rust `rust-mode-transform.ts` request chain |
| `historian.opencode.model` | Same OC1/OC2/Rust historian run snapshot |
| `historian.opencode.variant` | Same OC1/OC2/Rust historian run snapshot |
| `historian.pi.fallback_models` | Pi `index.ts:resolveContextOptionsForProject` and command runtime deps → `resolveHistorianFromConfig` |
| `historian.pi.model` | Same Pi historian run snapshot |
| `historian.pi.thinking_level` | Same Pi historian run snapshot |
| `historian.two_pass` | OC1 `hook.ts` → transform/managed recomp; OC2 `v2/hooks/context.ts` → transform |
| `historian_timeout_ms` | OC1 `hook.ts`/timer, OC2 `v2/hooks/context.ts`, Pi `index.ts` before historian run |
| `memory.auto_promote` | OC1 `hook.ts` managed recomp and `transform.ts:resolveHistorianRun`; OC2 transform callback; Pi historian options and command runtime deps |
| `memory.git_commit_indexing.enabled` | OC1/Pi `index.ts:sampleDreamRun` → `dream-timer.ts:runProjectMaintenance` |
| `memory.git_commit_indexing.max_commits` | Same dream-timer tick snapshot |
| `memory.git_commit_indexing.since_days` | Same dream-timer tick snapshot |
| `mural.model` | OC1/Pi timer `sampleDreamRun` and manual dream command; OC2 `dream-trigger.ts` |
| `toast_duration_ms` | OC1 `hook.ts:sampleHistorian` captured for managed recomp and `transform.ts` notifications; `command-handler.ts:executeDreaming` and `rpc-handlers.ts:buildManagedCtx` each sample once; RPC/TUI refresh for subsequent notifications. OC2/Pi have no duration consumer |

## Reclassified or excluded read sites

- `language` remains class B: its guidance is rendered into served system-prompt bytes; changing it needs a render epoch, which is outside this change. `protected_tokens` is likewise boot-bound. The m[0]/m[1] pure-replay test seeds, changes `protected_tokens`, defers, and compares served bytes while also changing the live toast/model inputs.
- `historian.top_p` stays class D. Its read site is hidden-agent registration (`resolveHistorianAgentOverrides`), like `historian.temperature`; OC1's v1 `SessionPromptData.body` has no per-request sampling field. The report's class-A `historian.temperature` therefore remains restart-only in OC1 rather than claiming a partial cross-host reload.
- `dreamer.temperature` and `dreamer.top_p` likewise flow into hidden-agent registration, not the per-task request in OC1; registration is intentionally boot-time. They remain restart-only.
- `keep_subagents` is assigned to the process-wide cleanup flag by `packages/plugin/src/index.ts:setKeepSubagents` at boot, so a project-specific snapshot cannot safely replace it mid-run. `shadow_embedding.enabled` selects the embedding lane at construction. Both remain restart-only.
- `memory.retrieval_count_promotion_threshold` has no runtime read outside its schema at this revision; it cannot be advertised as a live consumer.

`hook.ts` and `transform.ts` needed edits to replace copied historian options and to capture notification lifetime for a run. Neither re-renders a system prompt: only producer input and UI notification parameters vary. The class-B `protected_tokens` defer-pass replay proves m[0]/m[1] bytes remain unchanged after an on-disk change.
