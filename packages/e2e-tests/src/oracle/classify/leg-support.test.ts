/**
 * Unit 2 support laws: the MockProvider agent-queue mechanism (the data source
 * for the classifier's queue lane), the spawn-side model registration
 * validation (the data source for the model lane), and the reuse laws that
 * keep the classified legs on the certified unit-1b determinism path instead
 * of a re-forked harness.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MockProvider } from "../../mock-provider/server";
import { spawnOpencode } from "../../opencode-runner/spawn";

const E2E_ROOT = resolve(import.meta.dir, "../../..");

function postMessages(baseURL: string, model: string): Promise<Response> {
	return fetch(`${baseURL}/messages`, {
		method: "POST",
		body: JSON.stringify({ model, messages: [{ role: "user", content: "x" }], stream: false }),
	});
}

describe("mock provider agent queues (classifier queue lane)", () => {
	it("serves the agent model from its queue with per-agent prefix ids and records attribution", async () => {
		const mock = new MockProvider();
		try {
			const { baseURL } = await mock.start();
			mock.scriptAgentQueues([
				{ prefix: "qa", model: "mock-agent", responses: [{ text: "one", usage: { input_tokens: 10, output_tokens: 5 } }, { text: "two", usage: { input_tokens: 10, output_tokens: 5 } }] },
			]);
			const first = (await (await postMessages(baseURL, "mock-agent")).json()) as { id: string };
			const second = (await (await postMessages(baseURL, "mock-agent")).json()) as { id: string };
			expect(first.id).toBe("qa-1");
			expect(second.id).toBe("qa-2");
			expect(mock.requests().map((request) => request.servedByQueue)).toEqual(["qa", "qa"]);
		} finally {
			await mock.stop();
		}
	});

	it("falls through to the global chain unattributed when the queue is exhausted without a default", async () => {
		const mock = new MockProvider();
		try {
			const { baseURL } = await mock.start();
			mock.scriptAgentQueues([
				{ prefix: "qa", model: "mock-agent", responses: [{ text: "queued", usage: { input_tokens: 10, output_tokens: 5 } }] },
			]);
			mock.script([{ text: "global", usage: { input_tokens: 10, output_tokens: 5 } }]);
			const first = (await (await postMessages(baseURL, "mock-agent")).json()) as { id: string };
			const second = (await (await postMessages(baseURL, "mock-agent")).json()) as { id: string };
			expect(first.id).toBe("qa-1");
			expect(second.id).toContain("msg_");
			expect(mock.requests().map((request) => request.servedByQueue)).toEqual([
				"qa",
				undefined,
			]);
		} finally {
			await mock.stop();
		}
	});

	it("serves the queue defaultResponse with the -default id once scripted responses run out", async () => {
		const mock = new MockProvider();
		try {
			const { baseURL } = await mock.start();
			mock.scriptAgentQueues([
				{
					prefix: "qa",
					model: "mock-agent",
					responses: [{ text: "one", usage: { input_tokens: 10, output_tokens: 5 } }],
					defaultResponse: { text: "d", usage: { input_tokens: 10, output_tokens: 5 } },
				},
			]);
			const first = (await (await postMessages(baseURL, "mock-agent")).json()) as { id: string };
			const second = (await (await postMessages(baseURL, "mock-agent")).json()) as { id: string };
			expect(first.id).toBe("qa-1");
			expect(second.id).toBe("qa-default");
		} finally {
			await mock.stop();
		}
	});

	it("refuses collapsed queues: duplicate prefix, duplicate model, empty names", () => {
		const mock = new MockProvider();
		expect(() =>
			mock.scriptAgentQueues([
				{ prefix: "p", model: "m1", responses: [] },
				{ prefix: "p", model: "m2", responses: [] },
			]),
		).toThrow(/duplicate prefix/);
		expect(() =>
			mock.scriptAgentQueues([
				{ prefix: "a", model: "m", responses: [] },
				{ prefix: "b", model: "m", responses: [] },
			]),
		).toThrow(/duplicate model/);
		expect(() => mock.scriptAgentQueues([{ prefix: " ", model: "m", responses: [] }])).toThrow(
			/empty prefix/,
		);
		expect(() =>
			mock.scriptAgentQueues([{ prefix: "p", model: " ", responses: [] }]),
		).toThrow(/empty model/);
	});

	it("reset clears agent queues so stale attribution cannot leak across legs", async () => {
		const mock = new MockProvider();
		try {
			const { baseURL } = await mock.start();
			mock.scriptAgentQueues([
				{ prefix: "qa", model: "mock-agent", responses: [{ text: "one", usage: { input_tokens: 10, output_tokens: 5 } }] },
			]);
			mock.reset();
			mock.setDefault({ text: "after-reset", usage: { input_tokens: 10, output_tokens: 5 } });
			await postMessages(baseURL, "mock-agent");
			expect(mock.requests().map((request) => request.servedByQueue)).toEqual([undefined]);
		} finally {
			await mock.stop();
		}
	});
});

describe("spawn model registration validation (classifier model lane)", () => {
	const base = { mockProviderURL: "http://127.0.0.1:1" } as const;

	it("rejects an unregistered smallModelID before boot", async () => {
		await expect(
			spawnOpencode({ ...base, smallModelID: "mock-unregistered" }),
		).rejects.toThrow(/smallModelID mock-unregistered is not a registered mock model/);
	});

	it("rejects an unregistered mock agent model before boot", async () => {
		await expect(
			spawnOpencode({ ...base, mockAgentModels: { historian: "mock-nope" } }),
		).rejects.toThrow(/mockAgentModels\.historian names unregistered mock model/);
	});

	it("rejects a mock agent model that conflicts with the historianMockModel pin", async () => {
		await expect(
			spawnOpencode({
				...base,
				historianMockModel: { id: "mock-hist-a", contextLimit: 1000 },
				extraMockModels: [{ id: "mock-hist-b" }],
				mockAgentModels: { historian: "mock-hist-b" },
			}),
		).rejects.toThrow(/conflicts with the historianMockModel pin/);
	});
});

describe("unit 2 reuse laws (classified legs ride the certified unit-1b path)", () => {
	const runner = readFileSync(join(E2E_ROOT, "src/oracle/classify/leg-runner.ts"), "utf8");
	const unitOne = readFileSync(join(E2E_ROOT, "tests/oracle-determinism.test.ts"), "utf8");
	const unitTwo = readFileSync(join(E2E_ROOT, "tests/oracle-classified-capture.test.ts"), "utf8");

	it("both legs enter through the single shared runner, never a direct host spawn", () => {
		for (const [label, source] of [
			["unit 1", unitOne],
			["unit 2", unitTwo],
		] as const) {
			expect(source.includes("runOracleLegPair"), `${label} must use the shared runner`).toBe(
				true,
			);
			expect(
				/include|spawnOpencode/.test(source) === false &&
					/from "\.\.\/src\/opencode-runner\/spawn"/.test(source) === false,
				`${label} must not spawn the host directly`,
			).toBe(true);
		}
	});

	it("the determinism wrapper and unit-1b machinery live in exactly one place", () => {
		expect(runner.split("Determinism wrapper for the oracle OC1 leg").length - 1).toBe(1);
		expect(runner.includes("resolvePinnedOpenCode1Host")).toBe(true);
		expect(runner.includes("snapshotStore") && runner.includes("restoreStore")).toBe(true);
		expect(runner.includes("waitForMockQuiescence")).toBe(true);
		expect(runner.includes("assertSessionProcessed")).toBe(true);
	});

	it("the classified capture registers every class model and exercises queue + comparator mechanisms", () => {
		for (const needle of [
			"extraMockModels",
			"smallModelID",
			"mockAgentModels",
			"scriptAgentQueues",
			"classifyOracleRequests",
			"compareOracleClassSequences",
			"assertDisabledClassesAbsent",
		]) {
			expect(unitTwo.includes(needle), `classified capture must use ${needle}`).toBe(true);
		}
	});
});
