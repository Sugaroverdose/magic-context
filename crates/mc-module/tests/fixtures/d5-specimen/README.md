# D5 specimen fixture

This is the MC-owned, **DERIVED** and sanitized specimen for the D5 uncovered predecessor tail. It carries 141 ordered members (1799–1939) for joint Magic Context/Thalamus replay without committing the private source capture or store.

Provenance:

- store membership and tagged-member kinds: `VACUUM f589668287f41abaeb2a6526ee6d6f9d162e7ed80b1650f1ca5ec0a45984b8c0`
- byte lengths, untagged-member kinds, roles, block geometry, and tool links: capture `13610-req-body`, SHA-256 `766c26e1fab1129e0866e275c22d79e111a4382140f4334095279c46f26f526b`
- attribute counts: lengths: 141 from capture; kinds: 83 from db, 58 from capture; tool links: 141 from capture

Sanitization preserves message order, ordinals, roles, normalized source block counts and kinds, each provider block's JSON structure, per-block encoded byte lengths, every string leaf's decoded UTF-8 byte length, reduction lengths, and closed tool-use/result arcs. All 188 blocks preserve both length measures; zero are encoded-only or decoded-only, and this capture contains zero opaque blocks. Object keys, nesting, arrays, numbers, booleans, and nulls are real; string leaf values are synthetic equal-length fillers chosen from the source character's JSON escape and UTF-8 width class. The recognized compaction instruction at 1939#1 is excluded as a contract provenance addition rather than treated as predecessor source. Only the approved probe string in each of ordinals 1824, 1864, and 1927 remains verbatim at its original position inside its synthetic string value. It does **not** preserve token counts, historian quality, semantic content outside those probes, or provider-valid reasoning signatures. Reasoning signatures are synthetic.

Contract clause 2 (types) pins `NativeBlock.bytes` to this normative canonical JSON algorithm:

1. Parse to the JSON semantic value model and emit UTF-8.
2. Sort object keys lexicographically by Unicode code point, never by key length or source order.
3. Use `,` and `:` separators with no surrounding whitespace.
4. Do not ASCII-escape non-ASCII characters. Escape only quote, backslash, and U+0000–U+001F: use `\n`, `\r`, `\t`, `\b`, and `\f` short forms, and lowercase `\uXXXX` for the remaining controls.
5. Render integers as shortest decimal. Render finite floats with the shortest round-trip representation, preserving `.0` and signed zero and spelling exponents as lowercase `e` with no `+` or leading zeroes.
6. Emit no trailing newline.

These rules are the definition; `canonical-json-vectors-v1.json` contains independent hand-written conformance checks designed to distinguish wrong ordering, escaping, and number algorithms. Known block kinds lift `type`, `id`, and `tool_use_id` into contract kind/tool-link fields while retaining every other provider field. Scalar text is normalized as `{"text": ...}`. Archive `V` entries are base64 compact JSON renderings of `NormalizedMessage` in contract field order; the applied-state payload is a stable JSON scaffold for units, tags, drops, and ledger without token counts or clocks.

## Opaque blocks

An unknown provider block lifts nothing, receives kind `opaque`, and preserves its exact raw provider bytes, including key order, whitespace, and escape and number spelling. Raw preservation keeps content and identity digests over opaque blocks equal across adapters; in this derived fixture only string values are sanitized in place, without re-serializing or changing any non-string byte.

`expected-manifest-v1.json` and `expected-archive-v1.json` remain scaffolds, not oracles, despite the real structure and lengths. Readiness stays `scaffold` until slice 0 fills every pending digest from **independent** reference-implementation preimage vectors and hand-checked CE1 preimage vectors—not from the codec under test—and freezes the results.

Regenerate from the two private inputs:

```sh
python3 packages/plugin/scripts/gen-d5-specimen-fixture.py \
  /path/to/d5-specimen.db \
  /path/to/13610-req-body
```

The generator refuses either input unless its SHA-256 matches the values above. `fixture-index-v1.json` catalogs every sibling fixture file; it cannot hash itself without a recursive self-reference.
