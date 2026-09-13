# v0.42.1 r3 hermetic 404 adjudication

Verdict: **HARNESS**, reproduced on macOS on 2026-09-13 with Bun 1.4.2 and OpenCode 1.18.29. No product code, timeouts, or retry policy changed.

## Executed cause chain

1. The instrumented, otherwise unchanged harness failed A1 (not the originally reported A3/B12): 6 pass, 1 fail, 115.48 seconds. `sendPrompt` reported HTTP 404, `application/json; charset=utf-8`, 21 bytes, `{"error":"Not found"}`, with **metadata.url `http://127.0.0.1:61988/messages`**. The config dump had exactly **baseURL `http://127.0.0.1:61988`**. No request reached that fixture's mock; the other six fixtures captured 56 requests with zero misses.
2. The listener snapshot taken *before* the run already had `opencode PID 52899 FD 1153 IPv4 127.0.0.1:61988 (LISTEN)`. A subsequent `curl --noproxy '*' -i http://127.0.0.1:61988/messages` returned the identical JSON 404 signature. Thus the child requested its configured URL, but that IPv4 socket belonged to another process.
3. Before the fix, `MockProvider.start` called `Bun.serve({port: 0, fetch})` without a hostname, then advertised `127.0.0.1` (now `src/mock-provider/server.ts:96-107`). On this Bun/macOS combination the default listener can coexist with an already occupied IPv4 port. An owned two-server control reproduced this directly: bind a foreign server to `127.0.0.1:0`, bind a default-address Bun server to the foreign port, then fetch both addresses. Output: `foreign=http://127.0.0.1:62831/`, `mock=http://localhost:62831/`, advertised-address response `foreign-control`, actual mock-address response `mock-control`.
4. The same default-address bind succeeded against the reported workerd port 53864, and fetching the advertised IPv4 URL reached that foreign listener. No host service was stopped or reconfigured. The structural fix binds the mock to the exact IPv4 address it advertises. An occupied IPv4 port now fails binding instead of silently routing elsewhere.

This is an address-binding mismatch, **not evidence of a historian/model fallback selecting the wrong provider**. The original r3 artifacts were not present in this isolated worktree; the original A3/B12 details are the task-supplied evidence. Their exact historical URLs cannot be recovered from this reproduction. The matching response signatures alone would not identify their server, but the fresh failure includes both the actual URL and its pre-existing socket owner.

## Why not a cache-invariants-only model path?

`tests/cache-invariants.test.ts:160-176` uses `TestHarness.create`, disables dreamer and compressor, and sets a 20% threshold. The Rust seam is shared `src/opencode-runner/spawn.ts:570-590` (line numbers before this change), not a special unpinned cache-invariants provider fixture. It provisions the hermetic stack and writes the Rust project tier. `writeConfigs` calls `pinMockAgents` (`src/mock-routing.ts:4-51`), which pins historian/dreamer host models and rejects off-mock fallback models. Captured user config had both `historian.opencode.model` and `dreamer.opencode.model` equal to `mock-anthropic/mock-sonnet`, with dreamer disabled. A3 is pure-defer; B12's Rust branch (`tests/cache-invariants.test.ts:778-804`) checks module-owned memory/replay rather than performing the TS epoch mutation. Reproduction in A1 establishes that neither special path is required.

There *was* a separate provider-set weakness: baseline `/config/providers` included built-in `anthropic`, source `env`, enabled by the harness's own fake `ANTHROPIC_API_KEY`. It was not selected in the observed failure (the error URL was the configured mock). Defense in depth now sets `enabled_providers`, `model`, and `small_model`, validates every registered endpoint, and checks the child's resolved `/config/providers` before returning the harness. All post-fix effective-provider captures contained only `mock-anthropic` with the exact fixture mock URL. No host auth or models.dev fallback was observed executing.

## Verification and captures

Prerequisite gate: `bun packages/e2e-tests/scripts/check-rust-prerequisites.ts --hermetic` passed. Dependencies were initially missing in the new worktree; `bun install --frozen-lockfile` resolved them without manifest/lock changes. The initial zero-collection missing-module attempt is not counted as a reproduction.

The release wrapper accepts no file filter and automatically retries failures. To isolate this file without retries, executed its exact per-file command from `scripts/run-rust-hermetic-e2e.sh:26`, from `packages/e2e-tests`, with opt-in tracing added:

```sh
MC_E2E_MODE="rust" NODE_ENV="" MC_E2E_TRACE_PROVIDER=1 bun test --timeout 600000 --max-concurrency=1 tests/cache-invariants.test.ts
```

Three independent post-fix processes, not retries hiding a failure:

| Run | Result | Duration | Captures | Misses | IPv4 ports (all paths `/messages`) |
| --- | --- | --- | --- | --- | --- |
| 1 | 7 pass / 0 fail | 49.15s | 63 | 0 | 63695, 63728, 63759, 63789, 63827, 63874, 63912 |
| 2 | 7 pass / 0 fail | 45.63s | 63 | 0 | 63955, 63986, 64025, 64051, 64091, 64122, 64149 |
| 3 | 7 pass / 0 fail | 51.56s | 63 | 0 | 64181, 64210, 64353, 64381, 64414, 64446, 64472 |

Every captured URL was `http://127.0.0.1:<listed-port>/messages`, and every effective-provider baseURL matched that fixture. `MC_E2E_TRACE_PROVIDER=1` emits the generated config directory/config, resolved endpoint set, and every mock request path/URL with a cumulative miss counter. A mock log cannot observe connections sent to another server; the binding fix and effective-provider check address that limitation rather than claiming absence from the log proves isolation.

Local raw evidence: `/tmp/r3-adjudication-run1.log`, `/tmp/r3-adjudication-fixed{1,2,3}.log`, `/tmp/r3-adjudication-listeners.txt`. Initial load averages: 10.59/9.51/10.43. Workerd listeners (including PID 9836 on 53864) and the foreign OpenCode listener remained running. Unlike r3 this was a single-file run, with a cold first hermetic build in this worktree. No load change is needed to explain the failure: address/port selection suffices.

Additional gates passed:

- `bun test src/mock-provider/server.test.ts src/mock-routing.test.ts src/harness.test.ts src/opencode-runner/spawn.test.ts src/rust-runner/hermetic-subc.test.ts`: 17 pass, 0 fail.
- Root `bun run typecheck` passed.
- From e2e: `bun x tsc --noEmit --skipLibCheck --module preserve --moduleResolution bundler --target esnext --types bun src/mock-provider/server.ts src/mock-provider/server.test.ts src/mock-routing.ts src/mock-routing.test.ts src/opencode-runner/spawn.ts` passed.
- Mutation: reverting to Bun's omitted hostname reddened only `mock refuses a port already owned on its advertised IPv4 address`; the advertised-URL/404 test stayed green. Neutralizing the effective-provider guard reddened only `rejects extra effective providers even when the configured mock is correct`; four existing routing tests stayed green. Restored files and reran both suites: 7 pass, 0 fail.
