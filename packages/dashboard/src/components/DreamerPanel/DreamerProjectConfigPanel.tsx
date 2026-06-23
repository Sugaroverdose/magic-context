import { invoke } from "@tauri-apps/api/core";
import { createMemo, createResource, createSignal, Show } from "solid-js";
import { saveProjectConfig } from "../../lib/api";
import {
  jsoncErrorMessage,
  parseJsonc,
  patchDreamerTasksJsonc,
  removeDreamerBlockJsonc,
} from "../../lib/jsonc";
import type { ConfigFile, DreamerProject } from "../../lib/types";
import DreamerTasksField, { type DreamTaskConfig } from "../ConfigEditor/DreamerTasksField";

/**
 * Per-project dreamer config editor (the project-card gear).
 *
 * Option A storage: the project's own `magic-context.jsonc` file. We read the
 * file (or start empty), edit ONLY its `dreamer.tasks`, and write the whole file
 * back via save_project_config — preserving every other key. A project with a
 * `dreamer` block overrides the global config (the plugin deep-merges
 * project-over-user); removing the block reverts it to inheriting global.
 */
export default function DreamerProjectConfigPanel(props: {
  project: DreamerProject;
  models: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const worktree = () => props.project.worktree ?? "";

  const [configFile] = createResource(
    () => worktree(),
    async (wt): Promise<ConfigFile> => invoke("get_config", { source: "project", projectPath: wt }),
  );

  // The full parsed config object (so we preserve unrelated keys on save), and
  // the editable dreamer.tasks slice. Malformed JSONC is surfaced and saves are
  // refused; never substitute an empty object for a parse failure.
  const parsedConfig = createMemo(() => {
    try {
      return { value: parseJsonc(configFile()?.content ?? ""), error: null as string | null };
    } catch (error) {
      return { value: {} as Record<string, unknown>, error: jsoncErrorMessage(error) };
    }
  });
  const parsed = () => parsedConfig().value;
  const parseError = () => parsedConfig().error;
  const dreamerObj = (): Record<string, unknown> => {
    const d = parsed().dreamer;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  };

  // Local working copy of tasks (seeded from file; edits accumulate here).
  const [tasks, setTasks] = createSignal<Record<string, DreamTaskConfig> | undefined>(undefined);
  const effectiveTasks = (): Record<string, DreamTaskConfig> | undefined => {
    const local = tasks();
    if (local) return local;
    const stored = dreamerObj().tasks;
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? (stored as Record<string, DreamTaskConfig>)
      : undefined;
  };

  const [saveStatus, setSaveStatus] = createSignal<string | null>(null);
  const [dirty, setDirty] = createSignal(false);

  const handleSave = async () => {
    const wt = worktree();
    if (!wt) return;
    try {
      const nextConfig = patchDreamerTasksJsonc(
        configFile()?.content ?? "",
        effectiveTasks() ?? {},
      );
      await saveProjectConfig(wt, nextConfig);
      setSaveStatus("✓ Saved — applies on the next dreamer tick");
      setDirty(false);
      props.onSaved();
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`✕ ${jsoncErrorMessage(err)}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const revertToInherited = async () => {
    const wt = worktree();
    if (!wt) return;
    try {
      // Drop the dreamer block entirely → project inherits the global config.
      await saveProjectConfig(wt, removeDreamerBlockJsonc(configFile()?.content ?? ""));
      setSaveStatus("✓ Reverted to inherited global config");
      setTasks(undefined);
      setDirty(false);
      props.onSaved();
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`✕ ${jsoncErrorMessage(err)}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  return (
    <div class="modal-overlay">
      <button type="button" class="modal-backdrop" aria-label="Close" onClick={props.onClose} />
      <div class="modal-card dreamer-config-modal">
        <div class="modal-header">
          <div class="modal-header-text">
            <div class="modal-title">{props.project.label}</div>
            <div class="card-meta mono">{props.project.config_path ?? worktree()}</div>
          </div>
          <button type="button" class="btn sm" onClick={props.onClose}>
            Close
          </button>
        </div>

        <div class="modal-body">
          <Show when={!props.project.worktree}>
            <div class="empty-state" style={{ padding: "16px 0" }}>
              No resolvable directory for this project — per-project config can't be written. It
              inherits the global dreamer config.
            </div>
          </Show>

          <Show when={props.project.worktree}>
            <Show when={!configFile.loading} fallback={<div class="empty-state">Loading…</div>}>
              <p class="config-field-desc" style={{ "margin-bottom": "12px" }}>
                These settings override the global dreamer config for this project only, and are
                saved to the project's <code>magic-context.jsonc</code> (version-controllable — they
                travel to teammates' clones).
              </p>
              <Show when={parseError()}>
                {(message) => (
                  <p
                    class="config-field-desc"
                    style={{ color: "var(--danger, #e5484d)", "margin-bottom": "12px" }}
                  >
                    Project config JSONC is invalid: {message()}
                  </p>
                )}
              </Show>
              <DreamerTasksField
                value={effectiveTasks()}
                models={props.models}
                onChange={(next) => {
                  setTasks(next);
                  setDirty(true);
                }}
              />
            </Show>
          </Show>
        </div>

        <Show when={props.project.worktree && !configFile.loading}>
          <div class="modal-footer dreamer-config-actions">
            <button type="button" class="btn primary sm" disabled={!dirty()} onClick={handleSave}>
              Save
            </button>
            <Show when={props.project.has_project_config}>
              <button type="button" class="btn sm" onClick={revertToInherited}>
                Revert to inherited
              </button>
            </Show>
            <Show when={saveStatus()}>
              <span class="dreamer-config-status">{saveStatus()}</span>
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}
