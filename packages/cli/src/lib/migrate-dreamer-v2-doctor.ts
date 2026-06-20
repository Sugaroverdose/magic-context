/**
 * On-disk Dreamer v2 migration for doctor (mirrors the plugin's in-memory
 * migrateDreamerV2). Converts the legacy v1 dreamer shape (window schedule, tasks
 * ARRAY, user_memories/pin_key_files blocks, task_timeout_minutes,
 * max_runtime_minutes) into the v2 per-task `tasks` RECORD.
 *
 * Operates in place on a comment-json-parsed config object. Returns true when it
 * mutated `mcConfig.dreamer`. Idempotent: a no-op when `tasks` is already an
 * object (v2) or when no legacy keys are present.
 *
 * Run AFTER the experimental→dreamer migration so a relocated
 * dreamer.user_memories / dreamer.pin_key_files is folded into the tasks record.
 */

const OLD_MEMORY_TASKS = ["consolidate", "verify", "archive-stale", "improve"] as const;
const CANONICAL = [
    "maintain-memory",
    "maintain-docs",
    "key-files",
    "evaluate-smart-notes",
    "review-user-memories",
] as const;
const DEFAULT_BASE_CRON = "0 2 * * *";

function windowToCron(schedule: unknown): string {
    if (typeof schedule !== "string") return DEFAULT_BASE_CRON;
    const m = /^(\d{1,2}):(\d{2})\s*-/.exec(schedule.trim());
    if (!m) return DEFAULT_BASE_CRON;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    if (hour >= 24 || minute >= 60) return DEFAULT_BASE_CRON;
    return `${minute} ${hour} * * *`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function cronIntervalScore(schedule: string): number {
    const parts = schedule.trim().split(/\s+/);
    if (parts.length !== 5) return Number.POSITIVE_INFINITY;
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    if (month !== "*") return 366 * 24 * 60;
    if (dayOfMonth !== "*") return 31 * 24 * 60;
    if (dayOfWeek !== "*") return 7 * 24 * 60;
    const everyHour = /^\*\/(\d+)$/.exec(hour ?? "");
    if (everyHour) return Math.max(1, Number(everyHour[1])) * 60;
    if (hour === "*") {
        const everyMinute = /^\*\/(\d+)$/.exec(minute ?? "");
        return everyMinute ? Math.max(1, Number(everyMinute[1])) : 60;
    }
    return 24 * 60;
}

function mostFrequentSchedule(schedules: string[]): string {
    const enabled = schedules.map((s) => s.trim()).filter(Boolean);
    if (enabled.length === 0) return "";
    return enabled.sort((a, b) => cronIntervalScore(a) - cronIntervalScore(b))[0] ?? "";
}

export function migrateDreamerV2ForDoctor(mcConfig: Record<string, unknown>): boolean {
    const dreamer = asObject(mcConfig.dreamer);
    if (!dreamer) return false;

    const tasksObject = asObject(dreamer.tasks);
    const hasOldObjectTasks = tasksObject
        ? OLD_MEMORY_TASKS.some((task) => task in tasksObject)
        : false;

    if (tasksObject && !hasOldObjectTasks) {
        const hasLegacyOutsideTasks =
            "schedule" in dreamer ||
            "user_memories" in dreamer ||
            "pin_key_files" in dreamer ||
            "task_timeout_minutes" in dreamer ||
            "max_runtime_minutes" in dreamer;
        if (!hasLegacyOutsideTasks) return false;
    }

    const hasLegacy =
        "schedule" in dreamer ||
        Array.isArray(dreamer.tasks) ||
        hasOldObjectTasks ||
        "user_memories" in dreamer ||
        "pin_key_files" in dreamer ||
        "task_timeout_minutes" in dreamer ||
        "max_runtime_minutes" in dreamer;
    if (!hasLegacy) return false;

    const baseCron = windowToCron(dreamer.schedule);
    const timeout =
        typeof dreamer.task_timeout_minutes === "number" ? dreamer.task_timeout_minutes : undefined;
    const withTimeout = (entry: Record<string, unknown>): Record<string, unknown> =>
        timeout !== undefined ? { ...entry, timeout_minutes: timeout } : entry;

    const tasks: Record<string, Record<string, unknown>> = {};

    if (tasksObject) {
        for (const [key, value] of Object.entries(tasksObject)) {
            if ((OLD_MEMORY_TASKS as readonly string[]).includes(key)) continue;
            if (asObject(value)) tasks[key] = { ...(value as Record<string, unknown>) };
        }
        if (hasOldObjectTasks) {
            const oldEntries = OLD_MEMORY_TASKS.map((task) => asObject(tasksObject[task])).filter(
                (entry): entry is Record<string, unknown> => Boolean(entry),
            );
            const oldSchedules = oldEntries.map((entry) =>
                typeof entry.schedule === "string" ? entry.schedule : baseCron,
            );
            tasks["maintain-memory"] = withTimeout({
                ...(tasks["maintain-memory"] ?? {}),
                schedule: mostFrequentSchedule(oldSchedules),
                broad_interval_days: 7,
            });
        }
        for (const task of CANONICAL) {
            if (!tasks[task]) {
                const schedule =
                    task === "maintain-memory"
                        ? baseCron
                        : task === "maintain-docs" || task === "key-files"
                          ? ""
                          : baseCron;
                tasks[task] = withTimeout({ schedule });
            }
        }
    } else {
        const legacyArray = Array.isArray(dreamer.tasks)
            ? (dreamer.tasks as unknown[]).filter((t): t is string => typeof t === "string")
            : null;
        const memorySelected = legacyArray
            ? legacyArray.some((task) => (OLD_MEMORY_TASKS as readonly string[]).includes(task))
            : true;
        tasks["maintain-memory"] = withTimeout({
            schedule: memorySelected ? baseCron : "",
            broad_interval_days: 7,
        });
        tasks["maintain-docs"] = withTimeout({
            schedule: legacyArray?.includes("maintain-docs") ? baseCron : "",
        });
    }

    tasks["evaluate-smart-notes"] ??= withTimeout({ schedule: baseCron });

    const um = asObject(dreamer.user_memories);
    const umEnabled = um ? um.enabled !== false : true;
    if (um || !tasks["review-user-memories"]) {
        tasks["review-user-memories"] = withTimeout({
            ...(tasks["review-user-memories"] ?? {}),
            schedule: umEnabled ? baseCron : "",
            ...(um && typeof um.promotion_threshold === "number"
                ? { promotion_threshold: um.promotion_threshold }
                : {}),
        });
    }

    const pkf = asObject(dreamer.pin_key_files);
    const pkfEnabled = pkf ? pkf.enabled === true : false;
    if (pkf || !tasks["key-files"]) {
        tasks["key-files"] = withTimeout({
            ...(tasks["key-files"] ?? {}),
            schedule: pkfEnabled ? baseCron : "",
            ...(pkf && typeof pkf.token_budget === "number"
                ? { token_budget: pkf.token_budget }
                : {}),
            ...(pkf && typeof pkf.min_reads === "number" ? { min_reads: pkf.min_reads } : {}),
        });
    }

    // Mutate in place: drop retired keys, keep agent-config keys, add tasks.
    delete dreamer.schedule;
    delete dreamer.task_timeout_minutes;
    delete dreamer.max_runtime_minutes;
    delete dreamer.user_memories;
    delete dreamer.pin_key_files;
    dreamer.tasks = tasks;
    mcConfig.dreamer = dreamer;
    return true;
}
