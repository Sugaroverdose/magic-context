import { afterEach, expect, it, spyOn } from "bun:test";
import { measureAnthropic } from "./anthropic";

let mock: ReturnType<typeof spyOn> | undefined;
afterEach(() => mock?.mockRestore());

it("uses API-key counts and baseline subtraction for every probe", async () => {
    const bodies: Record<string, unknown>[] = [];
    mock = spyOn(globalThis, "fetch").mockImplementation((async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("https://api.anthropic.com/v1/messages/count_tokens?beta=true");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("test-key");
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("anthropic-beta")).toBe("oauth-2025-04-20");
        const body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBeUndefined();
        bodies.push(body);
        return Response.json({ input_tokens: body.system ? 110 : body.tools ? 210 : body.messages[0].content === "x" ? 10 : 310 });
    }) as typeof fetch);
    const result = await measureAnthropic({ provider: "anthropic", label: "test", modelId: "test" }, { type: "api", key: "test-key" }, "system", [], { docs: "docs", history: "history", memory: "memory" });
    expect(result).toEqual({ method: "count_tokens", systemApi: 100, toolsApi: 200, proseApi: 300, sections: { docs: 300, history: 300, memory: 300 } });
    expect(bodies).toHaveLength(7);
});

it("never sends prose to the paid usage fallback", async () => {
    mock = spyOn(globalThis, "fetch").mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body.max_tokens).toBe(1);
        expect(body.messages[0].content).toBe("x");
        return Response.json({ usage: { input_tokens: body.system ? 110 : body.tools ? 210 : 10 } });
    }) as typeof fetch);
    const result = await measureAnthropic({ provider: "anthropic", label: "test", modelId: "test" }, { type: "oauth", access: "test-token" }, "system", [], { docs: "NEVER SEND THIS" });
    expect(result).toEqual({ method: "usage", systemApi: 100, toolsApi: 200, proseApi: null, sections: {} });
    expect(mock).toHaveBeenCalledTimes(3);
});
