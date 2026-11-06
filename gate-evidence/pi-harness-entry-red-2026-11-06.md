# RED: pi-plugin index.test.ts locks harness to "omp" (argv-derived host entry)

Lane: `feat/v2-pi-harness-entry-fix` (base `assembly-v2` @ `6d21a9647`).
Captured BEFORE any production edit. Trigger artifact present:
`node_modules/@oh-my-pi/pi-utils` (repo-root, devDependency, `APP_NAME === "omp"`).

- tree id (mc-gate formula): `de99954ed8ea9806017554fadbec6cae2f793ae1bf8058962ad710c3ad8cf228`
- command: `cd packages/pi-plugin && bun test src/index.test.ts`
- bun 1.4.2 (`/opt/homebrew/bin/bun`)

Result: `2 pass / 3 fail / Ran 5 tests` — the 3 `it.each` cases die in
`createTestDb` → `setHarness("pi")` with
`Magic Context: harness already locked to "omp"; cannot change to "pi"`.

Mechanism: `src/index.ts:252` top-level `await resolvePiHarnessDetection()`;
`hostEntries()` feeds `process.argv[1]` (the test file under `bun test`) into
`appNameDetection`, which resolves `@oh-my-pi/pi-utils` from the enclosing
repo-root `node_modules`, imports it, sees `APP_NAME === "omp"`, and memoizes
kind=omp in the globalThis `HARNESS_DETECTION_SLOT`.

## bun test argv probe (predicate evidence)

`bun test` (bare), `bun test <filter>`, `bun test ./rel.test.ts` all yield
argv `[<bun.exe>, <absolute path of the executing test file>]` — the `test`
subcommand and filter args are consumed; argv[1] is always the test file
being run. `process.title` is `"bun"`, no test-runner env marker exists.
The ambient `process.execPath` entry (`/opt/homebrew/lib/node_modules/bun/bin/bun.exe`)
is inert: nearest package name is `bun`, executable basename `bun` is outside
the Pi image vocabulary, and `dependencyPackageRoot` finds no
`@oh-my-pi/pi-utils` on its ancestor walk (`ls /opt/homebrew/lib/node_modules`
→ `@earendil-works @zvec bun esbuild npm stealth-agent-browser-mcp`;
`@oh-my-pi` absent).

## Raw output (clean)

```
bun test v1.4.2 (744846f84)

src/index.test.ts:
36 |  */
37 | export function setHarness(value: HarnessId): void {
38 |     if (harnessLocked && currentHarness !== value) {
39 |         throw new Error(
40 |             `Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`,
41 |         );
             ^
error: Magic Context: harness already locked to "omp"; cannot change to "pi"
      at setHarness (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/plugin/src/shared/harness.ts:41:9)
      at createTestDb (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/pi-plugin/src/test-utils.test.ts:10:2)
      at <anonymous> (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/pi-plugin/src/index.test.ts:18:14)
(fail) Pi todowrite registration from resolved config > registers tool, command and overlay only when enabled is %s [2.72ms]
36 |  */
37 | export function setHarness(value: HarnessId): void {
38 |     if (harnessLocked && currentHarness !== value) {
39 |         throw new Error(
40 |             `Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`,
41 |         );
             ^
error: Magic Context: harness already locked to "omp"; cannot change to "pi"
      at setHarness (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/plugin/src/shared/harness.ts:41:9)
      at createTestDb (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/pi-plugin/src/test-utils.test.ts:10:2)
      at <anonymous> (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/pi-plugin/src/index.test.ts:18:14)
(fail) Pi todowrite registration from resolved config > registers tool, command and overlay only when enabled is %s [0.27ms]
36 |  */
37 | export function setHarness(value: HarnessId): void {
38 |     if (harnessLocked && currentHarness !== value) {
39 |         throw new Error(
40 |             `Magic Context: harness already locked to "${currentHarness}"; cannot change to "${value}"`,
41 |         );
             ^
error: Magic Context: harness already locked to "omp"; cannot change to "pi"
      at setHarness (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/plugin/src/shared/harness.ts:41:9)
      at createTestDb (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/pi-plugin/src/test-utils.test.ts:10:2)
      at <anonymous> (/Users/Sugaroverdose/Git/magic-context-worktrees/pi-harness-entry-fix/packages/pi-plugin/src/index.test.ts:18:14)
(fail) Pi todowrite registration from resolved config > registers tool, command and overlay only when enabled is %s [0.07ms]

 2 pass
 3 fail
 6 expect() calls
Ran 5 tests across 1 file. [174.00ms]
```
