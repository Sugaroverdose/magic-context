Thanks for the precise report. Your 0.41.2 source cites were exact. The current source confirms the same mechanism: `getDefaultSessionMeta()` seeds `cacheTtl: "5m"`, `ensureSessionMetaRow()` inserts that value, and row conversion uses `row.cache_ttl || "5m"` semantics (`packages/plugin/src/features/magic-context/storage-meta-shared.ts:307-316`, `:365-389`, `:408-416`). The first model-bearing assistant completion was the later correction point.

This is fixed for 0.41.3 on both OpenCode and Pi:

- Status display now resolves against live config plus the current model while the row is unsynced, and labels the source: `Cache TTL: 1h (config for anthropic/claude-opus-5)`, `Cache TTL: 1h (session)`, or `Cache TTL: 5m (default — no cache_ttl for <model>)`. OpenCode RPC uses the persisted model key to decide whether the row is current (`packages/plugin/src/plugin/rpc-handlers.ts:730-743`, `:805-841`); Pi `/ctx-status` uses the same resolver (`packages/plugin/src/hooks/magic-context/execute-status.ts:105-134`).
- Pi seeds an unsynced session row during `session_start` when `ctx.model` is available (`packages/pi-plugin/src/index.ts:1337-1362`). OpenCode applies the same safe seed on the first model-bearing user message. The completed assistant path remains the correction/ownership point.
- The scheduler path is unchanged: it still reads `session_meta.cache_ttl`. The new resolver is status-only, and the early seed refuses to overwrite a row once a completed-response model owns it. Tests pin that a status read cannot mutate the row.
- `/ctx-status` also places any config parse failure first, so a real default and an ignored/recovered config are no longer visually indistinguishable (`packages/plugin/src/hooks/magic-context/execute-status.ts:149-155`).

The related doctor side finding is fixed in the same release: `doctor --issue --harness pi --report <path>` writes a sanitized report bundle without prompting (`packages/cli/src/commands/doctor-pi.ts:1049-1073`).
