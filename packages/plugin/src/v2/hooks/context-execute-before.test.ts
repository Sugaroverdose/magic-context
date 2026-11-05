/// <reference types="bun-types" />

/**
 * Unit 5 Closure B (coordinator gate): v2 mints FPE carriers but the execute.before
 * registration wired only the dropped-input guard — a re-emitted carrier executed
 * the token argument verbatim. Wire the released-input resolver into the v2
 * execute.before composition the same way hook.ts composes the v1 hook
 * (fpe-resolve.ts createToolExecuteBeforeHook): guard first on raw args,
 * resolver second.
 *
 * The v1 reference runs the guard BEFORE the resolver (fpe-resolve.ts:195 < 202),
 * justified by the FpeResolveDepsOption comment: the scan must see raw args so a
 * `[dropped §N§]` marker echo refuses and is never fed to the resolver. These
 * laws pin v2 to that same ordering.
 */

import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { join } from "node:path";
import * as configLoader from "../../config";
import { MagicContextConfigSchema } from "../../config/schema/magic-context";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage-db";
import { createDroppedInputGuard } from "../../hooks/magic-context/dropped-input-guard";
import { deriveKey, renderDropToken } from "../../hooks/magic-context/fpe";
import * as fpeResolve from "../../hooks/magic-context/fpe-resolve";
import type { Database } from "../../shared/sqlite";
import { cleanupTestTempDir, createTestTempDir } from "../../shared/test-temp-dir";
import { createV2ToolExecuteBeforeHook, registerContext } from "./context";
import * as storageGate from "./storage-gate";
import type { V2Context } from "./types";

const RELEASED = { command: "pwd", note: "the real released input" };

function freshDb(): { db: Database; dir: string } {
    const { dir } = createTestTempDir("mc-v2-exec-before-");
    const db = openDatabase(join(dir, "context.db"));
    if (!db) throw new Error("throwaway test store unavailable");
    return { db, dir };
}

