import { describe, expect, it, mock } from "bun:test";
import type { LkgSlot } from "./lkg-slot";
import type { MessageLike } from "./transform-operations";

const lines: string[] = [];
mock.module("../../shared/logger", () => ({
    log: () => {},
    sessionLog: (_sessionId: string, message: string) => lines.push(message),
    flushLogger: () => {},
    setLogLineForwarder: () => {},
    writeForwardedLogLine: () => {},
    getLogFilePath: () => "/tmp/magic-context-test.log",
    getLoggerDiagnostics: () => ({
        swallowedWriteCount: 0,
        lastErrorMessage: null,
        lastErrorTime: null,
    }),
}));

const { getSlot, resetLkgSlotsForTest } = await import("./lkg-slot");
const { captureLkgSlot, captureLkgSlotDetailed, lkgDeclinedCaptureBustAction, projectLkgEntry } =
    await import("./lkg-replay");

// Storm chain B (§25.2). Field receipts (coordinator-verified): a fake
// rotation (identical re-rendered bytes, bustedThisPass=true) inside a
// tool-loop marathon drove 140x lkg_slot_dropped reason=lkg_refresh_declined
// + 493x lkg_capture_declined reason=build_no_anchor; the mid-loop anchor
// rule (an active assistant requires a real user strictly after it) makes
// capture structurally impossible exactly when the bust fires, so the one
// event both invalidated the durable row and blocked re-establishment. The
// first LEGITIMATE rotation after restart (reason=max_memory_id, priced
// bust input=46,093/read=69,632) reproduced the same chain — and the next
// boot served lkg=absent.

function user(id: string, created: number, synthetic = false): MessageLike {
    return {
        info: {
            id,
            role: "user",
            sessionID: "s",
            synthetic: synthetic || undefined,
            time: { created },
        } as never,
        parts: [{ type: "text", text: `text:${id}` }],
    };
}

function assistant(id: string, created: number, finish = "stop"): MessageLike {
    return {
        info: { id, role: "assistant", sessionID: "s", time: { created }, finish } as never,
        parts: [{ type: "text", text: `text:${id}` }],
    };
}

function toolMsg(id: string, created: number): MessageLike {
    return {
        info: { id, role: "tool", sessionID: "s", time: { created } } as never,
        parts: [{ type: "tool_result", tool_call_id: `call-${id}` }],
    };
}

function midLoopWire(turns: number) {
    // [m0 head, m1 head, u1, a1(stop), u2 … unturns, activeAssistant,
    //  toolResults] — the shape of a tool-loop marathon: the latest
    // assistant is active and no real user is strictly newer, so
    // findLkgAnchor returns null and any capture is declined build_no_anchor.
    const msgs: MessageLike[] = [
        user("h0", 1, true),
        user("h1", 2, true),
        user("u1", 3),
        assistant("a1", 4),
    ];
    for (let t = 0; t < turns; t += 1) {
        msgs.push(assistant(`act-${t}`, 100 + t, "tool-calls"));
        msgs.push(toolMsg(`tr-${t}`, 200 + t));
    }
    return msgs;
}

function successfulCapture(sessionId: string, wire: MessageLike[]) {
    // A clean-boundary pass (last assistant completed): the row IS
    // establishable — this is the last successful capture the laws protect.
    const upTo = wire.slice(0, 4);
    const ok = captureLkgSlot({
        sessionId,
        input: projectLkgEntry(upTo),
        output: upTo,
        modelKey: "test/model",
        providerKey: "test",
    });
    expect(ok).toBe(true);
    return structuredClone(getSlot(sessionId)) as LkgSlot;
}

