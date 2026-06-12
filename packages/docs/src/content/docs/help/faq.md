---
title: FAQ
description: Answers to common questions about Magic Context, privacy, data storage, and configuration.
---

## Does Magic Context send my code anywhere?

No. All durable state — messages, compartments, memories — is stored in a local SQLite database at `~/.local/share/cortexkit/magic-context/context.db`. Nothing is sent to any Magic Context server.

The background historian and dreamer agents run as subagents using **your configured model providers**. When they run, your session content is sent to those providers (the same way your primary coding session already sends to them). Magic Context does not introduce any new data recipients beyond the model providers you have already chosen.

Semantic embeddings use the `embedding.provider` setting. The default is `"local"` — the embedding model runs in-process using `Xenova/all-MiniLM-L6-v2`, which never sends data anywhere. If you configure an `openai-compatible` endpoint, embedding queries go to that endpoint only.

## What does it cost to run?

Magic Context is prompt-cache-aware — all context mutations are timed to not invalidate your provider's cached prefix. In practice this means less re-billing of your cached history across turns.

The historian and dreamer agents make their own model calls using whichever models you configure. GitHub Copilot models are preferred in the default fallback chain because they use request-based pricing — ideal for single-prompt background work where you don't want per-token charges stacking up.

For most sessions, historian costs are modest: it processes a batch of messages once per compression event, not on every turn.

## Can I turn things off?

Yes. Most features have explicit toggles. See the [configuration reference](/reference/configuration/) for all keys.

| Feature | Config key | Default |
|---|---|---|
| Memory (cross-session) | `memory.enabled` | `true` |
| Agent-driven reduction (`ctx_reduce`) | `ctx_reduce_enabled` | `true` |
| Auto-search hints | `memory.auto_search.enabled` | `true` |
| Temporal markers | `temporal_awareness` | `true` |
| Dreamer (overnight consolidation) | `dreamer.enabled` | `false` |
| Embeddings | `embedding.provider` | `"local"` |

Setting `ctx_reduce_enabled: false` hides the `ctx_reduce` tool and removes all nudges. The historian and heuristic cleanup still run.

## Where is my data stored?

All Magic Context state lives in one place:

```
~/.local/share/cortexkit/magic-context/context.db
```

On Windows, this resolves to the XDG-equivalent path. The database is shared between OpenCode and Pi — memories and compartments are scoped by harness and project, not by which terminal you're using.

The local embedding model cache (if using `embedding.provider: "local"`) is stored at:

```
~/.local/share/cortexkit/magic-context/models/
```

This is about 90 MB and is downloaded on first use. It can be safely deleted — it will be re-downloaded the next time an embedding is needed.

## Can I edit or delete memories?

Yes.

- **Via the agent:** Ask the agent to call `ctx_memory` with `action="write"` or `action="delete"`. This works in any session.
- **Via the dashboard:** The [desktop app](https://github.com/cortexkit/magic-context/releases) has a memory browser that lets you search, filter, edit, and bulk-delete memories.

Memories are scoped to a project (identified by git root commit hash). Deleting a memory removes it from all future sessions on that project.

## What happens when context hits 85% or 95%?

Magic Context's execution threshold is configurable (default: 65% of the model's context window). When context usage exceeds this threshold, queued operations are executed.

If context rises to 95% before queued operations clear it (which should be rare), the historian fires immediately in "emergency" mode, compressing as aggressively as needed to bring usage down. This is a last-resort operation — normal operation keeps context well below this level.

You can check the current state with `/ctx-status` and force a flush with `/ctx-flush`.

## How does it work with subagents?

When your primary agent spawns a subagent, Magic Context gives the subagent lighter treatment: memories are still injected, but the subagent does not have the full `ctx_reduce` guidance and does not trigger historian runs. This is intentional — subagents are short-lived and do not accumulate the kind of history that benefits from compartmenting.

The historian and dreamer themselves run as subagents. They are configured separately and do not see the `ctx_reduce` tooling — they have their own focused prompts.

## Can I use Magic Context across multiple machines?

Not currently. The database is local to one machine. Memories, compartments, and session history do not sync between machines.

If you work across machines, you can manually copy `~/.local/share/cortexkit/magic-context/context.db` between them — they share the same schema and project identity (git root hash), so memories written on one machine will appear on the other after a copy. There is no automatic sync.

## Do memories from OpenCode appear in Pi?

Yes. Project memories are stored in the shared database scoped by project identity (git root commit hash), not by harness. A memory written in an OpenCode session appears in the next Pi session for the same project, and vice versa.

Per-session state (compartments, tags, session facts) is scoped to the originating harness and session.

## What is the database format?

SQLite. The schema is managed by Magic Context's migration system and is upgraded automatically when you update the plugin. You can open and inspect it with any SQLite tool, but do not write to it directly — the schema may change between versions.

The [desktop dashboard](https://github.com/cortexkit/magic-context/releases) provides a UI for viewing and editing the data that is safe to use.
