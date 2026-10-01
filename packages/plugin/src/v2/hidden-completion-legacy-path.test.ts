import { expect, test } from "bun:test";
import type { HiddenRunIdentity } from "../hooks/magic-context/compartment-runner-types";
import { Database } from "../shared/sqlite";
import {
    createV2HiddenCompletionExecutor,
    type HiddenChildHost,
    hiddenChildrenMetaKey,
} from "./hidden-completion";
import { HIDDEN_DREAMER_AGENT, HiddenChildHook } from "./hooks/hidden-child";
import type { SessionContext } from "./hooks/types";
import type { StoreRow } from "./store-reader";

/**
 * Pins, call for call, what an OpenCode 2 host WITHOUT `session.remove` sees from the hidden-run
 * executor: every host call with its arguments, and the bookkeeping row left behind. The expected
 * transcript below was recorded from the executor before hosts with `session.remove` got their own
 * lifecycle, so any change to the old path — an extra call, a reordered call, a new argument such
 * as a parent id, a different bookkeeping shape — fails here. Random prompt markers and wall-clock
 * timestamps are the only values normalised.
 */

const historian: HiddenRunIdentity = {
    parentSessionId: "user-session",
    agent: "historian",
    kind: "historian",
    system: "historian system",
    model: "mock/cheap",
    configuredModels: ["mock/cheap"],
    timeoutMs: 1200,
    title: "ignored",
    directory: "/project",
};

const dreamer: HiddenRunIdentity = {
    ...historian,
    agent: HIDDEN_DREAMER_AGENT,
    kind: "dreamer-task",
    system: "dreamer system",
};

const request = () => ({
    path: { id: "child" },
    body: {
        model: { providerID: "mock", modelID: "cheap" },
        parts: [{ type: "text", text: "chunk", synthetic: true }],
    },
});

const settlement = (promptSettled: boolean) => ({
    promptSettled,
    privacySensitive: false,
    context: "legacy-path",
    log() {},
});

function normalise(value: unknown): unknown {
    return JSON.parse(
        JSON.stringify(value)
            .replace(/mc:hidden:[0-9a-f-]+:[0-9a-f-]+/g, "<marker>")
            .replace(/"(created_at|retired_at)":\d+/g, '"$1":"<time>"'),
    );
}

test("a host without session.remove keeps the recorded hidden-child lifecycle exactly", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE schema_migrations_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const hook = new HiddenChildHook();
    const calls: Array<[string, unknown]> = [];
    const rows = new Map<string, StoreRow<"assistant">[]>();
    const models = new Map<string, { providerID: string; id: string }>();
    let seq = 0;
    let nextID = 0;
    let failNext = false;
    const host: HiddenChildHost = {
        async create(input) {
            calls.push(["create", input]);
            const id = `child-${++nextID}`;
            models.set(id, input.model);
            return { id };
        },
        async get(input) {
            calls.push(["get", input]);
            return { model: { providerID: "mock", id: "user" } };
        },
        async switchModel(input) {
            calls.push(["switchModel", input]);
            models.set(input.sessionID, input.model);
        },
        async prompt(input) {
            calls.push(["prompt", input]);
            const draft: SessionContext = {
                sessionID: input.sessionID,
                model: models.get(input.sessionID) ?? { providerID: "mock", id: "cheap" },
                agent: "historian",
                system: [],
                tools: {},
                options: {},
                messages: [{ role: "user", content: [{ type: "text", text: input.text }] }],
            };
            hook.apply(draft);
            const failed = failNext;
            failNext = false;
            const row: StoreRow<"assistant"> = {
                id: `message-${++seq}`,
                session_id: input.sessionID,
                type: "assistant",
                seq,
                data: failed
                    ? {
                          content: [{ type: "text", text: "" }],
                          finish: "error",
                          error: { message: "provider refused" },
                          model: { providerID: "mock", id: "cheap" },
                          time: { created: Date.now(), completed: Date.now() },
                      }
                    : {
                          content: [{ type: "text", text: `reply ${seq}` }],
                          finish: "stop",
                          model: { providerID: "mock", id: "cheap" },
                          tokens: { input: 10, output: 2 },
                          time: { created: Date.now(), completed: Date.now() },
                      },
            };
            rows.set(input.sessionID, [...(rows.get(input.sessionID) ?? []), row]);
        },
        async wait(input) {
            calls.push(["wait", input]);
        },
        async interrupt(input) {
            calls.push(["interrupt", input]);
            return { interrupted: true };
        },
        async update(input) {
            calls.push(["update", input]);
        },
        async remove(input) {
            calls.push(["remove", input]);
        },
    };
    const executor = await createV2HiddenCompletionExecutor(host, {
        db,
        projectIdentity: "/project",
        directory: "/project",
        hook,
        openReader: () => ({
            latestSequence: (id) => rows.get(id)?.at(-1)?.seq ?? -1,
            latestAssistant: (id) => rows.get(id)?.at(-1),
            latestIdle: () => undefined,
        }),
        generation: "legacy-generation",
        removalSpacingMs: 0,
        resolveOwner: () => ({ registration: "/state/opencode/service.json", pid: 42 }),
        log: () => {},
    });

    const runOnce = async (identity: HiddenRunIdentity) => {
        const handle = await executor.open(identity);
        let settled = false;
        try {
            await executor.attempt(handle, request());
            await executor.collect(handle, 50);
            settled = true;
        } catch {
            // The provider failure below is part of the recorded lifecycle.
        } finally {
            await executor.close(handle, settlement(settled));
        }
    };

    try {
        await runOnce(historian);
        await runOnce(historian);
        failNext = true;
        await runOnce(historian);
        await runOnce(historian);
        await runOnce(dreamer);
        // Removals are queued off the run; give the queue a moment to reach the host.
        await new Promise((resolve) => setTimeout(resolve, 50));
        const meta = db
            .prepare("SELECT value FROM schema_migrations_meta WHERE key = ?")
            .get(hiddenChildrenMetaKey("/project", "/project")) as { value: string };

        // Removal is queued off the run, so where it lands among the other calls is timing; it is
        // compared on its own, in full.
        expect(normalise(calls.filter(([name]) => name !== "remove"))).toEqual(EXPECTED_CALLS);
        expect(normalise(calls.filter(([name]) => name === "remove"))).toEqual(EXPECTED_REMOVALS);
        expect(normalise(JSON.parse(meta.value))).toEqual(EXPECTED_META);
    } finally {
        db.close();
    }
});

