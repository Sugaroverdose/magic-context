# Broca transform contract (`owned-broca`)

For the Broca and prefrontal owners. It covers what a Broca-hosted session must pin
before Magic Context's transform is switched on for it, and what the module does to
each send. Nothing here is enabled yet. The claims are pinned by
`crates/mc-module/src/tests/broca_contract.rs`.

## 1. The facade tool array

**Source.** The Rust module owns its own copy of the five facade tools:

- names, schemas, and the full-preset descriptions: `ctx_*_description()` and
  `ctx_*_schema()` in `crates/mc-module/src/lib.rs`, plus `CTX_REDUCE_DESCRIPTION`
  in `crates/mc-module/src/prompt_surface.rs`;
- light-preset prose: `TOOL_LIGHT_DESCRIPTIONS` and `schema_with_preset_descriptions`
  in `prompt_surface.rs`;
- assembly: `prompt_surface::module_tools` / `session_tools`.

`packages/plugin/scripts/export-agent-surface.ts` exports the OpenCode plugin's
TypeScript tools. Those are a separate copy and are **not** what a Broca session gets.

**Goldens.** The exact array a Broca mason declares:

- `crates/mc-module/testdata/broca-facade-tools-full.json`
- `crates/mc-module/testdata/broca-facade-tools-light.json`

