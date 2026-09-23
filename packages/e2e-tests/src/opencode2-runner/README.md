# OpenCode 2 runner

Run `bun install`, initialize the pinned CLI if Bun blocked its postinstall (`cd packages/plugin/node_modules/@opencode/cli && node postinstall.mjs`), and run `bun run --cwd packages/plugin build` (2.0.12 loads `index.js` then `dist/index.js`). Then:

```sh
bun test packages/e2e-tests/tests/opencode2
packages/plugin/node_modules/.bin/tsc -p packages/e2e-tests/src/opencode2-runner/tsconfig.json
```

The runner never uses the operator's config or provider credentials. The mock binds explicitly to 127.0.0.1. Every server has a fresh HOME and all four XDG roots, an allowlisted environment, a detached process group, and bounded event-driven startup. `lsof` and `ps` are required, not optional. At handoff and teardown the whole process group is checked for forbidden open paths, and lsof's inode must match the expected private database. These are samples, not continuous kernel-level monitoring. Exit/signal handlers reap live v2 groups. Teardown kills the entire group even if safety inspection fails.

The runner never reads the operator's live database or configuration for a snapshot. It checks private DB placement by inode and lsof, inspects writable descriptors, and fences protected directory metadata. Mapped read-only libraries (including temporary `.so` files) and TUI source files are not writable host output. Finder's `.DS_Store` does not fail the directory fence.

## 2.0.12 failure adjudication

| Test | Class | Evidence | Correction |
| --- | --- | --- | --- |
| `fold-s3-owner` (local, provider) | (b) host/probe drift | Both hooks ran after replacing Bun's undefined `__promiseAll` in the temporary probe; 2.0.12 persists provider-mode unarchived messages in `recent`, while the summary excludes them. | Fix probe bundling and assert restored tail instead of requiring empty `recent`. |
| `commands-s2-host-registration`, `commands-s2-flush` | (b) test-contract drift | The host registered all six commands and executed `ctx-flush`; the first ordinary turn logged `WILL RUN`, the second `WILL NOT RUN` (scheduler defer). | Count both pass decisions; still require a new explicit-flush `WILL RUN` decision after the command. |
| `commands-s2-keymap` | (c) environment guard | The TUI command layer registered every slash name; lsof listed read-only loader paths. | Check writable descriptors and database/config paths, not all mapped files. |
| `context-s2-lanes` I16 | (b) test-contract drift | The guard returned `Not executed: your arguments` for both dropped inputs, not the older wording. | Assert the current refusal text and no tool execution. |
| `context-s2-lanes` I17 | (b) host behavior | The host can complete a fold between the usage reading and the next request; the plugin's admission rule ignores usage made stale by a completed fold. | Require a completed fold before any resumed request, or a recorded interruption without one. |
| `marker-s3-runtime` I10 | (c) environment fixture | The v2 half recorded zero v1 calls; the v1 observer rejected the isolated environment because it required `XDG_STATE_HOME`, which the v1 runner does not set. | Use the isolated `XDG_DATA_HOME` fallback; verify all four v1 control functions run. |
| `pins.test.ts` | (b) fixture drift | The v1 entry added tool-parameter recording to the dropped-input refusal after the original source hash was captured. | Update the source pin while continuing to strip only the v2 loader additions. |
| `status-dialog` (dark, light) | (c) environment guard | macOS Finder writes `.DS_Store`, and lsof lists read-only `/private` and TUI source files. | Ignore Finder metadata, classify open paths by database/config risk and writable mode. |
| `store-generation-conversion` (Linux CI) | (c) environment guard | CI 35914546734 mapped `/tmp/.bcd9cd1efcadb2fc-00000007.so`, a temporary shared library, not a store. | Allow mapped libraries; unit-test that exact path and refuse an outside `.db` and `.db-wal`. |

This lane targets 2.0.12; the 2.0.5 provider-mode `recent` assertion is intentionally retired rather than treating an obsolete host representation as the product contract. The installed 2.0.12 `@opencode/plugin` `dist/promise/{session,command}.d.ts` still exposes a compaction summary result and server command registration, just as the 2.0.5 declarations do; the assertions above distinguish that stable plugin API from changes observed in the real host's persisted rows and pass scheduling.

## Observed GA corrections

