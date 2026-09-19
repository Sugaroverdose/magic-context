# Host scenario matrix

Pi/OMP status rechecked on 2026-09-19; OpenCode status captured on 2026-09-18 against OpenCode 1, OpenCode GA 2.0.5, Pi, and OMP.
`declared-divergence` means the host is named in the manifest entry's `divergences`
array and the cited host surface cannot express the OpenCode behavior. `product-bug`
means the real-host run failed. OMP's earlier provisional product-bug labels
were adjudicated by execution below.

| Scenario | OpenCode | OpenCode 2 | Pi | OMP |
| --- | --- | --- | --- | --- |
| cache invariants | pass | product-bug | pass | pass |
| cache stability | pass | product-bug | pass | declared-divergence |
| compaction off | pass | product-bug | pass | pass |
| conflict disable | pass | product-bug | pass | pass |
| context limits | pass | product-bug | pass | pass |
| deferred compaction marker | pass | product-bug | declared-divergence | pass |
| dropped-input guard | pass | product-bug | declared-divergence | declared-divergence |
| drops | pass | pass | pass | pass |
| emergency blocking | pass | product-bug | pass | pass |
| historian success | pass | product-bug | pass | pass |
| long-running session | pass | product-bug | pass | declared-divergence |
| memory injection | pass | product-bug | pass | pass |
| notice-loop race | pass | declared-divergence | declared-divergence | declared-divergence |
| overflow recovery | pass | product-bug | declared-divergence | pass |
| session isolation and removal | pass | product-bug | declared-divergence | declared-divergence |
| short-context overflow | pass | product-bug | pass | pass |
| slow historian | pass | product-bug | pass | pass |
| smoke | pass | pass | pass | pass |
| subagent behavior | pass | declared-divergence | declared-divergence | declared-divergence |
| tag-owner collision | pass | pass | pass | pass |
| tagging | pass | pass | pass | pass |
| thinking-block safety | pass | declared-divergence | declared-divergence | declared-divergence |
| todo synthesis | pass | product-bug | pass | pass |
| window overlay reload | pass | product-bug | pass | pass |
| Pi cross-harness | declared-divergence | declared-divergence | pass | declared-divergence |
| Pi Rust degradation arc 1 | declared-divergence | declared-divergence | pass | declared-divergence |
| Pi Rust degradation arc 4 | declared-divergence | declared-divergence | pass | declared-divergence |

## Reproduction summary

- OpenCode 1 manifest lane: 54 passed, 0 failed. The separately excluded overlay
  reload scenario also passed. All 52 pre-fold test names remained present; the
  two new canonical `drops` and `tagging` scenarios account for the increase.
- Pi manifest lane: 41 passed, 0 failed after corrections (21 files). The focused
  overlay scenario also passes. The two Pi-only Rust degradation files were not
  rerun in this adjudication; their prior record was 6 passing tests.
- OpenCode 2 manifest lane: 12 tests passed and 29 failed across 20 selected
  scenarios. The first contract-level reproduction is `context-limits.test.ts`:
  `last_context_percentage` remains `0` instead of `47.83773440489858`. Historian
  scenarios do not publish, session removal does not clear Magic Context rows,
  and the overlay scenario also leaves pressure at `0`.
- OMP baseline reproduced: 19 passed, 21 failed, one setup error across 20 files.
  Final manifest lane: 36 passed, 0 failed, 0 errors across 18 files; the focused
  overlay adds one passing test. Removing two declared-divergence files removes
  four tests (including their non-failing companions), not just the two red tests.
  Corrected configuration and fixtures pass the independent historian, memory,
  todo and overflow assertions. Two whole-system scenarios are now declared
  host-imposed divergences; later long-session OMP phases are not claimed tested.
- Window overlay: Pi and OMP now persist `21.784593935169045` for the 100K
  overlay and `13.174536256323776` after a 160K rewrite plus reload. The stale
  value before reload remains asserted. OpenCode 2's earlier `0` remains unfixed.

Commands:

```sh
MC_E2E_MODE=ts MC_E2E_HOST=<host> NODE_ENV='' bun test --timeout 600000 \
  $(bun scripts/validate-mode-manifest.ts --mode ts --harness <host>)
MC_E2E_MODE=ts MC_E2E_HOST=<host> NODE_ENV='' bun test --timeout 600000 \
  tests/window-overlay-reload.test.ts
MC_E2E_MODE=rust MC_E2E_HOST=pi NODE_ENV='' bun test --timeout 600000 \
  tests/pi-rust-degradation-arc-1.test.ts tests/pi-rust-degradation-arc-4.test.ts
```

## Changed-row reasons (Pi/OMP adjudication)

| Row | One-line reason |
| --- | --- |
| cache invariants | HARNESS GAP: shared config enables publication; seeded m[0]/m[1] memories now use OMP's macOS cwd identity. |
| cache stability | HOST-IMPOSED: OMP hashes each body into `system[0].cch`, so whole-system bytes cannot stay fixed. |
| compaction off | HARNESS GAP: load the requested off-mode config and seed memory under the host's directory identity. |
| conflict disable | HARNESS GAP: OMP reads auto-compaction from `config.yml`, not `settings.json`. |
| deferred compaction marker | HARNESS GAP: shared user config enables the real OMP historian and native marker path. |
| emergency blocking | HARNESS GAP: shared user config supplies thresholds and the mock historian model. |
| historian success | HARNESS GAP: corrected configuration yields a real OMP child request and committed compartment, without changing spawn code. |
| long-running session | HOST-IMPOSED: phase-1 whole-system identity fails on OMP's attestation; Pi also needed an applied-native-marker reader rather than OpenCode's SQL column. |
| memory injection | HARNESS GAP: expose extension tools and invoke the advertised `_ctx_memory` name. |
| overflow recovery | HARNESS GAP: corrected configuration enables historian recovery and clears the recovery state. |
| short-context overflow | HARNESS GAP: distinct 20KB records avoid OMP's loop rejection and actually drive pressure to 93.6%. |
| slow historian | HARNESS GAP: corrected configuration sends slow historian requests to the local mock provider. |
| todo synthesis | HARNESS GAP: direct tool exposure plus `_todowrite` recognition preserves exact synthetic IDs, payloads and replay bytes. |
| window overlay reload | PRODUCT BUG: configured host windows were mislabeled observed; OMP additionally needed a mock overlay cell and restart/resume reload. |

Detailed source citations and carrier differences are in
[`packages/pi-plugin/PARITY.md`](../pi-plugin/PARITY.md#35-omp-provider-attestation-prevents-whole-system-byte-parity).
No new assertion is waived except by the two explicit manifest host divergences.
