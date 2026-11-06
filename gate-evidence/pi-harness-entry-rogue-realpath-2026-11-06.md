# Planted-rogue witness: deleting ONLY the realpath leg reddens the symlink-alias rows

Production edit under witness: in `hostEntries()`
(packages/pi-plugin/src/pi-harness-kind.ts) the exclusion was reduced to
`if (TEST_RUNNER_ENTRY_PATTERN.test(requestedPath))` — the
`TEST_RUNNER_ENTRY_PATTERN.test(resolvedPath)` clause deleted, everything
else unchanged.

State binding (tree id hashes exactly this documented dirty state —
reproducible by checking out the HEAD commit and applying the single edit
described above):

- HEAD: ``
- `git status --porcelain`:
   M packages/pi-plugin/src/pi-harness-kind.ts
  ?? package-lock.json
- tree id (mc-gate formula): ``

## Result: src/pi-harness-kind-test-entry-law.test.ts — 33 pass / 2 fail

Only the two symlink-alias rows redden (argv[1] = install/alias.js ->
install/index.test.ts; requestedPath not test-shaped, resolvedPath is):

```
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > symlink alias of the executing test file contributes no host entry (app-name rung) [9.72ms]
(fail) LAW: test-runner-shaped argv[1] contributes no host entry > symlink alias of the executing test file contributes no host entry (package-name rung) [1.94ms]
 33 pass
 2 fail
 39 expect() calls
Ran 35 tests across 1 file. [93.00ms]
```

The 24 requestedPath shape rows, both slot-census rows, both
test-shaped-host-bin fall-through rows, the static census, and all four
real-host controls stay green — pinning that the realpath leg is the sole
defender of the alias class and the requestedPath leg remains intact.

Exclusion restored after capture (restored state committed in the next
commit; law re-greened 35/35).
