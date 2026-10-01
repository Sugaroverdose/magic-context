/// <reference types="bun-types" />

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DreamerConfigSchema } from "../../config/schema/magic-context";
import {
    deleteTaskScheduleRowsForProject,
    writeTaskScheduleState,
} from "../../features/magic-context/dreamer/storage-task-schedule";
import { insertMemory } from "../../features/magic-context/memory/storage-memory";
import { openDatabase } from "../../features/magic-context/storage";
import { startDreamTrigger } from "./dream-trigger";

/** A context whose event stream delivers one finished session execution. */
function contextWithOneExecution(directory: string) {
    return {
        location: { directory },
        event: {
            subscribe: ({ signal }: { signal: AbortSignal }) =>
                (async function* () {
                    yield { type: "session.execution.succeeded", data: { sessionID: "ses-v2" } };
                    await new Promise<void>((resolve) =>
                        signal.addEventListener("abort", () => resolve(), { once: true }),
                    );
                })(),
        },
    } as never;
}

// Every production call into the scheduled pass must say whether the project's
// memory is on; a call that leaves it out schedules a memory-disabled project.
test("every scheduled-pass caller forwards the project's memory switch", () => {
    const src = join(import.meta.dir, "../..");
    const callers: Array<[string, string]> = [
        ["plugin/dream-timer.ts", "projectMemoryEnabled: reg.memoryEnabled !== false"],
        [
            "hooks/magic-context/hook.ts",
            "projectMemoryEnabled: deps.config.memory?.enabled !== false",
        ],
        ["v2/hooks/dream-trigger.ts", "projectMemoryEnabled: args.projectMemoryEnabled"],
        ["v2/hooks/context.ts", "projectMemoryEnabled: config.memory.enabled"],
    ];
    for (const [file, forwarded] of callers) {
        expect(readFileSync(join(src, file), "utf8")).toContain(forwarded);
    }
});

// OpenCode 2 reaches the scheduler through this trigger rather than the dream
// timer, so the project's memory switch must be forwarded here as well.
for (const projectMemoryEnabled of [false, true]) {
    test(`OpenCode 2 ${projectMemoryEnabled ? "keeps" : "removes"} the schedule of a project with memory ${projectMemoryEnabled ? "enabled" : "disabled"}`, async () => {
        const db = openDatabase();
        if (!db) throw new Error("test database unavailable");
        const projectIdentity = `git:v2-trigger-memory-${projectMemoryEnabled ? "on" : "off"}`;
        insertMemory(db, { projectPath: projectIdentity, category: "PROJECT_RULES", content: "r" });
        writeTaskScheduleState(db, {
            projectPath: projectIdentity,
            task: "verify",
            lastRunAt: null,
            // Not due, so the enabled case finishes without running a task.
            nextDueAt: Date.now() + 60 * 60_000,
            schedule: "0 3 * * *",
            lastStatus: null,
            lastError: null,
            retryCount: 0,
        });
        const readRows = () =>
            db
                .prepare("SELECT task FROM task_schedule_state WHERE project_path = ?")
                .all(projectIdentity) as Array<{ task: string }>;
        // With memory on, the pass is observable as the single-shot memory
        // tasks (classify-memories) being seeded next to the verify row.
        const passFinished = () =>
            projectMemoryEnabled
                ? readRows().some((row) => row.task === "classify-memories")
                : readRows().length === 0;

        const trigger = startDreamTrigger(contextWithOneExecution("/tmp/v2-project"), {
            config: DreamerConfigSchema.parse({}),
            executor: { capabilities: { tools: false } } as never,
            projectIdentity: () => projectIdentity,
            projectMemoryEnabled,
        });
        try {
            for (let attempt = 0; attempt < 400 && !passFinished(); attempt += 1) {
                await Bun.sleep(5);
            }
            if (projectMemoryEnabled) {
                expect(readRows().map((row) => row.task)).toContain("verify");
                expect(readRows().map((row) => row.task)).toContain("classify-memories");
            } else {
                expect(readRows()).toEqual([]);
            }
        } finally {
            await trigger.dispose();
            deleteTaskScheduleRowsForProject(db, projectIdentity);
        }
    });
}