* `serve --standalone` really exits 1 with `Unrecognized flag: --standalone in command opencode serve`. Help alone was insufficient: `--help` bypasses argument rejection. The named constant is `--standalone`, but the runner uses direct `serve --hostname 127.0.0.1 --port 0`, without `--service`. The standalone rejection has its own real-CLI test.
* `OPENCODE_DB=opencode2.db` **is honoured by the installed CLI 2.0.12**, despite the earlier core-only grep. The actual files are `$XDG_DATA_HOME/opencode/opencode2.db`, `-wal`, and `-shm`; lsof verifies the DB inode. The read site was not located in the native CLI binary. Private XDG roots remain the primary isolation boundary.
* V2 config uses `plugins`, `providers`, and provider `settings`, not v1's singular keys/options. The source for these shapes is installed `@opencode/schema@2.0.5 dist/config/{plugin,provider,model}.js`; the attached core `mime-0gc96ev3.js:119-121` also lists the plural keys. A 16k mock catalog requires a smaller explicit compaction buffer/keep budget to avoid compacting immediately with the host's large default reserve.
* Directory plugin targets resolve `<directory>/server` before `<directory>/index`, bypassing package exports. The published root `server.js` shim and the `./server` export both reach `dist/v2/server.js`. The root v1 export and TUI export are unchanged. Both target forms are tested against the real GA `Host.resolve`.

## Evidence and artifacts

`evidence-sha256.json` pins the supplied audit/playbook/GA bytes under `.cortexkit/alfonso/drafts/oc2-evidence/`. Main citations:

* `ga/core-module-schema.excerpt.js:34-67`: id/setup schema, extra-key tolerance and schema errors wrapped by the host as `PluginModule.LoadError`.
* `ga/plugin-host.js:4-29`: directory/name resolution and optional RPC absence.
* `ga/plugin-promise-session.d.ts:105-107`: session create/prompt domain. The installed SDK `@opencode/client@2.0.5 dist/promise/client.d.ts:22-54` exposes agent list/get only and session create/prompt; the plugin `dist/promise/agent.d.ts:5-14` has no add/register operation. Use session.create with an explicit model, then prompt for hidden children. Prompt itself does not accept a model override.
* `ga/core-session-sql.excerpt.js` and `oc-audit-7a31b5c0f7.md:166-202`: JSON row storage, seq ordering and source filename rule. Sanitization follows the owner's R16 removal rule, rather than the audit's older replacement-with-hyphen spelling.
* `opencode-core-2.0.3/package/dist/chunks/mime-vz9r8jjr.js:45-54`: completed checkpoint selection and inclusive seq cut for the latest boundary. The reader is a raw row reader; it does not emulate the host's provider-specific checkpoint replay filters.
* `aft-playbook-fe8d4871f.md:54-64`: serve handoff and explicit mock provider routing.

`host-rows.json` is a small, unmodified row capture from real GA writes, not a fabricated host-store oracle. The reader tests reconstruct just the session_message table from those rows and separately label synthetic checkpoint edge cases. Record it explicitly with `OC2_RECORD_FIXTURE=1`; normal tests never update goldens. `sha256-pins.json` also pins the v1 codec golden, existing e2e mutation golden set, and root plugin source against base commit `21d161b62cd58b3053bc84028a39d10c786bf314`.

The payload probe uses scratch plugins, separate from the published entry, to submit equivalent text/thinking/tool-use/tool-result drafts through the actual two hosts. The native hook data shapes differ, so each scratch adapter constructs its host's representation. The existing mock captures parsed provider bodies (the same capture boundary used by the v1 lane); `payload-v1.json` and `payload-v2.json` retain those bodies, including host-owned tools/options. `probe-results.json` records the divergent verdict and differing top-level fields. Full body identity is not claimed: the host tools and default options differ as well as serialization. The probe does not change any existing Rust profile; the owner decides the gated profile slice.

## Acceptance map

| Item | Test |
| --- | --- |
| I0 / I12 safety | `hermetic_v2_runner environment refuses unsafe roots before boot`; `fd guard refuses operator paths and permits isolated database`; `live snapshot detects changed database and logs`; `handoff requires ordered URL and password` |
| I0a | `payload_identity_probe records real v1 and v2 provider bodies` |
| I0b | Real explicit-model create/prompt in both v2 lane tests; SDK surface recorded in probe-results |
| I0c | `rpc_entry_absence_probe and named/directory targets share server identity` |
| I1 | `GA Module accepts exact id/setup export`; `GA Module ignores extras and rejects v1 id/server with LoadError cause`; `v2_loads_via_exports_map and session_message_reader real host writes` |
| I2 | `v1_untouched and captured fixture bytes remain sha256 pinned`; real v1 payload lane |
| Reader | `R16 source filename table covers every channel and override branch`; `session_message_reader seq pages idle boundaries and checkpoint window` |

## Type boundary caution for later hook work

The empty production entry deliberately does not import the GA Plugin type namespace. Importing it into the v1 package-wide TypeScript program introduces Effect rc.112's global readonly `Error[ignore]` augmentation and breaks the unchanged v1 command sentinel assignment (`command-handler.ts:221`, TS2540). Removing that unnecessary import restored the full package typecheck and build; the entry is validated against the GA schema and the real loader instead. Later hook slices need to account for this cross-generation ambient-type collision rather than changing the v1 sentinel without owner review.
