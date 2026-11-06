# Planted-rogue witness: removing the TEST_RUNNER_ENTRY exclusion reddens the law

Production edit under witness: the exclusion block in `hostEntries()`
(pi-harness-kind.ts) deleted; everything else unchanged.

State binding — the tree id hashes exactly this documented dirty state:

- HEAD: `a5eae5935` (RED-evidence commit; the fix was still uncommitted)
- `git status --porcelain`:
  ```
   M packages/pi-plugin/src/pi-harness-kind.ts
  ?? package-lock.json
  ?? packages/pi-plugin/src/pi-harness-kind-test-entry-law.test.ts
  ```
- file states: `pi-harness-kind.ts` = the version later committed in
  `ebbac5170` with the six-line `if (TEST_RUNNER_ENTRY_PATTERN...)` block
  removed (pattern constant retained); the law file = the `ebbac5170`
  version, still untracked; `package-lock.json` = npm-install artifact.
- tree id (mc-gate formula): `8a10e67cc95fe01b5c632b9c58486e279b92e1cc1e39b00d1429deaa9a98994c`

Reproduction (verified): a scratch worktree at `a5eae5935` with those three
file states yields the identical tree id and porcelain output above.

## src/pi-harness-kind-test-entry-law.test.ts — 26 fail / 3 pass

The 24 shape cases (12 app-name + 12 package-name) and both slot-census
rows redden. The 3 surviving greens are the two real-host controls and the
static executable-vocabulary disjointness census — correctly rogue-blind.

```
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.test.ts even when the enclosing tree ships @oh-my-pi/pi-utils [13.69ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.test.tsx even when the enclosing tree ships @oh-my-pi/pi-utils [2.29ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.test.js even when the enclosing tree ships @oh-my-pi/pi-utils [2.54ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.test.jsx even when the enclosing tree ships @oh-my-pi/pi-utils [1.76ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.test.mjs even when the enclosing tree ships @oh-my-pi/pi-utils [1.75ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.test.cjs even when the enclosing tree ships @oh-my-pi/pi-utils [1.73ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.spec.ts even when the enclosing tree ships @oh-my-pi/pi-utils [2.23ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.spec.tsx even when the enclosing tree ships @oh-my-pi/pi-utils [1.85ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.spec.js even when the enclosing tree ships @oh-my-pi/pi-utils [1.70ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.spec.jsx even when the enclosing tree ships @oh-my-pi/pi-utils [1.88ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.spec.mjs even when the enclosing tree ships @oh-my-pi/pi-utils [2.16ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > app-name rung stays silent for probe.spec.cjs even when the enclosing tree ships @oh-my-pi/pi-utils [2.10ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.test.ts even inside a real host package [1.61ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.test.tsx even inside a real host package [1.40ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.test.js even inside a real host package [1.39ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.test.jsx even inside a real host package [1.78ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.test.mjs even inside a real host package [1.47ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.test.cjs even inside a real host package [1.29ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.spec.ts even inside a real host package [1.26ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.spec.tsx even inside a real host package [1.25ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.spec.js even inside a real host package [1.23ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.spec.jsx even inside a real host package [1.31ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.spec.mjs even inside a real host package [1.96ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > package-name rung stays silent for probe.spec.cjs even inside a real host package [1.65ms]
(fail) LAW: the detection slot cannot be populated from *.test.ts-shaped paths > async detection with only a test-shaped argv[1] memoizes no rung-attributed detection [1.83ms]
(fail) LAW: the detection slot cannot be populated from *.test.ts-shaped paths > sync detection with only a test-shaped argv[1] never writes the slot [2.12ms]
...
 3 pass
 26 fail
 32 expect() calls
Ran 29 tests across 1 file. [78.00ms]
```

## src/index.test.ts — original defect restored: 3 fail / 2 pass

```
 2 pass
 3 fail
 6 expect() calls
Ran 5 tests across 1 file. [318.00ms]
```

Exclusion restored immediately after capture; law file re-greened at the
restored tree.
