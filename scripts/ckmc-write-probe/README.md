# ck-mc write probe

Tools behind `docs/reports/ckmc-write-amplification-design.md`. They measure how many bytes ck-mc writes per transform pass and which table owns each written page. Nothing here opens a live store: the live `context.db`, `store.db` and `opencode.db` are only ever read by `cp -c` (an APFS clone), and every measurement runs against the clones.

Work files go to `$TMPDIR/magic-context/ckmc-writes` unless `CKMC_PROBE_DIR` says otherwise.

## Real module, real daemon

```sh
scripts/ckmc-write-probe/prep.sh golden          # clone the live stores once
scripts/ckmc-write-probe/prep.sh run run1        # a fresh run directory from the clones
cd scripts/ckmc-write-probe
PROBE_RUN=$TMPDIR/magic-context/ckmc-writes/run1 \
PROBE_SESSION=ses_... PROBE_PROJECT_ROOT=/path/to/the/session/project \
PROBE_PIN=1 PROBE_BROCA=1 bun drive.ts
python3 summarize.py $TMPDIR/magic-context/ckmc-writes/run1/passes.jsonl
python3 walcommits.py $TMPDIR/magic-context/ckmc-writes/run1/data/cortexkit/magic-context/store.db
```

`drive.ts` starts a private `ck-subc` and `ck-mc` (copies of the installed binaries, or `CKMC_PROBE_CK_MC` / `CKMC_PROBE_CK_SUBC`), the hermetic historian producer when `PROBE_BROCA=1`, and drives the plugin's real Rust-mode transform with the session's messages since its newest compaction. `PROBE_PLAN` lists the passes: `first`, `defer` (no new message), `newmsg` (one new agent step), `execute` (usage above the threshold), `hard` (model switch, which changes the render identity), `historian` (usage high enough to fire the historian), `wait_historian` (let a historian run publish, then pass).

Per pass it records the module's disk-write counter (`rusage.py`, macOS `proc_pid_rusage`), the WAL frames appended to each store (`walattr.py`), the owning table of every written `store.db` page, the session's row sizes (`rowinfo.py`) and the SHA-256 of the served messages.

- `PROBE_PIN=1` holds a read snapshot on both stores (`pin.py`) so no checkpoint can reset a WAL. Every frame stays attributable, but checkpoint writes are deferred, so `module_bytes_written` then excludes them.
- `PROBE_PIN=0` is the live configuration: `module_bytes_written` includes checkpoints.

Confirm isolation with `lsof -p <pid>` on the probe's `ck-mc` and `ck-subc`: every regular file must be under the run directory.

## SQL-level replay of one commit

`sqlexp.py <golden>/mc/store.db <work dir> <session> [scenario ...]` (the golden clone has its WAL folded in) runs the statements `McStore::commit_transform` issues, with a ck-mc connection's pragmas, on per-scenario clones, for today's layout and for the proposed split layout (including the cost of migrating every session).

## Live evidence without opening the live store

- `sampler.sh [count] [interval]` clones `store.db` periodically and `diffsamples.py` lists the fields each commit changed.
- `reconcile.sh <ck-mc pid> [seconds]` compares the live module's write counter with the commits counted between two clones.
