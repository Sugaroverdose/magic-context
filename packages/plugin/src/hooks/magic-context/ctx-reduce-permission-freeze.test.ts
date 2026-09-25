/// <reference types="bun-types" />

/**
 * OpenCode keeps agent and session permissions off the first user message's
 * tools map, so the ctx_reduce verdict has to read them before it freezes.
 * These tests drive the real TypeScript transform and system-prompt handler
 * through three sessions shapes and compare what each serves:
 *   - permissions allow ctx_reduce: bytes match a pass that never reads
 *     permissions (the behavior before permissions were considered);
 *   - permissions deny ctx_reduce from the first pass: no §N§ tags, no reduce
 *     guidance, no Channel 1 baseline on any pass;
 *   - a deny added after the first pass: served bytes stay identical to a
 *     session that was never denied.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scheduler } from "../../features/magic-context/scheduler";
import { closeDatabase, openDatabase } from "../../features/magic-context/storage";
import { createTagger } from "../../features/magic-context/tagger";
import type { ContextUsage } from "../../features/magic-context/types";
import type { PluginContext } from "../../plugin/types";
import { clearCtxReduceAvailability } from "./ctx-reduce-availability";
import type { Channel1State } from "./ctx-reduce-nudge";
import { createSystemPromptHashHandler } from "./system-prompt-hash";
import { createTransform } from "./transform";

type TestMessage = {
    info: { id: string; role: string; sessionID: string; agent?: string };
    parts: Array<{ type: "text"; text: string }>;
};

const HOST_PROMPT = "You are a helpful coding assistant.";
const AGENT = "reviewer";

const tempDirs: string[] = [];
const originalXdgDataHome = process.env.XDG_DATA_HOME;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;

afterEach(() => {
    closeDatabase();
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
});

function useTempDataHome(): void {
    const dir = mkdtempSync(join(tmpdir(), "ctx-reduce-permission-freeze-"));
    tempDirs.push(dir);
    process.env.XDG_DATA_HOME = dir;
    process.env.XDG_CACHE_HOME = dir;
}

/**
 * Fake OpenCode SDK. `permissions: "unreadable"` omits the permission APIs, so
 * the pre-freeze read fails and the session resolves exactly as it did before
 * permissions were read at all.
 */
function hostClient(state: { deny: boolean; permissions?: "unreadable" }) {
    const reads = { agents: 0 };
    const client = {
        ...(state.permissions === "unreadable"
            ? {}
            : {
                  app: {
                      agents: async () => {
                          reads.agents += 1;
                          return {
                              data: [
                                  {
                                      name: AGENT,
                                      permission: state.deny ? { ctx_reduce: "deny" } : {},
                                  },
                              ],
                          };
                      },
                  },
              }),
        session: { get: async () => ({ data: { permission: [] } }) },
    } as unknown as PluginContext["client"];
    return { client, reads };
}

/** A fresh message array per pass, the way OpenCode hands the transform one. */
function conversation(sessionId: string, turns: number): TestMessage[] {
    const messages: TestMessage[] = [];
    for (let turn = 1; turn <= turns; turn += 1) {
        messages.push({
            info: { id: `m-user-${turn}`, role: "user", sessionID: sessionId, agent: AGENT },
            parts: [{ type: "text", text: `Review step ${turn} of the change` }],
        });
        messages.push({
            info: { id: `m-assistant-${turn}`, role: "assistant", sessionID: sessionId },
            parts: [{ type: "text", text: `Reviewed step ${turn}` }],
        });
    }
    return messages;
}