Order: `ctx_reduce`, `ctx_memory`, `ctx_expand`, `ctx_search`, `ctx_note`. Object keys
are sorted. Each entry has `name`, `description`, `schema` (the provider's input
schema) and `execution_mode` (a subc field; don't send it to the provider). Sorting
by name on the caller side is fine as long as it happens once. The test fails if
the array served by `manifest.get` drifts from the goldens, by value or by byte. To
regenerate the goldens deliberately, run
`MC_BLESS_BROCA_FACADE_GOLDENS=1 cargo test -p mc-module --lib broca_contract`.

**What changes the array:**

| Input | Effect |
|---|---|
| Preset `full` / `light` | Tool and parameter descriptions only. Names, types, `required` and enums are identical. |
| `tool_descriptions` overrides (user config `prompt_surface.tool_descriptions`) | Replaces a tool's top-level description. Broca callers must not send any. |
| Module rebuild with changed copy | New bytes on the next `manifest.get`. The goldens make this a reviewed change in this repo. |
| `memory.enabled` | No effect. `ctx_memory` is always present (pinned by test). |
| `ctx_memory_list` | Never present. It exists only in the Pi plugin for dreamer children. |
| Startup (HELLO) manifest | Same full-preset definitions plus the internal `transform` tool. Never declare `transform` to a model. |

The schemas of `ctx_memory` and `ctx_note` advertise a `memory_project` property that
the host transport fills in. The model sees it. It is part of the golden bytes.

**Picking the preset.** Send `{"kind":"manifest.get","session_id":…,"preset":"full"|"light"}`
on the session's bound route. Omitting `preset` gives `full`. The module caches the
selection per session only in process memory (`freeze_prompt_surface_selection`,
keyed by session, `model_key` and `config_identity`). A module restart forgets it, a
request with another preset selects again, and transform requests write to the same
cache (Broca's transform sends no preset, which means `full`). So the module-side
cache is **not** a pin. The caller picks the preset once per session, stores the
array it got on the first send, and re-declares exactly those bytes on every later
send. It never fetches the array again mid-session.

If the pinned system prompt includes Magic Context guidance, fetch it with
`guidance.get` using the same preset. Under `owned-broca` the module always serves the
`no_reduce` guidance variant (`cc_u1_active` is Claude Code only). That variant tells
the model `ctx_reduce` is unavailable. Its date line is stored per session, so it
stays the same for the whole session.

## 2. What the transform does, send by send

Broca sends the loop's prompt with the pinned system prompt as the leading `system`
message (ordinal 0). The tool list is never sent to the module.

**Send 1** (the session's first materialization, reported as `decision: "HARD"`). The
served array is:

```
[ m[0] (synthetic user), m[1] (synthetic user), <caller's system message>, …rest ]
```

- m[0] holds `<project-docs>` (ARCHITECTURE.md / STRUCTURE.md when present),
  `<project-memory>` and the user profile when memory is enabled, then
  `<session-history>` (empty on a new session). m[1] holds `<session-history-since>`.
  Both are present from send 1 on, even when empty.
- The system message comes back byte for byte. The module adds no guidance, date
  line or tags to it and never merges m[0] or m[1] into it.

**Send 2 onward, on a replay pass** (`"SOFT+"`, the normal case). The whole
previously served prefix is replayed byte-identical and new messages are appended
verbatim.

**When the prefix changes.** Only on passes that already rebuild it:
`is_provider_prefix_mutation_pass` in `transform.rs` (plans `Hard`, `MigrateHard`,
`Soft`). This applies to `owned-broca` as to every profile. `Soft` re-renders m[1]
(new historian compartments, memory changes). `Hard` re-renders m[0] and replaces the
covered history with it. Hard is triggered by a fold, cache expiry, a `render_config`
change, or context pressure. Tail reclaim and queued drops also land only on these
passes (`tail_reclaim(OwnedBroca)` is true). The leading system message survives a
fold as long as it comes before the first covered ordinal
(`is_uncovered_leading_system`). If a fold ever covers it, Broca's `run.rs` re-adds
the durable leading system messages.

**Tags.** No `§N§` tag ever appears under `owned-broca`, on any send.
`tagging_surface_active` enables the overlay only for Claude Code and OpenCode, even
if a request sets `tool_present: true`. The test shows that if the gate were widened,
tags would start on the first user message of send 1.

## 3. What a caller must pin, and never send

Pin once per session, at the first send: the preset, the tool array (from the golden
or one `manifest.get`), the system prompt, and `render_config`.

Never, mid-session:
- change, add or remove a tool, or change its description;
- switch the preset or send `tool_descriptions` or `guidance_override`;
- change `render_config` (each change forces a full re-render);
- change the system message, or rewrite, reorder or re-number earlier messages (the
  module keys its state on `mid` + `ordinal`);
- declare `transform` or `ctx_memory_list`.

## 4. Gaps to fix before enabling

1. **`ctx_reduce` cannot work under `owned-broca`.** No tags are minted, so every
   call is refused with "no valid tags to queue". The served guidance (`no_reduce`)
   already says it is unavailable. Before enabling, decide on one:
   - the module turns on tagging and the full guidance variant for `owned-broca`;
   - masons omit `ctx_reduce` from their array.

   Whichever you pick has to hold for a session's whole lifetime.
2. **m[0] and m[1] come before the system message.** Broca's Anthropic, Gemini and
   Responses (instructions-field) renderers lift system messages out, so this is
   invisible there. `openai_chat`, and Responses without the instructions field,
   render messages in place, so the provider would see two user messages before
   the system prompt. The fix is either the module placing m[0]/m[1] after a leading
   system message for owned profiles, or Broca lifting system messages out in those
   renderers.
3. **Caller cache markers are lost.** Broca's `project_transform` puts back
   `cache_prefix_blocks` only when the output has the same length and block counts as
   the input. Adding m[0]/m[1] breaks that on every send. Broca needs to map its
   markers onto the transformed array (for example by `mid`) before enabling.
4. **Broca wire fields the module ignores.** `cache_ttl_ms` (the module reads a
   `cache_ttl` string), `overflow_error_text` (the module reads `provider_error`), and
   `agent_drop_ids` (the module uses its own durable drop queue). With `cache_ttl_ms`
   dropped, the module falls back to its configured TTL (5m by default) when it
   predicts cache expiry.
5. **The module doesn't keep the prompt-surface selection across restarts.** No fix
   is needed if callers pin their own array as described above. Just don't rely on
   `manifest.get` returning the same bytes later in a session.