describe("v2 execute.before FPE resolver wiring (Unit 5 Closure B)", () => {
    const SESSION = "ses_v2_exec_before";
    let lookups: ReturnType<typeof spyOn> | undefined;

    afterEach(() => {
        lookups?.mockRestore();
        lookups = undefined;
    });

    function tokenFor(tagNumber: number): string {
        return renderDropToken(tagNumber, deriveKey(SESSION));
    }

    it("a persisted full-drop carrier re-emitted through the v2 composition resolves to the released input", () => {
        const { db, dir } = freshDb();
        try {
            lookups = spyOn(fpeResolve, "lookupReleasedToolInput").mockReturnValue(RELEASED);
            const handler = createV2ToolExecuteBeforeHook({
                droppedInputGuard: createDroppedInputGuard(),
                db,
            });
            const draft = { sessionID: SESSION, tool: "bash", input: { command: tokenFor(8) } };
            handler(draft);
            // The token argument is replaced in place by the released original.
            expect(draft.input).toEqual(RELEASED);
            expect(lookups).toHaveBeenCalled();
            // It resolved the token the carrier carries (tag 8), for this session.
            expect(lookups?.mock.calls[0]?.[0]).toBe(db);
            expect(lookups?.mock.calls[0]?.[1]).toBe(SESSION);
            expect(lookups?.mock.calls[0]?.[2]).toBe(8);
        } finally {
            closeDatabase(db);
            cleanupTestTempDir(dir);
        }
    });

    it("the guard runs FIRST: a marker echo refuses and the resolver is never consulted", () => {
        const { db, dir } = freshDb();
        try {
            let lookupCalls = 0;
            lookups = spyOn(fpeResolve, "lookupReleasedToolInput").mockImplementation(() => {
                lookupCalls++;
                return RELEASED;
            });
            const handler = createV2ToolExecuteBeforeHook({
                droppedInputGuard: createDroppedInputGuard(),
                db,
            });
            const draft = { sessionID: SESSION, tool: "bash", input: { command: "[dropped §7§]" } };
            let threw = false;
            try {
                handler(draft);
            } catch {
                threw = true;
            }
            expect(threw).toBe(true);
            // Guard-before-resolver: the raw `[dropped §N§]` echo never reaches it.
            expect(lookupCalls).toBe(0);
        } finally {
            closeDatabase(db);
            cleanupTestTempDir(dir);
        }
    });

    it("an ordinary call passes both stages untouched", () => {
        const { db, dir } = freshDb();
        try {
            lookups = spyOn(fpeResolve, "lookupReleasedToolInput").mockReturnValue(RELEASED);
            const handler = createV2ToolExecuteBeforeHook({
                droppedInputGuard: createDroppedInputGuard(),
                db,
            });
            const draft = { sessionID: SESSION, tool: "bash", input: { command: "ls" } };
            handler(draft);
            expect(draft.input).toEqual({ command: "ls" });
            // No token → the resolver's lookup is never invoked.
            expect(lookups).not.toHaveBeenCalled();
        } finally {
            closeDatabase(db);
            cleanupTestTempDir(dir);
        }
    });

    it("a resolver fault never blocks the tool call (resolver, not gate)", () => {
        const { db, dir } = freshDb();
        try {
            lookups = spyOn(fpeResolve, "lookupReleasedToolInput").mockImplementation(() => {
                throw new Error("host db exploded");
            });
            const handler = createV2ToolExecuteBeforeHook({
                droppedInputGuard: createDroppedInputGuard(),
                db,
            });
            const token = tokenFor(8);
            const draft = { sessionID: SESSION, tool: "bash", input: { command: token } };
            // The thrown lookup must be swallowed; the call passes through.
            expect(() => handler(draft)).not.toThrow();
            // And it was not mutated (the resolver bailed).
            expect(draft.input).toEqual({ command: token });
        } finally {
            closeDatabase(db);
            cleanupTestTempDir(dir);
        }
    });

    it("registerContext wires the resolver into the real execute.before handler (anti-vacuity, #2718)", async () => {
        const { db, dir } = freshDb();
        try {
            const config = MagicContextConfigSchema.parse({
                compaction: { enabled: false },
                historian: { disable: true },
                dreamer: { disable: true },
                memory: { enabled: false },
            });
            const load = spyOn(configLoader, "loadPluginConfigDetailed").mockReturnValue({
                config,
            } as ReturnType<typeof configLoader.loadPluginConfigDetailed>);
            const probe = spyOn(storageGate, "probeV2StorageAtBoot").mockResolvedValue(db);
            let execBefore: ((draft: Record<string, unknown>) => unknown) | undefined;
            const host = {
                location: { directory: dir },
                agent: { transform: async () => {}, reload: async () => {} },
                model: { list: () => [] },
                storage: { get: async () => undefined, set: async () => {} },
                event: { subscribe: async function* () {} },
                tool: {
                    hook: async (
                        name: string,
                        callback: (d: Record<string, unknown>) => unknown,
                    ) => {
                        if (name === "execute.before") execBefore = callback;
                    },
                },
                session: {
                    remove: async () => {},
                    compact: async () => {},
                    interrupt: mock(async () => ({ interrupted: true })),
                    hook: async () => {},
                    get: async () => ({ location: { directory: dir } }),
                },
            } as unknown as V2Context;
            await registerContext(host);
            expect(execBefore, "registerContext registered execute.before").toBeDefined();

            // The REAL captured handler must invoke the resolver on a carrier.
            // Without the wiring (guard-only) the handler never calls
            // lookupReleasedToolInput and this call leaves draft.input verbatim.
            lookups = spyOn(fpeResolve, "lookupReleasedToolInput").mockReturnValue(RELEASED);
            const draft: Record<string, unknown> = {
                sessionID: SESSION,
                tool: "bash",
                input: { command: tokenFor(8) },
            };
            await execBefore?.(draft);
            expect(lookups, "the real v2 execute.before consulted the resolver").toHaveBeenCalled();
            expect(draft.input).toEqual(RELEASED);
            load.mockRestore();
            probe.mockRestore();
        } finally {
            closeDatabase(db);
            cleanupTestTempDir(dir);
        }
    });
});
