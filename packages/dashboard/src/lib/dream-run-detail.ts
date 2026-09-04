import type { DreamRunFailureDetail, DreamRunTask } from "./types";

export type DreamRunTaskDetailTone = "error" | "neutral";

export interface DreamRunTaskDetail {
  text: string | undefined;
  tone: DreamRunTaskDetailTone;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === "" ? undefined : value;
}

export function formatDreamRunFailureDetail(failure: DreamRunFailureDetail): string {
  const parts: string[] = [failure.failure_class];
  if (failure.model_attempted) parts.push(`model: ${failure.model_attempted}`);
  if (failure.provider_error) {
    parts.push(failure.provider_error.split(/\r?\n/, 1)[0]?.trim() ?? "");
  } else if (failure.timeout_ms !== null) {
    parts.push(`timeout: ${failure.timeout_ms}ms`);
  }
  return parts.filter(Boolean).join(" · ");
}

/**
 * Select the detail shown for a task while keeping legacy successful rows safe.
 * Old rows stored successful verify-broad progress in `error`; a run with no
 * failed tasks therefore renders that legacy value neutrally.
 */
export function getDreamRunTaskDetail(task: DreamRunTask, tasksFailed: number): DreamRunTaskDetail {
  const error = nonEmpty(task.error);
  if (tasksFailed > 0 && task.failure) {
    return { text: formatDreamRunFailureDetail(task.failure), tone: "error" };
  }
  if (tasksFailed > 0 && error !== undefined) {
    return { text: error, tone: "error" };
  }
  return {
    text: nonEmpty(task.progress) ?? error,
    tone: "neutral",
  };
}
