// Scratch probe only: never registered by the published MC server entry.
export default {
	id: "mc-payload-probe",
	setup(context) {
		context.session.hook("title", (draft) => {
			draft.result = "probe";
		});
		context.session.hook("context", (draft) => {
			draft.system.splice(0, draft.system.length, {
				type: "text",
				text: "payload probe system",
			});
			draft.messages.splice(
				0,
				draft.messages.length,
				{ role: "user", content: [{ type: "text", text: "probe text" }] },
				{
					role: "assistant",
					content: [
						{
							type: "reasoning",
							text: "probe thinking",
							encrypted: "probe-signature",
						},
						{
							type: "tool-call",
							id: "call_probe",
							name: "read",
							input: { path: "probe.txt" },
						},
					],
				},
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							id: "call_probe",
							name: "read",
							result: { type: "text", value: "probe result" },
						},
					],
				},
				{ role: "user", content: [{ type: "text", text: "continue probe" }] },
			);
		});
	},
};
