import { enqueueDream } from "@magic-context/core/features/magic-context/dreamer/queue";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { sendCtxStatusMessage } from "./pi-command-utils";

export function registerCtxDreamCommand(
	pi: ExtensionAPI,
	deps: {
		db: ContextDatabase;
		projectDir: string;
		projectIdentity: string;
	},
): void {
	pi.registerCommand("ctx-dream", {
		description: "Queue a Magic Context dreamer run for this project",
		handler: async () => {
			const entry = enqueueDream(deps.db, deps.projectIdentity, "manual");
			const text = entry
				? [
						"## /ctx-dream",
						"",
						`Queued dream run #${entry.id} for ${deps.projectIdentity}.`,
						`Project directory: ${deps.projectDir}`,
						"The registered dreamer timer will process it on its next tick.",
					].join("\n")
				: [
						"## /ctx-dream",
						"",
						`Dream already queued or running for ${deps.projectIdentity}.`,
					].join("\n");

			sendCtxStatusMessage(
				pi,
				{ title: "/ctx-dream", text, level: entry ? "success" : "info" },
				{
					projectDir: deps.projectDir,
					projectIdentity: deps.projectIdentity,
					entry,
				},
			);
		},
	});
}