describe("LKG storm chain B: declined capture on a no-op bust keeps the durable row", () => {
    it("law (a): N mid-loop no_anchor bust passes leave the row byte-identical to the last capture", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        const sessionId = "storm-keep";
        const wire = midLoopWire(6);
        const captured = successfulCapture(sessionId, wire);
        for (let pass = 1; pass <= 3; pass += 1) {
            const outcome = captureLkgSlotDetailed({
                sessionId,
                input: projectLkgEntry(wire),
                output: wire,
                modelKey: "test/model",
                providerKey: "test",
            });
            // Precondition: mid-loop, the capture is structurally declined.
            expect(outcome.captured).toBe(false);
            if (outcome.captured) throw new Error("unreachable");
            expect(outcome.decline).toEqual({ phase: "build", reason: "no_anchor" });
            // The served prefix has NOT diverged (the head re-rendered to
            // identical bytes — the storm shape): the row corresponds to
            // what this pass serves, so the action keeps it.
            expect(
                lkgDeclinedCaptureBustAction({
                    sessionId,
                    input: projectLkgEntry(wire),
                    output: wire,
                    decline: outcome.decline,
                }),
            ).toBe("keep");
            // Byte-identity of the durable row survives every pass.
            const now = getSlot(sessionId);
            expect(now).toBeDefined();
            expect(now?.jsonPrefix).toBe(captured.jsonPrefix);
            expect(now?.inputIdSeq).toEqual(captured.inputIdSeq);
            expect(now?.inputContentDigests).toEqual(captured.inputContentDigests);
            expect(now?.lastInputMessageId).toBe(captured.lastInputMessageId);
            expect(now?.capturedAt).toBe(captured.capturedAt);
        }
        // Receipt, not silence: the keep is logged per pass.
        expect(lines.filter((l) => l.startsWith("lkg_kept reason=no_reanchor")).length).toBe(3);
        // And the row is NEVER dropped: no destructive receipt at all.
        expect(lines.some((l) => l.startsWith("lkg_slot_dropped"))).toBe(false);
    });

    it("law (b): a real prefix divergence on a declined bust still drops (boot never serves older-than-boundary)", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        const sessionId = "storm-diverge";
        const wire = midLoopWire(4);
        successfulCapture(sessionId, wire);
        // A genuine boundary crossed: the served head changed content
        // (rotation with real new bytes) — the row is now older than the
        // last legitimate boundary and must go.
        const diverged = structuredClone(wire);
        (diverged[0].parts[0] as { text: string }).text = "rotated m[0] content";
        const outcome = captureLkgSlotDetailed({
            sessionId,
            input: projectLkgEntry(diverged),
            output: diverged,
            modelKey: "test/model",
            providerKey: "test",
        });
        expect(outcome.captured).toBe(false);
        if (outcome.captured) throw new Error("unreachable");
        expect(
            lkgDeclinedCaptureBustAction({
                sessionId,
                input: projectLkgEntry(diverged),
                output: diverged,
                decline: outcome.decline,
            }),
        ).toBe("drop");
    });

    it("law (b2): a declined bust with the anchor entry gone drops (identity evidence, not guesswork)", () => {
        resetLkgSlotsForTest();
        const sessionId = "storm-compacted";
        const wire = midLoopWire(2);
        successfulCapture(sessionId, wire);
        // Host compaction removed the anchor entry from the wire: the row
        // can no longer correspond to any served prefix.
        const withoutAnchor = wire.filter((m) => (m.info as { id?: string }).id !== "u1");
        const outcome = captureLkgSlotDetailed({
            sessionId,
            input: projectLkgEntry(withoutAnchor),
            output: withoutAnchor,
            modelKey: "test/model",
            providerKey: "test",
        });
        expect(outcome.captured).toBe(false);
        if (outcome.captured) throw new Error("unreachable");
        expect(
            lkgDeclinedCaptureBustAction({
                sessionId,
                input: projectLkgEntry(withoutAnchor),
                output: withoutAnchor,
                decline: outcome.decline,
            }),
        ).toBe("drop");
    });

    it("store-phase decline with identical served prefix keeps too (the property is divergence, not phase)", () => {
        resetLkgSlotsForTest();
        lines.length = 0;
        const sessionId = "storm-store";
        const wire = midLoopWire(3);
        successfulCapture(sessionId, wire);
        // A store-phase decline (e.g. heap_budget from another session) on
        // a bust pass whose served wire still matches the row: keeping is
        // right for the same reason — the decision compares served bytes,
        // it does not care which fence refused the refresh.
        const kept = lkgDeclinedCaptureBustAction({
            sessionId,
            input: projectLkgEntry(wire),
            output: wire,
            decline: { phase: "store", reason: "heap_budget" },
        });
        expect(kept).toBe("keep");
        expect(
            lines.some((l) => l.startsWith("lkg_kept reason=no_reanchor") && l.includes("store")),
        ).toBe(true);
    });
});
