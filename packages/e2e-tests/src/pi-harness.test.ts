import { describe, expect, it } from "bun:test";
import { PiTestHarness } from "./pi-harness";
import { PiRpcProtocol } from "./pi-runner/rpc-client";

describe("Pi prompt completion", () => {
  it("waits for the submitted user turn and its ceiling-nudge continuation to settle", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    let settled = false;
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string) => {
        if (method === "get_state") {
          if (!settled) throw new Error("queried state before submitted turn settled");
          return { success: true, data: { sessionId: "s1", isStreaming: false } };
        }
        setTimeout(() => {
          emit({ type: "agent_start" });
          emit({ type: "agent_end", messages: [{ role: "custom", content: "previous nudge" }] });
          emit({ type: "agent_settled" });
          emit({ type: "agent_start" });
          emit({ type: "agent_end", messages: [{ role: "user", content: [{ type: "text", text: "submitted" }] }, { role: "assistant", stopReason: "stop" }] });
          emit({ type: "agent_start" });
          setTimeout(() => {
            emit({ type: "agent_end", messages: [{ role: "custom", customType: "magic-context:ceiling-nudge" }, { role: "assistant", stopReason: "stop" }] });
            settled = true;
            emit({ type: "agent_settled" });
          }, 20);
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      rpc, expectMagicContext: false, turns: [],
    });
    const result = await h.sendPrompt("submitted", { timeoutMs: 200 });
    expect(result.sessionId).toBe("s1");
    expect(result.events.at(-1)?.type).toBe("agent_settled");
    expect(result.events.some((event) => JSON.stringify(event).includes("magic-context:ceiling-nudge"))).toBe(true);
  });

  it("waits for OMP's terminal agent_end after a ceiling-nudge continuation", async () => {
    const protocol = new PiRpcProtocol();
    const emit = (event: Record<string, unknown>) => protocol.dispatchLine(JSON.stringify(event));
    let terminal = false;
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async (method: string) => {
        if (method === "get_state") {
          if (!terminal) throw new Error("queried state before terminal OMP agent_end");
          return { success: true, data: { sessionId: "s1", isStreaming: false } };
        }
        setTimeout(() => {
          emit({ type: "agent_start" });
          emit({
            type: "agent_end",
            isTerminal: false,
            messages: [
              { role: "user", content: [{ type: "text", text: "submitted" }] },
              { role: "assistant", stopReason: "stop" },
            ],
          });
          emit({ type: "agent_start" });
          setTimeout(() => {
            terminal = true;
            emit({
              type: "agent_end",
              messages: [
                { role: "custom", customType: "magic-context:ceiling-nudge" },
                { role: "assistant", stopReason: "stop" },
              ],
            });
          }, 20);
        }, 0);
        return { success: true };
      },
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", rpc, expectMagicContext: false, turns: [],
    });

    const result = await h.sendPrompt("submitted", { timeoutMs: 200 });

    expect(terminal).toBe(true);
    expect(result.events.at(-1)?.type).toBe("agent_end");
    expect(result.events.at(-1)?.isTerminal).not.toBe(false);
  });

  it("reports the event tail and last provider request when an RPC event times out", async () => {
    const protocol = new PiRpcProtocol();
    const rpc = {
      onEvent: protocol.onEvent.bind(protocol),
      waitForEvent: protocol.waitForEvent.bind(protocol),
      getExtensionErrors: () => [],
      getStderr: () => "",
      sendCommand: async () => {
        setTimeout(() => {
          protocol.dispatchLine(JSON.stringify({
            type: "agent_end",
            isTerminal: false,
            messages: [{ role: "custom", customType: "magic-context:ceiling-nudge" }],
          }));
        }, 0);
        return { success: true };
      },
    };
    const mock = {
      lastRequest: () => ({
        receivedAt: 1,
        method: "POST",
        path: "/v1/messages",
        headers: {},
        body: {
          model: "mock-model",
          messages: [{ role: "user", content: "previous submitted turn" }],
        },
      }),
    };
    const h: PiTestHarness = Object.assign(Object.create(PiTestHarness.prototype), {
      host: "omp", mock, rpc, expectMagicContext: false, turns: [],
    });

    let failure = "";
    try {
      await h.sendPrompt("missing turn", { timeoutMs: 10 });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    expect(failure).toContain("--- pi rpc event tail ---");
    expect(failure).toContain('"type":"agent_end","isTerminal":false');
    expect(failure).toContain('"customType":"magic-context:ceiling-nudge"');
    expect(failure).toContain("--- last mock provider request body summary ---");
    expect(failure).toContain('"lastUser":{"role":"user","content":{"characters":23,"preview":"previous submitted turn"}}');
  });
});