function createHarness(sessionIds: string[], client: (sessionId: string) => unknown) {
    const db = openDatabase();
    const channel1StateBySession = new Map<string, Channel1State>();
    const scheduler: Scheduler = { shouldExecute: mock(() => "defer" as const) };
    const usage = { percentage: 60, inputTokens: 120_000 };
    // One transform per session so each can carry its own fake host client.
    const transforms = new Map(
        sessionIds.map((sessionId) => [
            sessionId,
            createTransform({
                tagger: createTagger(),
                scheduler,
                contextUsageMap: new Map<string, { usage: ContextUsage; updatedAt: number }>([
                    [sessionId, { usage, updatedAt: Date.now() }],
                ]),
                db,
                historyRefreshSessions: new Set<string>(),
                pendingMaterializationSessions: new Set<string>(),
                lastHeuristicsTurnId: new Map<string, string>(),
                clearReasoningAge: 50,
                protectedTokens: 0,
                channel1StateBySession,
                client: client(sessionId) as PluginContext["client"],
            }),
        ]),
    );
    const { handler: systemHandler } = createSystemPromptHashHandler({
        db,
        dreamerEnabled: false,
        resolveModel: () => ({ providerID: "provider", modelID: "model" }),
        historyRefreshSessions: new Set<string>(),
        systemPromptRefreshSessions: new Set<string>(),
        pendingMaterializationSessions: new Set<string>(),
        lastHeuristicsTurnId: new Map<string, string>(),
    });

    /** Run one OpenCode turn (messages transform, then system transform) and return what it serves. */
    async function pass(sessionId: string, turns: number) {
        const messages = conversation(sessionId, turns);
        await transforms.get(sessionId)?.({}, { messages });
        const system = [HOST_PROMPT];
        await systemHandler(
            { sessionID: sessionId, model: { providerID: "provider", modelID: "model" } },
            { system },
        );
        // Session ids differ between compared sessions; everything else must match byte for byte.
        const normalize = (value: string) => value.replaceAll(sessionId, "<session>");
        return {
            messages: normalize(JSON.stringify(messages)),
            system: normalize(system.join("\n")),
        };
    }

    return { pass, channel1StateBySession };
}

const TAG = /§\d+§/;
const REDUCE_GUIDANCE = "`ctx_reduce` with its tag";

describe("ctx_reduce verdict honours agent and session permissions before it freezes", () => {
    it("a session whose permissions allow ctx_reduce serves the same bytes as one that never reads them", async () => {
        useTempDataHome();
        const allowed = "ses-freeze-allowed";
        const unread = "ses-freeze-unread";
        clearCtxReduceAvailability(allowed);
        clearCtxReduceAvailability(unread);
        const allowedHost = hostClient({ deny: false });
        const unreadHost = hostClient({ deny: false, permissions: "unreadable" });
        const { pass, channel1StateBySession } = createHarness([allowed, unread], (sessionId) =>
            sessionId === allowed ? allowedHost.client : unreadHost.client,
        );

        for (let turns = 1; turns <= 3; turns += 1) {
            const allowedServed = await pass(allowed, turns);
            const unreadServed = await pass(unread, turns);
            expect(allowedServed).toEqual(unreadServed);
            expect(allowedServed.messages).toMatch(TAG);
            expect(allowedServed.system).toContain(REDUCE_GUIDANCE);
        }
        expect(allowedHost.reads.agents).toBe(1);
        // The callable session gets the Channel 1 baseline the denied session must not.
        expect(channel1StateBySession.has(allowed)).toBe(true);
        // computedAt is wall-clock time and differs between the two sessions.
        expect({ ...channel1StateBySession.get(allowed), computedAt: 0 }).toEqual({
            ...channel1StateBySession.get(unread),
            computedAt: 0,
        });
    });

    it("a deny known on the first pass never serves tags, reduce guidance, or a Channel 1 baseline", async () => {
        useTempDataHome();
        const denied = "ses-freeze-denied";
        clearCtxReduceAvailability(denied);
        const host = hostClient({ deny: true });
        const { pass, channel1StateBySession } = createHarness([denied], () => host.client);

        for (let turns = 1; turns <= 3; turns += 1) {
            const served = await pass(denied, turns);
            expect(served.messages).not.toMatch(TAG);
            expect(served.system).toContain("## Magic Context");
            expect(served.system).not.toContain(REDUCE_GUIDANCE);
        }
        expect(channel1StateBySession.has(denied)).toBe(false);
        expect(host.reads.agents).toBe(1);
    });

    it("a deny added after the first pass changes nothing that is served", async () => {
        useTempDataHome();
        const steady = "ses-freeze-steady";
        const flipped = "ses-freeze-flipped";
        clearCtxReduceAvailability(steady);
        clearCtxReduceAvailability(flipped);
        const steadyState = { deny: false };
        const flippedState = { deny: false };
        const steadyHost = hostClient(steadyState);
        const flippedHost = hostClient(flippedState);
        const { pass } = createHarness([steady, flipped], (sessionId) =>
            sessionId === steady ? steadyHost.client : flippedHost.client,
        );

        expect(await pass(flipped, 1)).toEqual(await pass(steady, 1));
        flippedState.deny = true;
        for (let turns = 2; turns <= 4; turns += 1) {
            const flippedServed = await pass(flipped, turns);
            expect(flippedServed).toEqual(await pass(steady, turns));
            expect(flippedServed.messages).toMatch(TAG);
            expect(flippedServed.system).toContain(REDUCE_GUIDANCE);
        }
        expect(flippedHost.reads.agents).toBe(1);
    });
});
