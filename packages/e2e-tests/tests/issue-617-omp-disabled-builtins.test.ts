/// <reference types="bun-types" />

import { afterAll, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { PiTestHarness } from "../src/pi-harness";

const TASK_ROOT = join(tmpdir(), "magic-context", "issue-617-disabled-builtins");
const CHILD_PROMPT = "issue 617 disabled grep mapper reaches mock model";
let harness: PiTestHarness | undefined;
let rootDir: string | undefined;

afterAll(async () => {
	try {
		await harness?.dispose();
	} finally {
		if (rootDir) rmSync(rootDir, { recursive: true, force: true });
	}
});

it("OMP drops disabled grep before starting the dreamer mapper child", async () => {
	mkdirSync(TASK_ROOT, { recursive: true });
	rootDir = realpathSync(mkdtempSync(join(TASK_ROOT, "run-")));
	// Each run owns a distinct HOME/XDG root; no host config or store is read from
	// the developer account, even when this test is run alongside another suite.
	harness = await PiTestHarness.create({
		host: "omp",
		rootDir,
		piSettingsExtra: { grep: { enabled: false } },
		extensionsBeforeMagicContext: [
			resolve(import.meta.dir, "../fixtures/issue-617-disabled-tools-extension.ts"),
		],
	});

	const isolatedRoot = realpathSync(TASK_ROOT);
	expect(harness.env.baseDir.startsWith(`${isolatedRoot}${sep}`)).toBe(true);
	const config = JSON.parse(readFileSync(join(harness.env.agentDir, "config.yml"), "utf8"));
	expect(config.grep.enabled).toBe(false);

	const hostPid = harness.hostPid;
	expect(hostPid).toBeDefined();
	const hostOpenFiles = execFileSync("lsof", ["-Fn", "-p", String(hostPid)], {
		encoding: "utf8",
	});
	const hostPaths = hostOpenFiles
		.split("\n")
		.filter((line) => line.startsWith("n"))
		.map((line) => line.slice(1));
	const stateAndConfigPaths = hostPaths.filter((path) =>
		/(?:config\.yml|models\.json|magic-context\.jsonc|\.db(?:-wal|-shm)?)$/.test(path),
	);
	const canonicalHostPaths = hostPaths.map((path) =>
		path.replace(/^\/private(?=\/var\/)/, ""),
	);
	expect(canonicalHostPaths).toContain(harness.env.workdir);
	for (const path of stateAndConfigPaths) {
		expect(path.startsWith(`${harness.env.baseDir}${sep}`), path).toBe(true);
	}
	for (const path of hostPaths) {
		expect(path).not.toMatch(/\/Users\/[^/]+\/(?:\.omp|\.pi|\.config\/cortexkit|\.local\/share\/cortexkit\/magic-context)\//);
	}

	await harness.sendPrompt("confirm OMP plugin extensions started", { timeoutMs: 30_000 });
	await harness.invokeExtensionCommand("issue-617-probe");
	const resultPath = join(harness.env.agentDir, "issue-617-child-result.json");
	await harness.waitFor(() => existsSync(resultPath), {
		timeoutMs: 5_000,
		label: "issue 617 mapper child result",
	});
	const childResult = JSON.parse(readFileSync(resultPath, "utf8")) as {
		ok: boolean;
		assistantText?: string;
		error?: string;
	};
	expect(childResult).toMatchObject({ ok: true });
	expect(childResult.error ?? "").not.toContain("Built-in tool unavailable");
	expect(
		harness.mock.requests().some((request) => JSON.stringify(request.body).includes(CHILD_PROMPT)),
	).toBe(true);
}, 120_000);
