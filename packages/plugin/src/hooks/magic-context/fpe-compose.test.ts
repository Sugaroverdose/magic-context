/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { createDroppedInputGuard } from "./dropped-input-guard";
import { deriveKey, renderDropToken } from "./fpe";
import { createToolExecuteBeforeHook } from "./fpe-resolve";

// Unit 5 production composition (coordinator dispatch ruling 1: integration
// points are mapped from the v2 tree, not lineage placement). The lineage
// dropped the guard from this hook because its drop paths stopped minting the
// marker bytes the guard matches. v2 is different: the message-drop filler is
// the canonical `[dropped §N§]` (ARCHITECTURE invariant 2 — still minted by
// buildReplacementContent), so the guard stays wired, and it must run on the
// RAW args BEFORE resolution: a marker echo from the model refuses, and only
// guard-accepted calls reach the resolver.

describe("tool.execute.before production composition (Unit 5)", () => {
    const SESSION = "ses_fpe_compose";
    const KEY = deriveKey(SESSION);

    function makeHook(overrides?: {
        lookupOriginal?: (sessionId: string, tagNumber: number) => unknown;
    }) {
        return createToolExecuteBeforeHook({
            fpeResolve: {
                lookupOriginal:
                    overrides?.lookupOriginal ??
                    ((_sessionId: string, tagNumber: number) =>
                        tagNumber === 8 ? { command: "pwd" } : undefined),
            },
            droppedInputGuard: createDroppedInputGuard(),
        });
    }

    it("a marker echo in the args refuses, and the resolver is never consulted", async () => {
        let lookupCalls = 0;
        const hook = makeHook({
            lookupOriginal: () => {
                lookupCalls++;
                return { command: "pwd" };
            },
        });
        let threw = false;
        try {
            await hook(
                { tool: "bash", sessionID: SESSION },
                { args: { command: "[dropped §7§]" } },
            );
        } catch {
            threw = true;
        }
        expect(threw).toBe(true);
        expect(lookupCalls).toBe(0);
    });

    it("a real token the guard accepts resolves to the original (post-guard)", async () => {
        const hook = makeHook();
        const token = renderDropToken(8, KEY);
        const executorArgs: Record<string, unknown> = { command: token };
        await hook({ tool: "bash", sessionID: SESSION }, { args: executorArgs });
        expect(executorArgs).toEqual({ command: "pwd" });
    });

    it("an ordinary call passes both stages untouched", async () => {
        const hook = makeHook();
        const executorArgs: Record<string, unknown> = { command: "ls" };
        await hook({ tool: "bash", sessionID: SESSION }, { args: executorArgs });
        expect(executorArgs).toEqual({ command: "ls" });
    });
});
