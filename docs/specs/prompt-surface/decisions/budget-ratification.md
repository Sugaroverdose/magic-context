# Budget policy ratification

- **recordId:** `prompt-surface-budget-r1`
- **artifactId:** `prompt-surface-budget`
- **artifactRevisionOrDigest:** `sha256:77082b5ff1546f45160b08e896e6c1f434654ba4f52b0806bd20b0b24cd67213`
- **decision:** `ACCEPT — floor(0.50 × mutable-prose baseline), ceiling 1825`
- **authorizedDecisionOwner:** `Ufuk`
- **ratificationTimestamp:** `2026-08-08T18:44:57Z`
- **scope:** `The primary built-in full guidance variant primary-full-reduce-memory-on and its active ctx_* descriptions; serialized parameter schemas are reported separately; adjuncts and USER overrides are excluded.`
- **status:** `RATIFIED`

## Proposed policy and evidence

- **Tokenizer package:** `ai-tokenizer`
- **Encoding:** `claude`
- **Version:** `1.0.6`
- **Counting method:** `new Tokenizer(claudeEncoding).count(rawText)`
- **Primary feature call:** `buildMagicContextSection(null, 20, true, true, true, false, false, undefined, true)`
- **Active tools:** `ctx_reduce`, `ctx_expand`, `ctx_note`, `ctx_memory`, `ctx_search`
- **Mutable-prose baseline:** `3650` tokens (`2003` guidance + `318 + 395 + 391 + 234 + 309` descriptions)
- **Integer light ceiling:** `1825` tokens (`floor(0.50 × 3650)`)
- **Fixture:** `docs/specs/prompt-surface/budget-fixture.json`
- **Deterministic gate:** `bun packages/plugin/scripts/measure-agent-surface.ts --assert`

The fixture recomputes the baseline from the current built-in source. A source mismatch is a gate failure; it cannot be repaired by silently changing the measured value. Light prose is not yet present, so the gate reports no light counts until a ratified S3 light manifest is supplied.

## Drift note (observed 2026-11-05, assembly-v2 census)

The mechanically enforced ceilings live in
`packages/plugin/scripts/prompt-surface-fixture.ts`
(`RATIFIED_LIGHT_MUTABLE_PROSE_CEILING = 1917`,
`RATIFIED_FULL_MUTABLE_PROSE_CEILING = 3750`) — consistent with
`floor(0.50 × 3834)` / `floor(0.50 × 7500)`, not with the 3650-baseline
figures recorded above. The fixture suite (budget-fixture.json,
checklist.json, light-mapping.md) was refreshed upstream by
`a3929436d` (2026-10-01, "mason: refresh prompt surface CI fixtures")
without a matching decision record; the gate authority is the fixture
constants, which both the assembly and v2 trunks carry identically. The
r1 numbers above are preserved as the original ratification as-measured;
no retroactive re-ratification is asserted here. Owner follow-up: file or
fold an r2 decision record upstream (or confirm the mason refresh as the
de-facto r2) so doc and gate agree on one digest.
