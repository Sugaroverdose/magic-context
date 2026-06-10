export const CTX_EXPAND_DESCRIPTION = `Recover the original conversation from your compacted history.

Older parts of this session are summarized into <compartment> blocks inside <session-history> — e.g. <compartment start="120" end="245" title="Fixed tagger collision">. Each one replaces the raw messages in that ordinal range with a summary. When the summary isn't enough — you need exact wording, a specific value, an error message, or the reasoning behind a decision — expand the range:

ctx_expand(start=120, end=245)  ← the compartment's own start/end attributes

Returns the raw transcript as [N] U:/A: lines, capped at ~15K tokens; an oversized range returns the head and tells you where to continue. Also works with ordinals from ctx_search message results — expand a window around a hit (e.g. start=N-10, end=N+5). Ranges after the last compartment are your live tail — already visible in context, not expandable.`;

export const CTX_EXPAND_TOKEN_BUDGET = 15_000;
