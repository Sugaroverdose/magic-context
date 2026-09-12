# D5 specimen fixture

This is the MC-owned, **DERIVED** and sanitized specimen for the D5 uncovered predecessor tail. It carries 141 ordered members (1799–1939) for joint Magic Context/Thalamus replay without committing the private source capture or store.

Provenance:

- store membership and tagged-member kinds: `VACUUM f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0`
- byte lengths, untagged-member kinds, roles, block geometry, and tool links: capture `13610-req-body`, SHA-256 `766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b`
- attribute counts: lengths: 141 from capture; kinds: 83 from db, 58 from capture; tool links: 141 from capture

Sanitization preserves message order, ordinals, roles, normalized source block counts and kinds, per-block UTF-8 byte lengths, reduction lengths, and closed tool-use/result arcs. The recognized compaction instruction at 1939#1 is excluded as a contract provenance addition rather than treated as predecessor source. Only the approved probe string in each of ordinals 1824, 1864, and 1927 remains verbatim; all surrounding payload bytes are deterministic stand-ins. It does **not** preserve token counts, historian quality, semantic content outside those probes, or provider-valid reasoning signatures. Signature bytes are opaque synthetic test data.

`NativeBlock.bytes` uses compact, key-sorted JSON of each provider block after `type`, `id`, and `tool_use_id` are lifted into contract fields. Scalar text is normalized as `{"text": ...}`. The frozen contract leaves this representation open. Archive `V` entries are base64 compact JSON renderings of `NormalizedMessage` in contract field order; the applied-state payload is a stable JSON scaffold for units, tags, drops, and ledger without token counts or clocks.

`expected-manifest-v1.json` and `expected-archive-v1.json` are scaffolds, not oracles. They are structurally ready but not digest-valid while `digests_pending` is true. Slice 0 must compute every placeholder from an **independent** reference implementation and hand-checked CE1 preimage vectors—not from the codec under test—then freeze the results.

Regenerate from the two private inputs:

```sh
python3 packages/plugin/scripts/gen-d5-specimen-fixture.py \
  /path/to/d5-specimen.db \
  /path/to/13610-req-body
```

The generator refuses either input unless its SHA-256 matches the values above. `fixture-index-v1.json` catalogs every sibling fixture file; it cannot hash itself without a recursive self-reference.
