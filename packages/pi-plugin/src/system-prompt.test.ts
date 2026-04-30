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

	it("returns null when no memories, session history, or docs exist (guidance off)", () => {
		const db = createTestDb();
		try {
			// includeGuidance: false isolates the data-block behavior; with
			// guidance enabled the block is never null because guidance is
			// always present.
			expect(
				buildMagicContextBlock({
					db,
					cwd: tempDir("pi-empty-"),
					sessionId: "ses-empty",
					memoryEnabled: true,
					injectDocs: true,
					includeGuidance: false,
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
				includeGuidance: false,
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
				includeGuidance: false,
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
				includeGuidance: false,
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
				includeGuidance: false,
			});

			expect(block).toContain("short keep");
			expect(block).not.toContain("x".repeat(80));
		} finally {
			closeQuietly(db);
		}
	});

	it("includes ## Magic Context guidance by default even when no data exists", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-guidance-"),
				sessionId: "ses-guidance",
				memoryEnabled: true,
				injectDocs: true,
				// includeGuidance default is true
			});

			expect(block).not.toBeNull();
			expect(block).toContain("## Magic Context");
			// Must explain ctx_search/ctx_memory/ctx_note so agent knows how to use them
			expect(block).toContain("ctx_search");
			expect(block).toContain("ctx_memory");
			expect(block).toContain("ctx_note");
			// No data block when nothing to render
			expect(block).not.toContain("<magic-context>");
		} finally {
			closeQuietly(db);
		}
	});

	it("concatenates guidance and data block when both present", () => {
		const db = createTestDb();
		const cwd = tempDir("pi-combo-");
		try {
			insertMemory(db, {
				projectPath: resolveProjectIdentity(cwd),
				category: "ARCHITECTURE_DECISIONS",
				content: "Pi loads at process start.",
				sourceType: "user",
			});

			const block = buildMagicContextBlock({
				db,
				cwd,
				sessionId: "ses-combo",
				memoryEnabled: true,
				injectDocs: false,
				includeGuidance: true,
			});

			expect(block).not.toBeNull();
			// Guidance comes first, then data block
			const guidanceIdx = block?.indexOf("## Magic Context") ?? -1;
			const dataIdx = block?.indexOf("<magic-context>") ?? -1;
			expect(guidanceIdx).toBeGreaterThanOrEqual(0);
			expect(dataIdx).toBeGreaterThanOrEqual(0);
			expect(guidanceIdx).toBeLessThan(dataIdx);
			expect(block).toContain("Pi loads at process start.");
		} finally {
			closeQuietly(db);
		}
	});

	it("emits no-reduce guidance variant when ctxReduceEnabled is false", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-noreduce-"),
				sessionId: "ses-noreduce",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: true,
				ctxReduceEnabled: false,
			});

			expect(block).not.toBeNull();
			expect(block).toContain("## Magic Context");
			// No-reduce variant must NOT mention §N§ tag system or ctx_reduce
			expect(block).not.toContain("§N§");
			expect(block).not.toContain("ctx_reduce");
			// But it MUST still teach the other ctx_* tools
			expect(block).toContain("ctx_search");
			expect(block).toContain("ctx_memory");
			expect(block).toContain("ctx_note");
		} finally {
			closeQuietly(db);
		}
	});

	it("includes §N§ tag explanation when ctxReduceEnabled is true (default)", () => {
		const db = createTestDb();
		try {
			const block = buildMagicContextBlock({
				db,
				cwd: tempDir("pi-reduce-"),
				sessionId: "ses-reduce",
				memoryEnabled: false,
				injectDocs: false,
				includeGuidance: true,
				ctxReduceEnabled: true,
				protectedTags: 25,
			});

			expect(block).not.toBeNull();
			// With ctx_reduce_enabled the agent needs to know what §N§ means
			expect(block).toContain("§N§");
			expect(block).toContain("ctx_reduce");
			// protected_tags value flows through to "Last 25 tags are protected"
			expect(block).toContain("25");
		} finally {
			closeQuietly(db);
		}
	});
});
