Thanks for the precise report. Your 0.41.2 source cites were exact: the runtime row still starts from `cacheTtl: "5m"`, is inserted with `INSERT OR IGNORE`, and maps an empty database value back to `"5m"` (`packages/plugin/src/features/magic-context/storage-meta-shared.ts:307-316`, `:365-389`, `:408-416`). The config loader also did reduce a whole-file `comment-json` exception to `{}` plus a warning that Pi only logged.

This is fixed for 0.41.3 without disabling the plugin:

- OpenCode and Pi now use the existing `jsonc-parser` dependency in recovery mode. Your exact `\\{` first-line case recovers the remaining object, so the valid settings are applied, but recovery is still classified as a file parse failure rather than a clean load (`packages/plugin/src/config/index.ts:153-205`).
- Parse failures carry the file path, line, column, parser message, and recovered/default disposition. They are a different warning class from invalid leaf values.
- The existing prototype-pollution boundary remains in place. Recovered objects are normalized and `__proto__`, `constructor`, and `prototype` keys are rejected before merge (`packages/plugin/src/shared/jsonc-parser.ts:125-157`, `:160-205`).
- OpenCode routes the failure through the `## ⚠️ Magic Context Config Warning` banner at top severity and claims each parse notice once per process (`packages/plugin/src/index.ts:145-201`). Pi emits an error-level session-start UI notification through `ctx.ui.notify`, also once per process (`packages/pi-plugin/src/index.ts:1337-1362`).
- `/ctx-status`, the OpenCode status dialog, and the Pi status dialog put `Config: PARSE FAILED (<path>:<line>:<column>)` first. The dashboard config editor switches to Raw JSONC and shows the same failure instead of rendering an apparently configured defaults form.

On the doctor PASS discrepancy: 0.41.2's Pi doctor and Pi runtime both used `comment-json`; there was not a second parser that accepted the leading backslash. The diagnostic shown in the report was captured on 2026-09-08, after the 2026-09-02 incident/file repair, so it could legitimately PASS then. In 0.41.3 doctor calls the same recovering parser as the runtime and treats any recovery diagnostic as invalid, so a recovered `\\{` file is a FAIL, not a PASS (`packages/cli/src/commands/doctor-pi.ts:264-297`).

The side finding is fixed too: `doctor --issue --harness pi --report <path>` writes the sanitized bundle directly without opening the interactive title/description flow (`packages/cli/src/commands/doctor-pi.ts:1049-1073`).
