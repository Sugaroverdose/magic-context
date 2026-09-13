import { expect, test } from "bun:test";
import { MockProvider } from "./server";

test("mock refuses a port already owned on its advertised IPv4 address", async () => {
    const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("foreign") });
    const mock = new MockProvider();
    try {
        await expect(mock.start({ port: foreign.port })).rejects.toThrow();
    } finally {
        await mock.stop();
        foreign.stop(true);
    }
});

test("advertised mock URL reaches the mock and unknown paths retain its 404 signature", async () => {
    const mock = new MockProvider();
    try {
        const { baseURL } = await mock.start();
        mock.setDefault({ text: "owned", usage: { input_tokens: 1, output_tokens: 1 } });
        const response = await fetch(`${baseURL}/messages`, { method: "POST", body: JSON.stringify({ model: "mock", messages: [], stream: false }) });
        expect(response.status).toBe(200);
        expect(mock.requests()).toHaveLength(1);
        const miss = await fetch(`${baseURL}/unknown`);
        expect(miss.status).toBe(404);
        expect(await miss.json()).toEqual({ error: "not_found", path: "/unknown" });
    } finally {
        await mock.stop();
    }
});
