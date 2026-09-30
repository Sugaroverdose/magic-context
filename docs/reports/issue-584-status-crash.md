# Issue 584: `/ctx-status` crash and the v85 → v91 migration under a live 0.42.6 server

Reporter: OpenCode 1.18.33 on Windows 11, plugin 0.44.4, upgraded from 0.42.6.
The TUI crashed with `undefined is not an object (evaluating 'view().headline')`
at `src/tui-compiled/dialogs/status-dialog.tsx:534`, and the reporter thought
their Magic Context data was gone.

## Summary

- **No data was lost.** Doctor shows 72 compartments and 188 memories in the
  native Windows `context.db`. The project identity audit found nothing that
  applies to this report, so it is not covered here.
- **Defect 1: the migration guard failed open on Windows.** A 0.44.4 process
  migrated the shared store from v85 to v91 while a 0.42.6 OpenCode server
  (PID 10376) was still running. The guard saw the live PID, could not check
  its identity, and continued. This is fixed for the tasklist-only case.
  Separately, what the guard should do when liveness truly cannot be
  determined is a policy decision; it is proposed below, not changed.
- **Defect 2: the status dialog crashed on any reply without a usable
  snapshot.** The reply most likely came from the 0.44.4 server's own
  home-directory instance, not from the stale 0.42.6 server (see "Where the
  crash payload came from"). The dialog now shows a "Status unavailable" view
  that names the reason. It also names an older server that is still running.

## The reporter's log (https://api.pastes.dev/EymM6ebDm4)

| Line | Time | Event |
| --- | --- | --- |
| 1–94 | until 10:15:53 | Session `ses_149d…` runs on 0.42.6 (store at migration lane 85). |
| 95 | 10:23:18 | New process PID 9352 (0.44.4) boots for `dir=~` (the home directory). |
| 99 | 10:23:20 | `storage warning: continuing migration …; OpenCode server PID 10376 was not confirmed because its liveness or identity check could not run.` |
| 101–108 | 10:23:20 | Migrations v86–v91 applied; lane now 91. |
| 110 | 10:23:20 | `not binding a project identity for this directory` (the home instance). |
| 112 | | `guard=487ms` |
| 114 | 10:23:21 | `another Magic Context RPC server is active for this project (pid 10376, port 52206)` |
| 121–122 | 10:23:37 | `home project memory disabled`, then the same PID boots for `~\Pictures\Camera Roll\VikStudio\TGroup`. |
| 127, 139 | | TGroup binds `dir:c37b5eb6bc68`; memories for it are embedded. The data is present. |
| 133 | | 0.42.6 PID 10376 also has an RPC server for TGroup (port 59480). |
| 135 | 10:23:56 | `command ctx-status: pushed show-status-dialog to TUI`, and the TUI crashes. |

## Defect 1: the migration guard continued under a live older server

### Which check

The boot opens the store through `openDatabaseAsync`
(`packages/plugin/src/features/magic-context/storage-db.ts`). Because the
store's version (85) was behind the build (91), it takes one process snapshot
with `inspectProcessesAsync()` (`shared/rpc-utils.ts`) and calls
`enforceMigrationOnOpenGuard` → `inspectRpcServerDiscovery`. For every RPC
discovery record (`<storage>/rpc/<project>/port-<pid>*.json`), that function
checks two things:

1. **Liveness**: `processes.liveness(pid)`. On Windows this comes from the
   snapshot: first a CIM query (`powershell Get-CimInstance Win32_Process`),
   then `tasklist /FO CSV /NH` as the fallback. PID 10376 was in the snapshot,
   so it was `"alive"`.
2. **Identity**: `isPidIdentityPlausible(record, evidence)`. It guards against
   a reused PID. Every real record carries `started_at` (checked against
   records written by a real 0.42.6 server). For such a record the check
   compared the process start time with `started_at`, and **returned
   `"inconclusive"` when no start time was available**.

tasklist reports image names only, never start times. When CIM does not
answer, every live holder is therefore `alive` and `inconclusive` at the same
time. The 573 change kept those records rather than deleting them, but
`enforceMigrationOnOpenGuard` treats `inconclusive` like `absent`/`stale`:
it logs line 99 and migrates. Two tests show this behavior: the existing unit
test `uses tasklist for the Windows command fallback and skips unavailable
start time` expected `"inconclusive"` for a tasklist-confirmed `OpenCode.exe`,
and the 573 regression used `started_at: 0`, which takes a different branch.

`kill(0)`/`ps` in the log message comes from the POSIX wording. On Windows the
guard calls neither of them.

### Why CIM gave no start time on the reporter's machine (not proven)

No Windows host was available, so this part is inference, not observation.
Any of the following leaves the guard with tasklist-only evidence, or with a
CIM row whose `CreationDate` does not parse:

- **PowerShell unavailable or blocked.** `powershell` is missing from the
  PATH OpenCode was started with, or AppLocker or antivirus kills it. A
  `guard=487ms` boot is fast for a cold PowerShell and CIM query, which
  usually takes more than a second. That points to a quick failure followed by
  the tasklist fallback.
- **`CreationDate` serialization.** The query piped a raw `DateTime` into
  `ConvertTo-Json`. PowerShell 7 emits a local-offset ISO string, and Windows
  PowerShell 5.1 emits `\/Date(ms)\/`. For a `DateTime` with extended
  properties, 5.1 emits an object:
  `{ "value": "\/Date(ms)\/", "DisplayHint": 2, "DateTime": "…" }`. The parser
  returned `null` for the object form, which made the identity check
  inconclusive even though CIM had worked.
- **Output size (synchronous callers only).** Bun's `execFileSync` throws
  `ENOBUFS` above its 1 MiB default output limit (verified locally). A full
  `Win32_Process` listing with command lines can exceed that on a busy
  desktop. The synchronous snapshot (`inspectWindowsProcessesSync`, used by
  the synchronous `openDatabase` path and doctor) then fell back to tasklist.
  The asynchronous boot path already allowed 8 MiB.

### Fix (in this change)

- `isPidIdentityPlausible`: when a record has `started_at` but the process
  start time cannot be read, it now falls through to the command-name/image
  check that legacy records without a start time already use (`opencode`,
  `node`, `bun`, `electron`). On Windows with tasklist-only evidence, a live
  `opencode.exe` is `plausible`, so the guard refuses with
  `storage fatal: refusing to migrate … while confirmed OpenCode server PID …`.
  A reused PID now owned by an unrelated image (for example `chrome.exe`) is
  `implausible`.
- The CIM query formats `CreationDate` itself
  (`$_.CreationDate.ToUniversalTime().ToString('o')`), so the output no longer
  depends on the PowerShell edition. The parser also accepts the 5.1 wrapped
  object.
- Synchronous process-list commands get an 8 MiB output limit, matching the
  asynchronous path.

Tests. These are unit tests against the Windows code paths (`platform:
"win32"`, faked `powershell`/`tasklist` output). They are not a real Windows
host.

- `rpc-async-probes.test.ts` › `Windows boot refuses to migrate under a live
  server that only tasklist can see`: a v85 store, a 0.42.6-style record with
  `started_at`, CIM failing, and tasklist listing `opencode.exe`.
  `openDatabaseAsync` returns null, the refusal names PID 10376, and the store
  stays at v85.
- `rpc-async-probes.test.ts` › `Windows PowerShell 5.1 wrapped creation dates
  still prove a holder's identity`.
- `rpc-utils.test.ts` › `uses tasklist for the Windows command check when no
  start time is available` (the rewritten contract), `a reused Windows PID
  with an unrelated image is implausible without a start time`, and `the
  synchronous Windows process list allows more output than the 1 MiB
  default`.

Remaining false-refusal risk: a stale record whose PID Windows has reused for
another `node.exe`/`bun.exe`/`opencode.exe` process now blocks the migration
until that process exits or the record is deleted. The refusal message names
the PID. The old behavior had the opposite failure, a silent migration under a
live older server.

### Proposal (not implemented): when liveness truly cannot be determined

This covers the case where no process list is available at all: a sandbox
denies `kill(0)` and `ps`, or both CIM and tasklist fail. Today the guard logs
and continues.

| Option | Cost | Benefit |
| --- | --- | --- |
| A. Continue (today) | Reproduces this incident whenever the probe is blind and an older server is alive. | Sandboxed hosts (Flatpak, some CI, hardened Windows) are never blocked. |
| B. Refuse | Every sandboxed user is blocked on each upgrade until they delete RPC records by hand. The refusal cannot tell a dead record from a live server. | No store is ever migrated under a live older build. |
| C. **Ask the RPC server itself (recommended).** The record already holds `port` (and `token`). A `GET http://127.0.0.1:<port>/health` succeeds only if that server is alive, and its body carries `pid` (and `instance_id`), which must match the record. The TUI's RPC client already does this (`rpc-client.ts` `healthCheck`). Refused connection: dead, delete the record. Matching reply: live, refuse. Timeout: fall back to A or B. | Adds up to one short loopback request per blind record at boot. Needs an async guard, which the boot path already is. | Needs no process-inspection permission, so it works in the sandboxes that motivated option A. It confirms exactly the server that holds the store. |

Recommendation: C, with option A as the timeout fallback, keeping today's log
line. A blind probe then continues only when the recorded server also does not
answer on loopback, which is much weaker evidence of a live holder than a PID
nobody could check. Since this change, the dialog also reports a migration
that continued past an unchecked holder (below), so the remaining risk is
visible to the user.

## Defect 2: the dialog crash

### Where the crash payload came from

The brief assumed the TUI read the stale 0.42.6 server's reply. The evidence
points elsewhere:

- The TUI's RPC client prefers the RPC server in its own process
  (`shared/rpc-client.ts`, `readPortFiles` sorts `pid === process.pid`
  first). It binds to the directory the TUI started in
  (`tui/index.tsx`: `initRpcClient(api.state.path.directory)` at plugin
  start). PID 9352 booted for `~` first (log line 95), so a TUI started in the
  home directory talks to 9352's home instance.
- 9352's home instance answers `status-detail` for the home directory with
  `{ sessionId, disabled: true }`. That branch exists since 0.44.3; 0.42.6
  had none.
- Replayed on a real OpenCode 1.18.30 TUI (throwaway root, mock provider),
  that reply gives the crash with the same message and the same frame,
  `status-dialog.tsx:534:36` in the `_$effect` at `:531:5`.
- A real 0.42.6 server gives something else. Its complete reply renders fine
  in the 0.44.4 TUI. After a newer build migrates the store under it
  (reproduced by migrating the throwaway store to v91 while it ran), it
  answers `{"error":"unavailable"}`, and the 0.44.4 TUI showed the MC-S01
  toast. Neither crashes.

The directory the reporter's TUI started in is not in the log, so this is the
best-supported path, not a certainty. Either way the fix covers it.

### What each payload does (real OpenCode 1.18.30 TUI, before and after)

Every host run used a throwaway root under
`$TMPDIR/magic-context/issue-584/<case>` (`XDG_*`, `OPENCODE_DB`,
`MAGIC_CONTEXT_STORAGE_DIR`, `HOME` for the home case) and the mock provider.
For each run, `lsof -p <opencode pid>` showed every open `.db`/`-wal`/`-shm`
under that root.

| Payload | 0.44.4 before | After |
| --- | --- | --- |
| RPC error envelope (Rust mode without a module): `{ error }` | MC-S01 toast, no dialog | Dialog: "Status unavailable · server did not answer", with the server's error text |
| Transport failure or timeout | same toast branch (by code) | same unavailable view |
| Home directory: `{ sessionId, disabled: true }` | **crash, `view().headline`** | "Status unavailable · home directory", naming `allow_home_project` |
| Paused identity (`.git` pointing nowhere): `{ sessionId, disabled: true, paused: true }` | **crash, `view().headline`** | "Status unavailable · memory paused", pointing at `magic-context.log` |
| Empty or partial reply | crash (unit) | "incomplete status data", listing the missing fields |
| 0.42.6 server, v85 store | renders; no hint the server is older | renders, plus "An older Magic Context server (one too old to report its version) is still running … quit all OpenCode processes, then start OpenCode again" |
| 0.42.6 server after a v91 migration: `{ error: "unavailable" }` | MC-S01 toast | unavailable view: "server did not answer" |
| New session with little stored state | renders | renders |
| Session with no stored state at all (unknown ID, fresh store) | renders (unit, real `status-detail` handler) | renders |

The error the view memo threw first, for every crashing payload, was
`TypeError: undefined is not an object (evaluating
'source.usagePercentage.toFixed')` from `buildStatusView`. It shows in the
stack trace when the compiled dialog is rendered in Bun, where Solid runs the
memo eagerly. In OpenCode an error boundary catches each error; the crash
screen shows the last one, the effect reading `view().headline`.

### Fix

- `shared/status-view-check.ts` is the one place a status payload is checked.
  `checkStatusDetailPayload` classifies the RPC reply: error envelope,
  `disabled`/`paused` reply, non-object, or snapshot. It checks every field
  `buildStatusView` reads through `checkStatusViewSource`. A missing or
  mistyped required field is named. An optional field with the wrong shape is
  dropped and listed in a warning. An unknown failure code is dropped, because
  `renderUserFacingFailure` throws on one. `buildStatusView` accepts only the
  branded `CheckedStatusViewSource` that the check produces.
  `buildStatusViewFor` returns the full view or `buildUnavailableStatusView`,
  catches anything that still throws, and never throws itself.
- `loadStatusDetail` (the TUI data layer, shared by OpenCode 1 and 2) returns
  only checked results. Both dialogs and the OpenCode 2 text fallback
  (`statusTextFor`) draw every result, including RPC failures, instead of a
  toast.
- Version: `status-detail` now reports `pluginVersion` on every reply,
  including `disabled` and error replies (`shared/plugin-package-version.ts`,
  found by walking up to the package manifest). The dialog compares it with
  its own version:
  - older server: "An older Magic Context (0.42.6) server is still running,
    while this UI is 0.44.5: quit all OpenCode processes, then start OpenCode
    again";
  - no version (every server up to 0.44.4): "An older Magic Context server
    (one too old to report its version) is still running …";
  - newer server: "Magic Context server is X, this UI is Y: restart
    OpenCode".
- A migration that continued past an unchecked holder is recorded
  (`getUnconfirmedMigrationHolders`), sent as `unconfirmedMigrationHolders`,
  and shown as an error line in the dialog: "Magic Context upgraded its
  database from v85 to v91 while OpenCode PID 10376 could not be checked. If
  an older OpenCode is still open, quit all OpenCode processes and start
  again."
- Pi's `/ctx-status` overlay runs its in-process snapshot through the same
  check (`checkLocalStatusSource`).

Tests: `status-view-check.test.ts` covers every payload above, including a
reply captured from a real 0.42.6 server. `tui/dialogs/status-dialog-render.test.ts`
renders the shipped compiled dialog for each case in a child process
(`scripts/render-compiled-status-dialog.ts`), which supplies the host runtime
registry from this package's own dependencies. A Bun plugin cannot be
unregistered, so this keeps the registry out of the tests that check it is
absent. It also covers the real `status-detail`
handler (`rpc-handlers.test.ts`) and a malformed Pi snapshot
(`pi-plugin/src/dialogs/status-dialog.test.ts`). Disabling the required-field
check and the `disabled` branch makes 8 of them fail, including the three
compiled-dialog render cases for home, paused and empty.

## Defect 3: the TUI asked the startup directory's server about every session

The reporter restarted with every `opencode.exe` killed, and the sidebar still
showed 0 compartments and 0 memories. The cause: the TUI calls
`initRpcClient(api.state.path.directory)` once at plugin start, and every
session-scoped RPC (sidebar snapshot, status detail, embed detail, compartment
count, recomp) went through that one client. OpenCode starts one Magic Context
server instance per directory. Non-git directories share OpenCode's global
project, so a TUI started in `~` lists sessions from, for example,
`~\Pictures\Camera Roll\VikStudio\TGroup` and opens them. The server for
that session boots for its own directory (log line 122), but the TUI kept
asking the home instance. That instance keeps no project state: the sidebar
read 0/0, and `/ctx-status` got the `{ disabled: true }` home reply.

Fix: the TUI data layer (`tui/data/context-db.ts`) keeps the startup client
for the notification socket and the process-wide calls. Session-scoped calls
go to a client for the session's own directory. `tui/data/session-directory.ts`
picks that directory: `api.state.session.get(id).directory` on OpenCode 1,
`context.data.session.get(id).location.directory` on OpenCode 2. It falls back
to the startup directory while the host has not loaded the session. The
sidebar (both hosts, including the compiled sidebar OpenCode 2 mounts),
`/ctx-status`, `/ctx-embed` and the recomp dialog use it, and they resolve it
again on each refresh or command, so a session switch follows along.

Proof on a real OpenCode 1.18.30 TUI. The throwaway root was
`$TMPDIR/magic-context/issue-584/bind`, with `HOME` pointed into it, the mock
provider, and `lsof` showing every open `.db` under the root. A session was
created in the non-git project `HOME/Pictures/project`, then 2 compartments and
3 memories were seeded for it. The TUI was then started in `HOME` and opened
that session from `/sessions`. The server booted for `HOME`, then for the
project, in the same PID, which matches the reporter's log.

| Build | Sidebar | `/ctx-status` |
| --- | --- | --- |
| v0.44.4 (same store, same session) | Compartments 0, Memories 0 | crash `view().headline` |
| this branch | Compartments 2, Memories 3 | full status for the project, "Compartments (2)" (palette and slash command) |

Tests: `tui/data/context-db.test.ts` › `session calls go to the server of the
session's directory, not the startup one` runs two real RPC servers (home and
project). It goes red when session calls are forced back onto the startup
client. `v2/tui/session-directory.test.ts` covers OpenCode 2's session
directory lookup and its fallbacks.

Still on the startup client: `/ctx-dream`, `/ctx-flush` and `/ctx-wrapup`
send only a session ID, and on both hosts they reach the startup directory's
server.

## Side findings (not changed)

- With no identity at boot (home directory, paused identity), the server hook
  is not created (`hook.ts`: `recordHookInitFailure({ type: "no_project" })`).
  `/ctx-status` typed in the prompt then reaches the model as the plain text
  `ctx-status` instead of opening the dialog, as seen on the real TUI. The
  palette entry "Magic Context: Status" still works.
- A 0.42.6 server whose store was migrated past its fence answers a bare
  `{"error":"unavailable"}`. The dialog then says "server did not answer",
  followed by the MC-S01 text "retry in a moment". Retrying does not help in
  that state. The server predates `pluginVersion`, so the dialog cannot name
  it.
- The status reply cannot say why an identity is paused. The reason is in a
  private map in `project-identity.ts` (`pausedIdentityReasons`); exporting a
  getter would let the dialog name `dubious_ownership` or `git_missing`
  directly.
