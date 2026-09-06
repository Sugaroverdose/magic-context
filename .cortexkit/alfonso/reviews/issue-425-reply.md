Thanks for the unusually complete diagnosis — both failure layers check out.

The 0.41.3 probe (`packages/pi-plugin/src/pi-harness-kind.ts`) used `createRequire(requester).resolve("@oh-my-pi/pi-utils")` from `process.argv[1]` and `process.execPath`, then read `APP_NAME` from the resolved module. On the bun-global layout the shim directory cannot see `install/global/node_modules`, and even from the real host entry the CJS resolver never matches an `import`-only exports map, so the probe threw and the fallback filed every session as Pi. A regression fixture now mirrors your layout (`bin/omp` symlink into `install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` plus an ESM-only `@oh-my-pi/pi-utils`) and fails on 0.41.3's detector.

The replacement detector is a ladder:

1. The host's own process identity: OMP calls `setProcessName(APP_NAME)` before loading extensions, which sets `process.title` to `omp`. This decides on every OMP 18.x install regardless of layout.
2. The host package name: realpath the host entry, walk up to the nearest `package.json`, and classify `@oh-my-pi/pi-coding-agent` as OMP (Pi's `@earendil-works/pi-coding-agent` and the legacy `@mariozechner/...` name as Pi).
3. An ESM probe: locate `@oh-my-pi/pi-utils` relative to the resolved host entry, take its `import` target, dynamic-`import()` it, and read `APP_NAME`.
4. The launcher basename (`omp`, `oh-my-pi`) through the same executable vocabulary process detection already uses; then default to Pi.

Detection is memoized per process, spawns nothing, and the boot line now records the deciding rung (`harness=omp (via process-title)`), so a future mismatch is diagnosable from the log alone.

The detected value is installed as the shared harness at plugin boot, and everything downstream keys off it: `historian.omp` / `dreamer.omp` model resolution, the per-harness log path (the OMP doctor now reads the OMP path — it was reading Pi's), new `session_meta` rows, and the dashboard's OMP scanner labels. Sessions already stored as `harness='pi'` are not relabeled; they stay visible under the Pi filter as you found.

Ships in v0.41.4.

Addendum after your second and third comments: thank you for tracing both follow-on kill chains. The historian runner now chooses flags, relative settings paths, tool names, and model-reference translation from the resolved child CLI package rather than the host label, so an OMP target gets `--no-rules` and a Pi target gets `--no-prompt-templates --no-context-files` even if detection regresses. Dashboard display lookup now falls back across harnesses only on an exact full session ID, without changing the `(harness, session_id)` key or migrating old rows, so pre-fix OMP sessions recorded as Pi remain visible. We also confirmed the detection ladder contains no CJS resolver probe and extended the bun-global fixture to cover the broker-style real `.../pi-coding-agent/dist/cli.js` argv shape. These follow-ups ship in the next patch after 0.41.4.
