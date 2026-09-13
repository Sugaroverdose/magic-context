// Scratch probe adapts the same logical draft to the v1 persisted-message hook shape.
export default async () => ({
	"experimental.chat.system.transform": async (_input, output) => {
		output.system.splice(0, output.system.length, "payload probe system");
	},
	"experimental.chat.messages.transform": async (_input, output) => {
		const sessionID = output.messages.at(-1).info.sessionID;
		const user = (id, text) => ({
			info: {
				id,
				sessionID,
				role: "user",
				time: { created: 1 },
				agent: "build",
				model: { providerID: "mock-anthropic", modelID: "mock-model" },
			},
			parts: [
				{ id: `${id}_text`, sessionID, messageID: id, type: "text", text },
			],
		});
		output.messages.splice(
			0,
			output.messages.length,
			user("msg_probe_a", "probe text"),
			{
				info: {
					id: "msg_probe_b",
					sessionID,
					role: "assistant",
					parentID: "msg_probe_a",
					providerID: "mock-anthropic",
					modelID: "mock-model",
					agent: "build",
					mode: "build",
					path: { cwd: "/probe", root: "/probe" },
					time: { created: 2, completed: 3 },
					cost: 0,
					tokens: {
						input: 10,
						output: 10,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
					finish: "tool-calls",
				},
				parts: [
					{
						id: "prt_reason",
						sessionID,
						messageID: "msg_probe_b",
						type: "reasoning",
						text: "probe thinking",
						time: { start: 1, end: 2 },
						metadata: { anthropic: { signature: "probe-signature" } },
					},
					{
						id: "prt_tool",
						sessionID,
						messageID: "msg_probe_b",
						type: "tool",
						callID: "call_probe",
						tool: "read",
						state: {
							status: "completed",
							input: { path: "probe.txt" },
							output: "probe result",
							title: "probe",
							metadata: {},
							time: { start: 2, end: 3 },
						},
					},
				],
			},
			user("msg_probe_c", "continue probe"),
		);
	},
});
