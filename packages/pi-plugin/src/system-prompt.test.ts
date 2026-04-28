import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	appendCompartments,
	replaceSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { insertMemory } from "@magic-context/core/features/magic-context/memory/storage-memory";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { buildMagicContextBlock } from "./system-prompt";
import { createTestDb } from "./test-utils.test";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

describe("buildMagicContextBlock", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0))
			rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no memories, session history, or docs exist", () => {
		const db = createTestDb();
		try {
			expect(
				buildMagicContextBlock({
					db,
					cwd: tempDir("pi-empty-"),
					sessionId: "ses-empty",
					memoryEnabled: true,
					injectDocs: true,
				}),
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("renders a project-memory block when memories exist", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-memory-");
		try {
			insertMemory(db, {
				projectPath: resolveProjectIdentity(cwd),
				category: "WORKFLOW_RULES",
				content: "Always run Pi plugin tests from packages/pi-plugin.",
				sourceType: "user",
			});

			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-memory",
				memoryEnabled: true,
				injectDocs: false,
			});

			expect(block).toContain("<magic-context>");
			expect(block).toContain("<project-memory>");
			expect(block).toContain("Always run Pi plugin tests");
		} finally {
			closeQuietly(db);
		}
	});

	it("renders project-docs when ARCHITECTURE.md and STRUCTURE.md are present", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-docs-");
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, "ARCHITECTURE.md"),
			"# Architecture\nRuntime map",
			"utf-8",
		);
		writeFileSync(
			join(cwd, "STRUCTURE.md"),
			"# Structure\nPackage map",
			"utf-8",
		);
		try {
			const block = buildMagicContextBlock({
				db,
				cwd,
				memoryEnabled: false,
				injectDocs: true,
			});

			expect(block).toContain("<project-docs>");
			expect(block).toContain("<ARCHITECTURE.md>");
			expect(block).toContain("Runtime map");
			expect(block).toContain("<STRUCTURE.md>");
		} finally {
			closeQuietly(db);
		}
	});

	it("renders session-history for compartments and facts", () => {
		const db = createTestDb();
		try {
			appendCompartments(db, "ses-history", [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 2,
					startMessageId: "m1",
					endMessageId: "m2",
					title: "Setup",
					content: "Configured Pi historian.",
				},
			]);
			replaceSessionFacts(db, "ses-history", [
				{
					category: "CONSTRAINTS",
					content: "Do not spawn pi subprocesses in tests.",
				},
			]);

			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-history-"),
				sessionId: "ses-history",
				memoryEnabled: false,
				injectDocs: false,
			});

			expect(block).toContain("<session-history>");
			expect(block).toContain('<compartment start="1" end="2" title="Setup">');
			expect(block).toContain("Configured Pi historian.");
			expect(block).toContain("Do not spawn pi subprocesses");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims memories by the configured character budget", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-memory-budget-");
		const projectPath = resolveProjectIdentity(cwd);
		try {
			insertMemory(db, {
				projectPath,
				category: "CONSTRAINTS",
				content: "short keep",
				sourceType: "user",
			});
			insertMemory(db, {
				projectPath,
				category: "WORKFLOW_RULES",
				content: "x".repeat(200),
				sourceType: "user",
			});

			const block = buildMagicContextBlock({
				db,
				cwd,
				memoryEnabled: true,
				injectDocs: false,
				memoryBudgetChars: 40,
			});

			expect(block).toContain("short keep");
			expect(block).not.toContain("x".repeat(80));
		} finally {
			closeQuietly(db);
		}
	});
});
