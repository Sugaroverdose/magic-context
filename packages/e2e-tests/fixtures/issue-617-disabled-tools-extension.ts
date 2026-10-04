import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PiSubagentRunner } from "../../pi-plugin/src/subagent-runner";
import { resolvePiHostInvocation } from "../src/pi-runner/spawn";

const CHILD_PROMPT = "issue 617 disabled grep mapper reaches mock model";

export default function issue617DisabledToolsExtension(pi: any): void {
	pi.registerCommand("issue-617-probe", {
		description: "Run the issue 617 OMP disabled-tool regression probe",
		handler: async (_args: string, ctx: { cwd: string }) => {
			const agentDir = process.env.PI_CODING_AGENT_DIR;
			if (!agentDir) throw new Error("issue 617 probe needs a throwaway Pi agent directory");
			const pidPath = join(agentDir, "issue-617-child.pid");
			const resultPath = join(agentDir, "issue-617-child-result.json");
			try {
				const runner = new PiSubagentRunner({
					invocation: resolvePiHostInvocation("omp"),
				});
				const result = await runner.run({
					agent: "dreamer-memory-mapper",
					systemPrompt: "Inspect local source files and report the test marker you find.",
					userMessage: CHILD_PROMPT,
					model: "mock/mock-model",
					cwd: ctx.cwd,
					timeoutMs: 30_000,
					onProgress: (event: { type: string; pid?: number }) => {
						if (event.type === "spawned" && event.pid) {
							writeFileSync(pidPath, String(event.pid));
						}
					},
				});
				writeFileSync(resultPath, JSON.stringify(result));
			} catch (error) {
				writeFileSync(resultPath, JSON.stringify({
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				}));
			}
		},
	});
}

export { CHILD_PROMPT };
