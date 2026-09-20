import { expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { updateSessionMeta } from "@magic-context/core/features/magic-context/storage";
import { getCurrentSystemPrompt, getCurrentTools } from "pi-ai-086";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	userMessage,
} from "./test-utils.test";

it.skipIf(!process.env.MC_GATE_PURE)("F pure replay child", async () => {
	const clock = spyOn(Date, "now").mockReturnValue(1800000000000);
	const db = createTestDb();
	const sid = "gate-pure";
	try {
		const fake = createFakePi();
		registerPiContextHandler(fake.pi as never, {
			db,
			protectedTags: 0,
			injection: { injectionBudgetTokens: 10000 },
		});
		const handler = fake.handlers.get("context") as (
			event: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const raw = [
			userMessage("old", 1),
			assistantMessage("answer", 2),
			userMessage("tail", 3),
		];
		const passes = [];
		for (let pass = 0; pass < 6; pass++) {
			if (pass === 5) clearContextHandlerSession(sid);
			const messages = structuredClone(raw);
			const served = await handler(
				{ messages },
				{
					...fakeContext(
						sid,
						process.env.MC_GATE_EMPTY,
						["u0", "a0", "u1"],
						messages,
					),
					getContextUsage: () => ({
						tokens: pass ? 10000 : 70000,
						percent: pass ? 10 : 70,
						contextWindow: 100000,
					}),
				},
			);
			passes.push({
				pass,
				sha256: createHash("sha256")
					.update(JSON.stringify(served.messages))
					.digest("hex"),
				tools: getCurrentTools(served.messages as never),
				prompt: getCurrentSystemPrompt(served.messages as never),
			});
			updateSessionMeta(db, sid, {
				lastResponseTime: Date.now(),
				cacheTtl: "59m",
				lastContextPercentage: 10,
				lastInputTokens: 10000,
			});
		}
		console.log(`PURE_GATE=${JSON.stringify(passes)}`);
	} finally {
		clearContextHandlerSession(sid);
		db.close();
		clock.mockRestore();
	}
});

it("F no-system served arrays equal pre-fix master on every replay", () => {
	const root = resolve(import.meta.dir, "../../..");
	const temp = mkdtempSync(join(root, ".issue-485-pure-"));
	try {
		const baseline = execFileSync("git", ["rev-parse", "60360073^1"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		const archive = execFileSync(
			"git",
			["archive", baseline, "packages/pi-plugin"],
			{
				cwd: root,
				maxBuffer: 100 * 1024 * 1024,
			},
		);
		execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive });
		symlinkSync(join(root, "node_modules"), join(temp, "node_modules"), "dir");
		for (const pkg of ["plugin", "retina-local-fs"])
			symlinkSync(
				join(root, "packages", pkg),
				join(temp, "packages", pkg),
				"dir",
			);
		symlinkSync(
			join(root, "packages/pi-plugin/node_modules"),
			join(temp, "packages/pi-plugin/node_modules"),
			"dir",
		);
		const script = join(
			temp,
			"packages/pi-plugin/src/issue-485-replay-gate.test.ts",
		);
		copyFileSync(import.meta.path, script);
		const empty = join(temp, "empty");
		mkdirSync(empty);
		const outputs = [script, import.meta.path].map((path) => {
			const child = Bun.spawnSync(
				[process.execPath, "test", path, "-t", "F pure replay child"],
				{
					cwd: dirname(path),
					env: { ...process.env, MC_GATE_PURE: "1", MC_GATE_EMPTY: empty },
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			if (child.exitCode !== 0) throw new Error(child.stderr.toString());
			const line = child.stdout
				.toString()
				.split("\n")
				.find((line) => line.startsWith("PURE_GATE="));
			if (!line) throw new Error("No pure replay output");
			return JSON.parse(line.slice("PURE_GATE=".length));
		});
		console.log(`GATE F baseline=${baseline} ${JSON.stringify(outputs)}`);
		expect(outputs[1]).toEqual(outputs[0]);
	} finally {
		rmSync(temp, { recursive: true, force: true });
	}
});