const EXPECTED_CALLS: unknown = [
    [
        "create",
        {
            title: "Magic Context historian",
            agent: "historian",
            model: {
                providerID: "mock",
                id: "cheap",
            },
            location: {
                directory: "/project",
            },
            metadata: {
                magic_context: "hidden-run",
                role: "historian",
            },
        },
    ],
    [
        "prompt",
        {
            sessionID: "child-1",
            text: "<marker>",
        },
    ],
    [
        "wait",
        {
            sessionID: "child-1",
        },
    ],
    [
        "update",
        {
            sessionID: "child-1",
            title: "Magic Context historian",
        },
    ],
    [
        "prompt",
        {
            sessionID: "child-1",
            text: "<marker>",
        },
    ],
    [
        "wait",
        {
            sessionID: "child-1",
        },
    ],
    [
        "prompt",
        {
            sessionID: "child-1",
            text: "<marker>",
        },
    ],
    [
        "wait",
        {
            sessionID: "child-1",
        },
    ],
    [
        "interrupt",
        {
            sessionID: "child-1",
        },
    ],
    [
        "create",
        {
            title: "Magic Context historian",
            agent: "historian",
            model: {
                providerID: "mock",
                id: "cheap",
            },
            location: {
                directory: "/project",
            },
            metadata: {
                magic_context: "hidden-run",
                role: "historian",
            },
        },
    ],
    [
        "prompt",
        {
            sessionID: "child-2",
            text: "<marker>",
        },
    ],
    [
        "wait",
        {
            sessionID: "child-2",
        },
    ],
    [
        "update",
        {
            sessionID: "child-2",
            title: "Magic Context historian",
        },
    ],
    [
        "create",
        {
            title: "Magic Context dreamer",
            agent: "dreamer-classifier",
            model: {
                providerID: "mock",
                id: "cheap",
            },
            location: {
                directory: "/project",
            },
            metadata: {
                magic_context: "hidden-run",
                role: "dreamer",
            },
        },
    ],
    [
        "prompt",
        {
            sessionID: "child-3",
            text: "<marker>",
        },
    ],
    [
        "wait",
        {
            sessionID: "child-3",
        },
    ],
    [
        "update",
        {
            sessionID: "child-3",
            title: "Magic Context dreamer",
        },
    ],
];

const EXPECTED_REMOVALS: unknown = [
    [
        "remove",
        {
            sessionID: "child-1",
            owner: {
                registration: "/state/opencode/service.json",
                pid: 42,
            },
            directory: "/project",
        },
    ],
];

const EXPECTED_META: unknown = {
    version: 1,
    active: {
        historian: {
            id: "child-2",
            role: "historian",
            generation: "legacy-generation",
            title: "Magic Context historian",
            model: {
                providerID: "mock",
                modelID: "cheap",
            },
            created_at: "<time>",
            title_reasserted: true,
            directory: "/project",
            owner: {
                registration: "/state/opencode/service.json",
                pid: 42,
            },
            ever_settled: true,
        },
        dreamer: {
            id: "child-3",
            role: "dreamer",
            generation: "legacy-generation",
            title: "Magic Context dreamer",
            model: {
                providerID: "mock",
                modelID: "cheap",
            },
            created_at: "<time>",
            title_reasserted: true,
            directory: "/project",
            owner: {
                registration: "/state/opencode/service.json",
                pid: 42,
            },
            ever_settled: true,
        },
    },
    retired_children: [],
};
