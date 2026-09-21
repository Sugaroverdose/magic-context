# Tokenizer calibration

Run from the plugin directory:

```sh
bun run scripts/calibrate-tokenizer/index.ts --only claude-opus-4-7,claude-sonnet-4-6,claude-fable-5-1,claude-opus-5
```

Anthropic uses `ANTHROPIC_API_KEY` or trimmed `~/.config/anthro.key` at runtime. It sends `x-api-key` and the existing adapter's `oauth-2025-04-20` beta header to `/v1/messages/count_tokens?beta=true`. OAuth cannot use count_tokens (`jwt auth is not yet supported on count_tokens`); without a key the harness retains a minimal, paid usage fallback. PROSE is never measured with paid completions. Errors omit response bodies to avoid leaking credentials/request data.

SYSTEM is the repository system fixture; TOOLS is the repository's 39-tool fixture. PROSE joins public ARCHITECTURE.md and STRUCTURE.md inside project-docs, 52 synthetic tiered compartments through the real decay renderer inside session-history, and 60 synthetic `#id: fact` memories. Prose is measured as first-user-message text, appended to the baseline `x`. Each probe subtracts the same model's one-token-user-message baseline. Local tools counts use JSON.stringify of the tool array, not SDK-expanded tool counts. Results retain earlier, unselected model rows.

## Anthropic measurements — 2026-09-21

All four models accepted the free endpoint. Ratios are provider count / raw local count.

| Model | Method | SYSTEM | TOOLS | PROSE | Docs | History | Memory |
|---|---|---:|---:|---:|---:|---:|---:|
| claude-fable-5-1 | count_tokens | 1.511497 | 1.551639 | 1.571778 | 1.540424 | 1.597525 | 1.792429 |
| claude-opus-5 | count_tokens | 1.511497 | 1.551639 | 1.571778 | 1.540424 | 1.597525 | 1.792429 |
| claude-opus-4-7 | count_tokens | 1.511497 | 1.569801 | 1.571778 | 1.540424 | 1.597525 | 1.792429 |
| claude-sonnet-4-6 | count_tokens | 1.019447 | 1.143337 | 1.057976 | 1.055501 | 1.054887 | 1.128031 |

Cross-check against shipped SYSTEM/TOOLS: Opus 4.7 +0.099143% / -0.012669%; Sonnet 4.6 -0.054200% / +0.292753%. Both pass the 5% stop threshold. Existing system/tools table values are retained for these controls. Prose defaults to 1.0 for unmeasured entries. Fable 5.2 stays neutral; Fable 5.1 snapshots match the measured prefix. OpenRouter and Copilot aliases mirror upstream 5.x ratios following the existing 4.7/4.8 convention, not independent route measurements.

Synthetic memory drifts more than documentation/history, so these are content-dependent approximations, not exact tokenizers. The real-session regression uses rounded local sidebar readouts with a parent-approved 5% band around exact count_tokens references (a 3% band would imply false precision). Its exact before/after split is:

| Bucket | Before (neutral) | After (measured Fable) |
|---|---:|---:|
| System | 9,000 | 13,603 |
| Tool definitions | 19,000 | 29,481 |
| Compartments | 98,000 | 154,034 |
| Facts | 0 | 0 |
| Docs | 36,000 | 56,584 |
| Memories | 15,000 | 23,577 |
| Profile | 4,000 | 6,287 |
| Conversation | 126,909 | 89,612 |
| Tool calls | 222,091 | 156,822 |
| Total | 530,000 | 530,000 |

Residual tool calls still exceed the raw local 70K: calibration removes misattributed m0 drift but cannot identify the remaining unmeasured conversation/tool drift. No budget, hygiene, historian, or transform decision changes. Plugin replay identity tests passed, including the full suite's pre-optimization served-wire digest, byte-identical hot passes, and four pure defer passes preserving served bytes.
