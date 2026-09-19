# Host scenario matrix

Status captured on 2026-09-18 against OpenCode 1, OpenCode GA 2.0.5, Pi, and OMP.
`declared-divergence` means the host is named in the manifest entry's `divergences`
array and the cited host surface cannot express the OpenCode behavior. `product-bug`
means the real-host run failed; product code was not changed in this slice.

| Scenario | OpenCode | OpenCode 2 | Pi | OMP |
| --- | --- | --- | --- | --- |
| cache invariants | pass | pass | pass | product-bug |
| cache stability | pass | product-bug | pass | product-bug |
| compaction off | pass | pass | pass | product-bug |
| conflict disable | pass | product-bug | pass | product-bug |
| context limits | pass | pass | pass | pass |
| deferred compaction marker | pass | product-bug | declared-divergence | product-bug |
| dropped-input guard | pass | pass | declared-divergence | declared-divergence |
| drops | pass | pass | pass | pass |
| emergency blocking | pass | pass | pass | product-bug |
| historian success | pass | pass | pass | product-bug |
| long-running session | pass | product-bug | pass | product-bug |
| memory injection | pass | pass | pass | product-bug |
| notice-loop race | pass | declared-divergence | declared-divergence | declared-divergence |
| overflow recovery | pass | product-bug | declared-divergence | product-bug |
| session isolation and removal | pass | pass | declared-divergence | declared-divergence |
| short-context overflow | pass | product-bug | pass | product-bug |
| slow historian | pass | product-bug | pass | product-bug |
| smoke | pass | pass | pass | pass |
| subagent behavior | pass | declared-divergence | declared-divergence | declared-divergence |
| tag-owner collision | pass | pass | pass | pass |
| tagging | pass | pass | pass | pass |
| thinking-block safety | pass | declared-divergence | declared-divergence | declared-divergence |
| todo synthesis | pass | declared-divergence | pass | product-bug |
| window overlay reload | pass | pass | product-bug | product-bug |
| Pi cross-harness | declared-divergence | declared-divergence | pass | declared-divergence |
| Pi Rust degradation arc 1 | declared-divergence | declared-divergence | pass | declared-divergence |
| Pi Rust degradation arc 4 | declared-divergence | declared-divergence | pass | declared-divergence |

## OpenCode 2 repair evidence (2026-09-19)

- Context limits: adapter now persists completed assistant usage on `session.execution.succeeded` and feeds the resolved model catalog into shared budget arithmetic; harness output limit matches the other hosts (8,192). Exact real-host assertion: `47.83773440489858` for 20,000 / 41,808.
- Cache invariants: v2 now applies the shared system-guidance/hash handler; the scenario harness uses Anthropic transport like the other hosts so the existing wire oracle sees the actual provider request.
- Todo synthesis: GA has no native todo writer; the OC2 branch verifies the real tool inventory and empty durable todo state. A real-host tool-registration mutant makes this assertion fail.
- Dropped-input guard: select GA's `shell` tool instead of v1 `bash`; the unchanged refusal and recovery-message assertions pass on the real host.
- Window overlay reload: include the OC2 model key in the fixture and preserve mock usage across restart; exact initial and reloaded percentages pass.
- Compaction off: retain memory/tool registration, pass the shared compaction-off mode, and bypass v1-only synthetic marker deletion for GA-owned checkpoints.
- Memory injection: register the shared ctx_* implementations with the GA tool editor using JSON Schema; a real ctx_memory write is now present in a fresh session's first request.
- Historian success: Anthropic transport allows the shared historian mock matcher to return the publication payload; real-host publication now passes.
- Session isolation and removal: GA `session.remove` emits `session.deleted` with `data.sessionID`; subscribe to it and clear durable rows plus per-session adapter state.
- Emergency blocking: defer pressure refusal to the shared transform so its blocking historian recovery can run before provider admission.
- The usage repair does not explain all remaining failures: the immediate manifest rerun still finds requests filtered out by Anthropic-only wire readers, historian publication timeouts, and todo tool timeout. No assertion was relaxed.

## Reproduction summary

- OpenCode 1 manifest lane: 54 passed, 0 failed. The separately excluded overlay
  reload scenario also passed. All 52 pre-fold test names remained present; the
  two new canonical `drops` and `tagging` scenarios account for the increase.
- Pi manifest lane: 41 passed, 0 failed. The two Pi-only Rust degradation files
  passed 6 tests. The excluded overlay scenario reproduces the product bug below.
- OpenCode 2 manifest lane: 12 tests passed and 29 failed across 20 selected
  scenarios. The first contract-level reproduction is `context-limits.test.ts`:
  `last_context_percentage` remains `0` instead of `47.83773440489858`. Historian
  scenarios do not publish, session removal does not clear Magic Context rows,
  and the overlay scenario also leaves pressure at `0`.
- OMP manifest lane: 19 tests passed, 21 failed, and one setup error across 20
  selected scenarios. The failures include no historian publication, no synthetic
  todo pair, missing memory deltas in m[0]/m[1], and compaction-off behavior.
- Window overlay focused reproduction: after writing a 100,000-token overlay,
  Pi and OMP persist `10.427093760427093` (their 200,000-token default) instead of
  `21.784593935169045`; OpenCode 2 persists `0`. OpenCode 1 passes, then observes
  the 160,000-token rewrite after restart.

Commands:

```sh
MC_E2E_MODE=ts MC_E2E_HOST=<host> NODE_ENV='' bun test --timeout 600000 \
  $(bun scripts/validate-mode-manifest.ts --mode ts --harness <host>)
MC_E2E_MODE=ts MC_E2E_HOST=<host> NODE_ENV='' bun test --timeout 600000 \
  tests/window-overlay-reload.test.ts
MC_E2E_MODE=rust MC_E2E_HOST=pi NODE_ENV='' bun test --timeout 600000 \
  tests/pi-rust-degradation-arc-1.test.ts tests/pi-rust-degradation-arc-4.test.ts
```
