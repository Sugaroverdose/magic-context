#!/usr/bin/env node
import { createRequire } from "node:module";

import { doctor } from "./doctor";
import { runSetup } from "./setup";

function getVersion(): string {
	try {
		const req = createRequire(import.meta.url);
		return (
			(req("../../package.json") as { version?: string }).version ?? "0.0.0"
		);
	} catch {
		return "0.0.0";
	}
}

function printUsage(): void {
	console.log("");
	console.log("  Magic Context for Pi CLI");
	console.log("  ────────────────────────");
	console.log("");
	console.log("  Commands:");
	console.log("    setup            Interactive setup wizard");
	console.log("    doctor           Run health checks");
	console.log("    doctor --force   Repair safe issues and re-check");
	console.log("    doctor --issue   Create a sanitized GitHub bug report");
	console.log("    doctor --help    Show doctor help");
	console.log("    --version        Print version");
	console.log("");
	console.log("  Usage:");
	console.log("    magic-context-pi setup");
	console.log("    magic-context-pi doctor");
	console.log("    magic-context-pi doctor --force");
	console.log("    magic-context-pi doctor --issue");
	console.log("");
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const command = argv[0];
	if (command === "setup") return runSetup();
	if (command === "doctor") return doctor(argv.slice(1));
	if (command === "--version" || command === "-v") {
		console.log(getVersion());
		return 0;
	}

	printUsage();
	return command ? 1 : 0;
}

main().then((code) => process.exit(code));
