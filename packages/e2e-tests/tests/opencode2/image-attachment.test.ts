import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

// A 1x1 PNG. Attached the way the TUI and the HTTP API attach images: as a
// `files` entry on the prompt, once inline (a pasted image) and once by file URI.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Row = { type?: string; outcome?: string };

for (const attach of ["inline", "file-uri"] as const) {
	test(`image attachment (${attach}) and the turns after it reach the provider with Magic Context loaded`, async () => {
		const host = await spawnOpencode2({
			magicContextConfig: {
				historian: { disable: true },
				dreamer: { disable: true },
				memory: { enabled: false },
			},
			mockResponse: { text: "ok", usage: { input_tokens: 100, output_tokens: 20 } },
		});
		try {
			const client = OpenCode.make({
				baseUrl: host.url,
				headers: { authorization: `Basic ${btoa(`opencode:${host.password}`)}` },
			});
			const session = await client.session.create({
				location: { directory: host.cwd },
				model: { providerID: "openai", id: "mock-model" },
			});
			await waitForPluginActive(client, host.cwd);
			const png = join(host.cwd, "pixel.png");
			writeFileSync(png, Buffer.from(PNG_BASE64, "base64"));
			const uri =
				attach === "inline" ? `data:image/png;base64,${PNG_BASE64}` : `file://${png}`;

			const prompts = ["what is in this image?", "and now?", "one more turn"];
			for (const [turn, text] of prompts.entries()) {
				const before = host.mock.requests().length;
				await client.session.prompt({
					sessionID: session.id,
					text,
					...(turn === 0 ? { files: [{ uri, name: "pixel.png" }] } : {}),
				});
				await client.session.wait(
					{ sessionID: session.id },
					{ signal: AbortSignal.timeout(60_000) },
				);
				// session.wait resolves on idle whether the turn succeeded or not, so read
				// the idle row the host wrote for this turn. On OpenCode 2.0.15 a malformed
				// attachment fails inside the host's own request preparation with "Schema
				// validation failed", before any provider request is made.
				const listed = (await client.message.list({ sessionID: session.id })) as {
					data: Row[];
				};
				const idle = listed.data.find((row) => row.type === "idle");
				const failure = host
					.stderr()
					.split("\n")
					.find((line) => line.includes("Schema validation failed"))
					?.slice(0, 300);
				expect({ turn, outcome: idle?.outcome, failure }).toEqual({
					turn,
					outcome: "succeeded",
					failure: undefined,
				});
				const turnRequests = host.mock
					.requests()
					.slice(before)
					.map((request) => JSON.stringify(request.body));
				// The host's title generation also sends the first prompt, through its own
				// title model; only the session model's requests carry the conversation.
				const primary = turnRequests.filter(
					(body) => body.includes('"model":"mock-model"') && body.includes(text),
				);
				expect(primary.length).toBeGreaterThan(0);
				// The image stays in the conversation the provider sees on every turn.
				expect(primary.every((body) => body.includes(PNG_BASE64))).toBe(true);
			}
		} finally {
			await host.stop();
		}
	}, 180_000);
}
