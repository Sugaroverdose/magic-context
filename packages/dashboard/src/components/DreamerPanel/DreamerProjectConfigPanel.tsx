import { invoke } from "@tauri-apps/api/core";
import { createResource, createSignal, Show } from "solid-js";
import { saveProjectConfig } from "../../lib/api";
import { formatJsonc, parseJsonc } from "../../lib/jsonc";
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
  // the editable dreamer.tasks slice.
  const parsed = () => parseJsonc(configFile()?.content ?? "");
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
    // Merge edited tasks into the existing dreamer block, preserving other keys
    // (model, fallback_models, inject_docs, …) and the rest of the config.
    const nextDreamer = { ...dreamerObj(), tasks: effectiveTasks() ?? {} };
    const nextConfig = { ...parsed(), dreamer: nextDreamer };
    try {
      await saveProjectConfig(wt, formatJsonc(nextConfig));
      setSaveStatus("✓ Saved — applies on the next dreamer tick");
      setDirty(false);
      props.onSaved();
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`✕ ${err}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  const revertToInherited = async () => {
    const wt = worktree();
    if (!wt) return;
    // Drop the dreamer block entirely → project inherits the global config.
    const next = { ...parsed() };
    delete next.dreamer;
    try {
      await saveProjectConfig(wt, formatJsonc(next));
      setSaveStatus("✓ Reverted to inherited global config");
      setTasks(undefined);
      setDirty(false);
      props.onSaved();
      setTimeout(() => setSaveStatus(null), 4000);
    } catch (err) {
      setSaveStatus(`✕ ${err}`);
      setTimeout(() => setSaveStatus(null), 5000);
    }
  };

  return (
    <div class="slide-panel-overlay">
      <button
        type="button"
        class="slide-panel-backdrop"
        aria-label="Close"
        onClick={props.onClose}
      />
      <div class="slide-panel dreamer-config-panel">
        <div class="slide-panel-header">
          <div>
            <div class="slide-panel-title">{props.project.label}</div>
            <div class="card-meta mono">{props.project.config_path ?? worktree()}</div>
          </div>
          <button type="button" class="btn sm" onClick={props.onClose}>
            Close
          </button>
        </div>

        <Show when={!props.project.worktree}>
          <div class="empty-state" style={{ padding: "16px 0" }}>
            No resolvable directory for this project — per-project config can't be written. It
            inherits the global dreamer config.
          </div>
        </Show>

        <Show when={props.project.worktree}>
          <Show when={!configFile.loading} fallback={<div class="empty-state">Loading…</div>}>
            <p class="config-field-desc" style={{ "margin-bottom": "12px" }}>
              These settings override the global dreamer config for this project only, and are saved
              to the project's <code>magic-context.jsonc</code> (version-controllable — they travel
              to teammates' clones).
            </p>
            <DreamerTasksField
              value={effectiveTasks()}
              models={props.models}
              onChange={(next) => {
                setTasks(next);
                setDirty(true);
              }}
            />
            <div class="dreamer-config-actions">
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
        </Show>
      </div>
    </div>
  );
}
