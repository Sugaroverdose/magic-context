# Tokenizer calibration Phase A verification

This is an execution record, not a declaration that the full Phase A inventory is complete. Outstanding implementation limitations remain explicitly listed in root and package `PARITY.md`. Release notes are drafted in `.cortexkit/alfonso/release-notes/v0.42.8.md`.

## Pinned revisions and isolation

- Master: `7486664df07096385e3a5985427b335a221a2bd2`.
- Runtime candidate: `6eddf386937058ffcde18b88179c3bb987d517f0`.
- Every host comparison used fresh throwaway HOME/XDG roots, synthetic prompts, the existing OpenCode mock-provider capture and no paid completion, live database, private prompt dump or credentials.
- Both extracted refs use one throwaway project path so system/tool comparisons do not conceal different working-directory prompts. The instrument is held constant; application code comes from each pinned ref.

## Gate: four actual defers

Executed:

```sh
root=$(mktemp -d "$PWD/.calibration-replay.XXXXXX")
HOME="$root" XDG_CONFIG_HOME="$root/config" XDG_DATA_HOME="$root/data" \
XDG_CACHE_HOME="$root/cache" XDG_STATE_HOME="$root/state" \
bun packages/e2e-tests/scripts/pure-replay-differential.ts --ts-only \
7486664df07096385e3a5985427b335a221a2bd2 \
6eddf386937058ffcde18b88179c3bb987d517f0
```

The owned throwaway root was removed after the command. Result: **IDENTICAL, four actual consecutive `defer` decisions on both revisions**. The comparator now requires exactly four defers and compares actual captured messages, system and tools using the existing capture serializer; it no longer silently skips pairs of non-defer decisions.

| Pass | Message bytes | Messages SHA-256, equal on both refs |
|---|---:|---|
| 1 | 262 | `165aed197ad1aa46c0684bd42be821ce39aba9c766afe42ff3e6b992f117c938` |
| 2 | 428 | `05945f88a5aabd1dd6152301133488ce317d4b400485496a3d65a22b4a53be73` |
| 3 | 594 | `d649359b66b444497d1e4d8be711382c23aefcccd2d19fd00a69d8d4c322eaed` |
| 4 | 760 | `9e81ff690576752bb4c5d9b87f69ae93474f6c10dca4230b278617a2fc552ae2` |

All four corresponding system hashes were `47e20ddbc55f5979ac072d42344f43a3131f6b83af746e0ebe3fa6ae3d5ac2ce`; all four tools hashes were `25ad4f7756af5cc9f1957c094d19d04e0570b1281fcd4cfca1e4c61861f9c0b1`. Model: `anthropic/mock-sonnet`, neutral decision seed. These system/tool hashes describe this run's shared throwaway path, not a normalized prompt.

The E2E package's `tsc --noEmit` was attempted. It reports 11 diagnostics in unchanged files (retina-local-fs alias resolution, a readonly symbol assignment, the existing Rust harness SDK type, and OpenCode-2 tests), and none in the changed comparison script. This is not recorded as a clean package typecheck; plugin/Pi typechecks remain clean.

The earlier message-only differential also passed after runtime commits `7a4060b3afd9494062ceee9f424e1cbcad8a3187`, `daab52e32a7bac1ff36e45bbad889e053644e6fc`, `f026f1fe64712aedb69393a4c55f5964bb040709`, `3532a5b1c71ea8d4b59230665aa508b9b6ba52e9`, and `f5b35b07485e22cab122037e6c6e7c1395c4bdaf`. Each had the four message hashes above against pinned master. No row required a defer-divergence rollback.

This gate does not by itself establish the separate seeded-HARD/restart/table-revision or priced neutral/Fable comparisons.

## Other executed checks

- `cargo check -p mc-module`: passed.
- `cargo test -p mc-module`: passed after fixing verification-discovered lifecycle regressions; 1,213 library tests passed, 8 existing tests ignored, and every integration target passed.
- `cargo clippy -p mc-module --all-targets -- -D warnings`: passed.
- Plugin and Pi `typecheck` scripts: passed.
- Plugin and Pi `build` scripts: passed.
- Targeted history, protection, producer, fallback/replay, emergency, system-hook, event-hook and candidate-EMA tests: passed. Full adapter suite gates are recorded separately when executed.
- AFT diagnostics were incomplete because authoritative TypeScript/Biome producers were unavailable; compiler/typecheck gates are the authority.
- Migration delta check against master covering `**/migrations.ts`, `**/storage-db.ts` and `crates/mc-store`: empty.

## Fable fixture units

The fixture calculations are independent arithmetic using static prose `1.571778` and tool policy seed `1.551639`; they are estimates in provider-token units, not a new provider measurement. A 60,000-provider-token history budget converts to 38,173 local tokens (`59999.481594` estimated provider tokens). Eight 1,000-local-token tool tags under a 6,000-provider-token floor retain tags 5–8 instead of tags 3–8. Whole crossing tags and the newest-three minimum remain protected.

Fable 5.1 fixture: history allowance 94,307 → at most 60,000 estimated real tokens (38,173 local); protected reach 6 tags / 9,310 → 4 tags / 6,207 estimated real tokens.
