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

## OpenAI API-key measurements

Reference: https://developers.openai.com/api/docs/guides/token-counting?lang=python (read 2026-09-21). The current guidance documents a server-side `POST /v1/responses/input_tokens`, including gpt-6-astra; this is not a tiktoken approximation. Uses OPENAI_API_KEY or ~/.config/openai.key. SYSTEM goes in `instructions`; TOOLS maps the same fixture to Responses function definitions; PROSE is user input. All subtract a minimal-user baseline. The four extra system tokens and one extra prose token are envelope/separator differences retained in the reported ratios.

| Model | Method | SYSTEM | TOOLS | PROSE | Docs | History | Memory |
|---|---|---:|---:|---:|---:|---:|---:|
| openai/gpt-5.5 | responses/input_tokens | 1.000278 | 0.850953 | 1.000017 | 1.000032 | 1.000043 | 1.000426 |
| openai/gpt-6-astra | responses/input_tokens | 1.000278 | 0.850953 | 1.000017 | 1.000032 | 1.000043 | 1.000426 |

Both accepted. Existing openai-codex/* result rows and OAuth routing remain separate and unchanged. The GPT-5 fallback test excludes 5.5 now because its more-specific measured entry deliberately supersedes the family default. No unmeasured provider aliases added.

## Kimi / Moonshot

Reference: https://platform.kimi.ai/docs/api/estimate. Adapter sends SYSTEM as a system message, TOOLS as chat function schemas, and PROSE as a user message to `POST https://api.moonshot.ai/v1/tokenizers/estimate-token-count`; reads `data.total_tokens`, baseline-subtracted. Credentials: MOONSHOT_API_KEY or ~/.config/kimi.key. The docs list kimi-k2.6 but do not explicitly list a tools field in the estimate schema; the tools cross-check will stop the harness if a server silently ignores it.

2026-09-21: both moonshot/kimi-k2.6 and moonshot/kimi-for-coding returned HTTP 429 on the minimal baseline. Method `tokenizers/estimate-token-count`; SYSTEM/TOOLS/PROSE and section ratios unavailable, cross-check not reached. No paid fallback was used and no Kimi table entries were added or changed. Retry with an endpoint-authorized key/quota before calibrating. The existing opencode-go/kimi-k2.6 0.87/0.86 remains the 5% cross-check reference, not a substituted measurement.
