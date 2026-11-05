import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendCompartments } from "@magic-context/core/features/magic-context/compartment-storage";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { readSystemRegion } from "@magic-context/core/features/magic-context/system-region";

const SENTINEL = "<!-- mc:system-region v1 -->";

import {
	getMemoriesByProject,
	insertMemory,
} from "@magic-context/core/features/magic-context/memory/storage-memory";
import {
	getCompartments,
	getOrCreateSessionMeta,
	queueMemoryMutation,
	setProjectState,
} from "@magic-context/core/features/magic-context/storage";
import { isSystemRegionBytes } from "@magic-context/core/features/magic-context/system-region";
import {
	getActiveUserMemories,
	insertUserMemory,
	type UserMemory,
} from "@magic-context/core/features/magic-context/user-memory/storage-user-memory";
import {
	COMPARTMENT_RENDER_EPOCH,
	encodeCachedM0UpgradeIdentity,
	MEMORY_RENDER_FORMAT_EPOCH,
	PROFILE_RENDER_EPOCH,
} from "@magic-context/core/hooks/magic-context/compartment-render-epoch";
import { renderMemoryBlockV2 } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { estimateTokens } from "@magic-context/core/hooks/magic-context/read-session-formatting";
import { USER_PROFILE_DESCRIPTION } from "@magic-context/core/hooks/magic-context/user-profile-render";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	__test,
	createPiM0M1PassSnapshot,
	injectM0M1Pi,
	materializeM0Pi,
	materializeM0PiWithRetry,
	mustMaterializePi,
	renderM0Pi,
	renderM1Pi,
	trimPiMessagesToCachedBoundary,
} from "./inject-compartments-pi";
import { createTestDb, textOf, userMessage } from "./test-utils.test";

function user(text: string, timestamp = 1) {
	return { role: "user" as const, content: text, timestamp };
}

function assistant(callIds: string[], text = "") {
	return {
		role: "assistant" as const,
		content: [
			...(text ? [{ type: "text" as const, text }] : []),
			...callIds.map((id) => ({
				type: "toolCall" as const,
				id,
				name: "read",
				arguments: {},
			})),
		],
		timestamp: 1,
	};
}

function result(toolCallId: string) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "read",
		content: [{ type: "text" as const, text: `out-${toolCallId}` }],
		isError: false,
		timestamp: 1,
	};
}

describe("workspace memory sharing", () => {
	it("filters foreign categories consistently in Pi m[0] and status counts", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath(join(tmpdir(), "mc-pi-share-"));
		try {
			db.exec(`
				INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
				VALUES (1, 'ws', '["CONSTRAINTS"]', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			insertMemory(db, {
				projectPath: "git:own",
				category: "NAMING",
				content: "own naming remains visible",
			});
			const shared = insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "foreign constraint is shared",
			});
			db.prepare("UPDATE memories SET shareable = 1 WHERE id = ?").run(
				shared.id,
			);
			insertMemory(db, {
				projectPath: "git:foreign",
				category: "NAMING",
				content: "foreign naming is hidden",
			});
			const state = {
				sessionId: "pi-share",
				projectIdentity: "git:own",
				projectDirectory: dir,
			};

			const m0 = renderM0Pi(state, db, "");
			expect(m0).toContain("own naming remains visible");
			expect(m0).toContain("foreign constraint is shared");
			expect(m0).not.toContain("foreign naming is hidden");

			const messages = [userMessage("hello")];
			const result = injectM0M1Pi(state, db, messages, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(result.memoryCount).toBe(2);
			const shareRegion = readSystemRegion(db, state.sessionId) ?? "";
			expect(shareRegion).toContain("foreign constraint is shared");
			expect(shareRegion).not.toContain("foreign naming is hidden");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not render foreign memories when share_categories is malformed", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-share-malformed-"),
		);
		try {
			db.exec(`
				INSERT INTO workspaces (id, name, share_categories, created_at, updated_at)
				VALUES (1, 'ws', 'not-json', 1, 1);
				INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at)
				VALUES (1, 'git:own', 'Own', '/own', 1), (1, 'git:foreign', 'Foreign', '/foreign', 1);
			`);
			insertMemory(db, {
				projectPath: "git:own",
				category: "CONSTRAINTS",
				content: "own malformed Pi memory remains visible",
			});
			insertMemory(db, {
				projectPath: "git:foreign",
				category: "CONSTRAINTS",
				content: "foreign malformed Pi memory is hidden",
			});
			const state = {
				sessionId: "pi-share-malformed",
				projectIdentity: "git:own",
				projectDirectory: dir,
			};

			const m0 = renderM0Pi(state, db, "");
			expect(m0).toContain("own malformed Pi memory remains visible");
			expect(m0).not.toContain("foreign malformed Pi memory is hidden");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("Pi memory budget selection", () => {
	it("selects the verified memory when an importance-50 budget admits one", () => {
		const db = createTestDb();
		const dir = createTestTempDirFromPath(
			join(tmpdir(), "mc-pi-memory-recency-"),
		);
		try {
			const projectIdentity = resolveProjectIdentity(dir);
			const neverVerified = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "memory alpha record",
				importance: 50,
			});
			const verifiedYesterday = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "memory bravo record",
				importance: 50,
			});
			db.prepare(
				"UPDATE memories SET last_seen_at = 1000, verified_at = CASE WHEN id = ? THEN 2000 ELSE NULL END WHERE id IN (?, ?)",
			).run(verifiedYesterday.id, neverVerified.id, verifiedYesterday.id);
			const memories = getMemoriesByProject(db, projectIdentity);
			const budget = Math.max(
				...memories.map((memory) =>
					estimateTokens(renderMemoryBlockV2([memory])),
				),
			);

			const m0 = renderM0Pi(
				{
					sessionId: "pi-memory-recency",
					projectIdentity,
					projectDirectory: dir,
					injectionBudgetTokens: budget,
				},
				db,
				"",
				1,
				memories,
			);

			expect(m0).toContain("memory bravo record");
			expect(m0).not.toContain("memory alpha record");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("trimPiMessagesToBoundary", () => {
	it("context_edit of a partially covered entry retains the edited suffix and does not trim across it", () => {
		const edited = [
			user("old"),
			user("edited UNCOVERED_SUFFIX"),
			user("append"),
		];
		const ids = ["old", "partial", "append"];
		expect(
			__test.trimPiMessagesToBoundary(
				edited,
				ids,
				"partial",
				true,
				"ses-edit",
				true,
			),
		).toBe(0);
		expect(JSON.stringify(edited)).toContain("UNCOVERED_SUFFIX");
		const prefix = JSON.stringify(edited);
		const defer = [
			user("old"),
			user("edited UNCOVERED_SUFFIX"),
			user("append"),
			user("later"),
		];
		expect(
			__test.trimPiMessagesToBoundary(
				defer,
				[...ids, "later"],
				"partial",
				true,
				"ses-edit",
				true,
			),
		).toBe(0);
		expect(JSON.stringify(defer.slice(0, edited.length))).toBe(prefix);
		const removedByHost = [user("old"), user("append")];
		expect(
			__test.trimPiMessagesToBoundary(
				removedByHost,
				["old", "append"],
				"partial",
				true,
				"ses-edit",
				true,
			),
		).toBe(0);
		expect(removedByHost).toHaveLength(2);
	});
	it("sweeps non-contiguous toolResults whose assistant toolCall was trimmed", () => {
		const messages = [
			assistant(["call-a"]),
			user("interleaved"),
			result("call-a"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "u1", "r", "u2"],
			"a",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect((messages[0] as { content: string }).content).toBe("interleaved");
	});

	it("sweeps split multi-toolCall results after an intervening user", () => {
		const messages = [
			assistant(["call-a", "call-b"]),
			user("gap"),
			result("call-a"),
			result("call-b"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "gap", "ra", "rb", "keep"],
			"a",
		);

		expect(removed).toBe(3);
		expect(messages.map((m) => m.role)).toEqual(["user", "user"]);
	});

	it("sweeps kept assistant toolCalls when their toolResult was trimmed", () => {
		const messages = [
			user("old"),
			result("call-a"),
			assistant(["call-a"]),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["u", "r", "a", "keep"],
			"r",
		);

		expect(removed).toBe(3);
		expect(messages).toEqual([user("keep")]);
	});

	it("resolves a synth-user-* cutoff to the underlying real toolResult entry id", () => {
		// A compartment ending on a folded-toolResult boundary carries
		// endMessageId = `synth-user-<realToolResultEntryId>`. The live array has
		// no message with that synthetic id — only the real toolResult (entry id
		// "tr-real"). Pre-fix, the cutoff never matched and NOTHING was trimmed
		// (history duplicated -> overflow). The fix strips the prefix and matches
		// the real toolResult, then the orphan sweep removes its paired assistant.
		const messages = [
			assistant(["call-a"]),
			result("call-a"),
			assistant([], "next turn"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "tr-real", "a2", "keep"],
			"synth-user-tr-real",
		);

		// toolResult "tr-real" (cutoff) + its paired assistant "call-a" (orphan
		// sweep) are removed; the later turn + keep survive.
		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual(["assistant", "user"]);
		expect((messages[1] as { content: string }).content).toBe("keep");
	});

	it("returns 0 (no spurious trim) when a synth-user-* cutoff has no matching real entry", () => {
		const messages = [assistant(["call-a"]), user("keep")];
		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a", "keep"],
			"synth-user-nonexistent",
		);
		expect(removed).toBe(0);
		expect(messages.length).toBe(2);
	});

	it("does not over-remove a later kept tool pair that reuses a trimmed callId", () => {
		const messages = [
			assistant(["reused"]),
			result("reused"),
			user("between turns"),
			assistant(["reused"]),
			result("reused"),
			user("keep"),
		];

		const removed = __test.trimPiMessagesToBoundary(
			messages,
			["a1", "r1", "u1", "a2", "r2", "u2"],
			"a1",
		);

		expect(removed).toBe(2);
		expect(messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"user",
		]);
		expect((messages[3] as { content: string }).content).toBe("keep");
	});

	it("renders frozen compartment and user-profile snapshots without m[0]/m[1] duplication", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0-frozen-cp-profile-"),
		);
		try {
			const state = piState("ses-pi-frozen-cp-profile", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Frozen",
					content: "U: old turn\nold compartment body",
				},
			]);
			insertUserMemory(db, "old profile memory", []);
			const frozenCompartments = getCompartments(db, state.sessionId);
			const frozenUserProfile = getActiveUserMemories(db);

			appendCompartments(db, state.sessionId, [
				{
					sequence: 2,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-2",
					endMessageId: "entry-2",
					title: "Concurrent",
					content: "U: new turn\nnew compartment body",
				},
			]);
			insertUserMemory(db, "new profile memory", []);

			const m0 = renderM0Pi(
				state,
				db,
				"",
				1,
				[],
				frozenCompartments,
				frozenUserProfile,
			);
			const m1 = renderM1Pi(state, db, {
				maxCompartmentSeq: 1,
				maxMemoryId: 0,
				maxMutationId: 0,
				maxMemoryMutationId: 0,
				projectMemoryEpoch: 0,
				projectUserProfileVersion: 0,
				projectDocsHash: "",
				sessionFactsVersion: 0,
				materializedAt: 0,
				upgradeState: "",
				lastBaselineEndMessageId: "entry-1",
			});

			expect(m0).toContain("old compartment body");
			expect(m0).toContain("old profile memory");
			expect(m0).not.toContain("new compartment body");
			expect(m0).not.toContain("new profile memory");
			expect(m1).toContain("new compartment body");
			expect(m1).not.toContain("old compartment body");
			expect(m1).not.toContain("old profile memory");
		} finally {
			closeQuietly(db);
		}
	});
});

function piState(sessionId: string, cwd: string) {
	return {
		sessionId,
		projectIdentity: resolveProjectIdentity(cwd),
		projectDirectory: cwd,
		injectionBudgetTokens: 10_000,
	};
}

describe("user-profile rendering fixture", () => {
	it("renders the shared Rust/TypeScript fixture through Pi m[0]", () => {
		const fixture = JSON.parse(
			readFileSync(
				resolve(
					import.meta.dir,
					"../../../tests/fixtures/user-profile-render.json",
				),
				"utf8",
			),
		) as { cases: Array<{ input: string; expected: string }> };
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-user-profile-render-fixture-"),
		);
		try {
			const profile: UserMemory[] = fixture.cases.map(({ input }, index) => ({
				id: index + 1,
				content: input,
				status: "active",
				promotedAt: 0,
				sourceCandidateIds: [],
				sourceProvenance: null,
				createdAt: 0,
				updatedAt: 0,
			}));
			const rendered = renderM0Pi(
				{
					...piState("ses-pi-user-profile-render", cwd),
					userProfileBudgetTokens: 10_000,
				},
				db,
				"",
				1,
				[],
				[],
				profile,
			);
			const expectedBlock = [
				"<user-profile>",
				USER_PROFILE_DESCRIPTION,
				...fixture.cases.map(({ expected }) => `- ${expected}`),
				"</user-profile>",
			].join("\n");
			expect(rendered).toContain(expectedBlock);
		} finally {
			closeQuietly(db);
		}
	});

	it("describes the block and renders no orphan header for an empty profile", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-user-profile-laws-"),
		);
		try {
			// Empty store: no <user-profile> block at all (no orphan header).
			const empty = renderM0Pi(
				{
					...piState("ses-pi-user-profile-laws-empty", cwd),
					userProfileBudgetTokens: 10_000,
				},
				db,
				"",
				1,
				[],
				[],
				[],
			);
			expect(empty).not.toContain("<user-profile>");

			// Non-empty store: the description is the first line inside the block.
			const desc = USER_PROFILE_DESCRIPTION;
			const rendered = renderM0Pi(
				{
					...piState("ses-pi-user-profile-laws-desc", cwd),
					userProfileBudgetTokens: 10_000,
				},
				db,
				"",
				1,
				[],
				[],
				[
					{
						id: 1,
						content: "User prefers terse replies.",
						status: "active",
						promotedAt: 0,
						sourceCandidateIds: [],
						sourceProvenance: null,
						createdAt: 0,
						updatedAt: 0,
					},
				],
			);
			const blockIndex = rendered.indexOf("<user-profile>");
			expect(blockIndex).toBeGreaterThanOrEqual(0);
			const lines = rendered.slice(blockIndex).split("\n");
			expect(lines[1]).toBe(desc);
			expect(lines[2]).toBe("- Prefers terse replies.");
		} finally {
			closeQuietly(db);
		}
	});

	it("normalizes subject prefixes in both m[0] and the new-profile delta", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-user-profile-render-delta-"),
		);
		try {
			const state = {
				...piState("ses-pi-user-profile-render-delta", cwd),
				userProfileBudgetTokens: 10_000,
			};
			insertUserMemory(
				db,
				"User strongly pushes back on untested changes.",
				[],
			);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
			const baseline = materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			expect(baseline.m0).toContain(
				`<user-profile>\n${USER_PROFILE_DESCRIPTION}\n- Strongly pushes back on untested changes.\n</user-profile>`,
			);

			insertUserMemory(db, "User expects changes to be tested.", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 2 });
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: false,
				reason: null,
			});
			const delta = renderM1Pi(
				state,
				db,
				baseline.snapshotMarkers,
				baseline.renderedMemoryIds,
			);
			expect(delta).toContain(
				`<new-user-profile>\n${USER_PROFILE_DESCRIPTION}\n- Strongly pushes back on untested changes.`,
			);
			expect(delta).toContain("- Expects changes to be tested.");
		} finally {
			closeQuietly(db);
		}
	});

	it("profile_render_epoch folds once per template change, then replays (adoption law)", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-user-profile-template-fold-"),
		);
		try {
			const state = {
				...piState("ses-pi-user-profile-template-fold", cwd),
				userProfileBudgetTokens: 10_000,
			};
			insertUserMemory(
				db,
				"User strongly pushes back on untested changes.",
				[],
			);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "region_first_install",
			});
			const stable = mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			});
			expect(stable).toMatchObject({ value: false, reason: null });

			// A row written before the template component existed: the head lane
			// must fold ONCE, adopt the epoch, and stop folding.
			db.exec(
				`UPDATE session_meta SET cached_m0_upgrade_state = replace(cached_m0_upgrade_state, '|profile-render:${PROFILE_RENDER_EPOCH}', '') WHERE session_id = '${state.sessionId}'`,
			);
			const adopted = mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			});
			expect(adopted).toMatchObject({
				value: true,
				reason: "profile_render_epoch",
			});
			materializeM0Pi(state, db, undefined, {
				enabled: true,
				reason: "profile_render_epoch",
			});
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi memory feature gate", () => {
	it("does NOT render project memories into m[0]/m[1] when memoryEnabled=false", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0m1-memgate-"));
		try {
			const base = piState("ses-pi-memgate", cwd);
			// A compartment (history) MUST still render — only memory is gated.
			appendCompartments(db, base.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			insertMemory(db, {
				projectPath: base.projectIdentity,
				category: "ARCHITECTURE",
				content: "project memory must not leak when disabled",
				sourceType: "historian",
			});
			insertUserMemory(db, "profile baseline must not leak", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

			// memoryEnabled=false suppresses every memory-derived surface while
			// retaining compartment history.
			const disabledState = {
				...base,
				memoryEnabled: false,
				mural: {
					enabled: true,
					supportsVision: true,
					dataUrl: "data:image/png;base64,cHJvZmlsZS1tdXJhbA==",
				},
			};
			const off = [userMessage("hello", 10)];
			injectM0M1Pi(disabledState, db, off as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			// Region lane (Unit 7): the panels live in the region bytes; the
			// array is untouched raw messages.
			const offRegion = readSystemRegion(db, disabledState.sessionId) ?? "";
			expect(offRegion).not.toContain(
				"project memory must not leak when disabled",
			);
			expect(offRegion).not.toContain("<project-memory");
			expect(offRegion).not.toContain("<user-profile>");
			expect(offRegion).not.toContain("profile baseline must not leak");
			expect(offRegion).not.toContain("<memory-mural>");
			expect(offRegion).toContain("compartment body present");
			expect(
				off.every(
					(m: { role?: string }) =>
						m.role === "user" &&
						typeof (m as { content?: unknown }).content === "string",
				),
			).toBe(true);

			// A fresh global profile version can request delta work, but its
			// delta must remain absent while the memory surface is disabled:
			// the volatile segment stays empty.
			insertUserMemory(db, "profile delta must not leak", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 2 });
			const refreshed = [userMessage("again", 11)];
			injectM0M1Pi(
				disabledState,
				db,
				refreshed as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const volatileRow = getOrCreateSessionMeta(db, disabledState.sessionId);
			const offVolatile =
				volatileRow.regionVolatileBytes?.toString("utf8") ?? "";
			expect(offVolatile).not.toContain("<new-user-profile>");
			expect(offVolatile).not.toContain("profile delta must not leak");

			// Control: a fresh session with memoryEnabled left on DOES render it,
			// proving the gate (not some other filter) is responsible.
			const onState = piState("ses-pi-memgate-on", cwd);
			appendCompartments(db, onState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "m0",
					endMessageId: "m0",
					title: "history",
					content: "U: a turn\ncompartment body present",
				},
			]);
			const on = [userMessage("hello", 10)];
			injectM0M1Pi(onState, db, on as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(readSystemRegion(db, onState.sessionId) ?? "").toContain(
				"project memory must not leak when disabled",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("uses the system-hash HARD path for a memory-on to memory-off transition", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-memory-off-transition-"),
		);
		try {
			const state = piState("ses-pi-memgate-transition", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "transition project fact",
			});
			insertUserMemory(db, "transition profile fact", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

			const on = [userMessage("before", 10)];
			injectM0M1Pi(
				{
					...state,
					memoryEnabled: true,
					hardSignals: {
						systemHash: "memory-guidance-on",
						modelKey: "test/model",
					},
				},
				db,
				on as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"transition profile fact",
			);

			const offState = {
				...state,
				memoryEnabled: false,
				hardSignals: {
					systemHash: "memory-guidance-off",
					modelKey: "test/model",
				},
			};
			const off = [userMessage("after", 11)];
			const transition = injectM0M1Pi(
				offState,
				db,
				off as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(transition.m0Materialized).toBe(true);
			expect(readSystemRegion(db, offState.sessionId) ?? "").not.toContain(
				"transition profile fact",
			);

			const defer = [userMessage("still off", 12)];
			const replay = injectM0M1Pi(
				offState,
				db,
				defer as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(replay.m0Materialized).toBe(false);
			expect(readSystemRegion(db, offState.sessionId) ?? "").not.toContain(
				"transition profile fact",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("keeps the memory-on m[0]/m[1] shape byte-identical", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-memory-on-shape-"),
		);
		try {
			const state = piState("ses-pi-memgate-shape", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "memory-on project fact",
			});
			insertUserMemory(db, "memory-on profile fact", []);
			setProjectState(db, "__global__", { projectUserProfileVersion: 1 });

			const defaultRender = materializeM0Pi(state, db);
			const explicitlyEnabledRender = materializeM0Pi(
				{ ...state, memoryEnabled: true },
				db,
			);
			expect(explicitlyEnabledRender.m0).toBe(defaultRender.m0);
			expect(explicitlyEnabledRender.m1).toBe(defaultRender.m1);
			expect(defaultRender.m0).toContain("memory-on profile fact");
			expect(defaultRender.m0).toContain("memory-on project fact");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("injectM0M1Pi", () => {
	it("keeps project memory but removes compartment rendering and trim in compaction-off mode", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-compaction-off-"),
		);
		try {
			const offState = {
				...piState("ses-pi-compaction-off", cwd),
				compactionOff: true,
			};
			appendCompartments(db, offState.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-entry",
					endMessageId: "old-entry",
					title: "old history",
					content: "compartment-only history must stay off the wire",
				},
			]);
			insertMemory(db, {
				projectPath: offState.projectIdentity,
				category: "ARCHITECTURE",
				content: "compaction-off memory survives",
				sourceType: "historian",
			});
			const messages = [
				userMessage("raw history stays visible", 10),
				userMessage("live tail", 11),
			];
			const result = injectM0M1Pi(
				offState,
				db,
				messages as never,
				["old-entry", "live-entry"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			const offRegion = readSystemRegion(db, offState.sessionId) ?? "";
			expect(offRegion).toContain("compaction-off memory survives");
			expect(offRegion).not.toContain("<session-history>");
			expect(offRegion).not.toContain(
				"compartment-only history must stay off the wire",
			);
			expect(result.skippedVisibleMessages).toBe(0);
			expect(textOf(messages.at(-1) as never)).toBe("live tail");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("renders first-pass m[0] with no inner content and m[1] placeholder", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0m1-empty-"));
		try {
			const messages = [userMessage("hello", 10)];
			injectM0M1Pi(
				piState("ses-pi-empty", cwd),
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			// Region lane (Unit 7): the region row is the empty panels; the
			// volatile segment is "" (no placeholder duty — the absorbed
			// state serves no tail).
			expect(readSystemRegion(db, "ses-pi-empty")).toBe(
				"<session-history></session-history>",
			);
			const emptyMeta = getOrCreateSessionMeta(db, "ses-pi-empty");
			expect(emptyMeta.regionVolatileBytes).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("reads project docs once on a HARD fold and replays byte-identical output", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-docs-snapshot-"),
		);
		let reads = 0;
		const restoreObserver = __test.setProjectDocsReadObserverForTests(() => {
			reads += 1;
		});
		try {
			writeFileSync(join(cwd, "AGENTS.md"), "# Stable project rules\n");
			const state = piState("ses-pi-docs-snapshot", cwd);
			const hashPass = (): string => {
				const messages = [userMessage("same user input", 10)];
				injectM0M1Pi(state, db, messages as never, undefined, undefined, {
					systemRegion: { enabled: true, reason: "" },
				});
				return createHash("sha256")
					.update(JSON.stringify(messages))
					.digest("hex");
			};

			const firstHash = hashPass();
			expect(reads).toBe(1);
			expect(hashPass()).toBe(firstHash);
			expect(reads).toBe(1);
		} finally {
			restoreObserver();
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("gates project docs block and hash with injectDocs=false", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0m1-docs-gate-"));
		try {
			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# PI_FLAG_OFF_ARCH_DOCS\nArchitecture bytes must stay out.\n",
			);
			writeFileSync(
				join(cwd, "STRUCTURE.md"),
				"# PI_FLAG_OFF_STRUCTURE_DOCS\nStructure bytes must stay out.\n",
			);
			const state = { ...piState("ses-pi-docs-off", cwd), injectDocs: false };

			const first = [userMessage("hello", 10)];
			const firstResult = injectM0M1Pi(
				state,
				db,
				first as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const firstRegion = readSystemRegion(db, state.sessionId) ?? "";

			expect(firstResult.m0Materialized).toBe(true);
			expect(firstRegion).not.toContain("<project-docs>");
			expect(firstRegion).not.toContain("PI_FLAG_OFF_ARCH_DOCS");
			expect(firstRegion).not.toContain("PI_FLAG_OFF_STRUCTURE_DOCS");
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0ProjectDocsHash,
			).toBe("");
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});

			const second = [userMessage("hello again", 11)];
			const secondResult = injectM0M1Pi(
				state,
				db,
				second as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(secondResult.m0Materialized).toBe(false);
			expect(readSystemRegion(db, state.sessionId) ?? "").toBe(firstRegion);

			const enabledState = piState("ses-pi-docs-on", cwd);
			const enabled = [userMessage("hello docs", 12)];
			injectM0M1Pi(enabledState, db, enabled as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(readSystemRegion(db, enabledState.sessionId) ?? "").toContain(
				"<project-docs>",
			);
			expect(readSystemRegion(db, enabledState.sessionId) ?? "").toContain(
				"PI_FLAG_OFF_ARCH_DOCS",
			);
			expect(readSystemRegion(db, enabledState.sessionId) ?? "").toContain(
				"PI_FLAG_OFF_STRUCTURE_DOCS",
			);
			expect(
				mustMaterializePi(
					{ ...enabledState, injectDocs: false },
					db,
					undefined,
					undefined,
					{ systemRegionMode: true },
				),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("replays byte-stable cached m[0]/m[1] for identical state", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0m1-stable-"));
		try {
			const state = piState("ses-pi-stable", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			const firstM0 = textOf(first[0] as never);
			const firstM1 = textOf(first[1] as never);

			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});

			expect(textOf(second[0] as never)).toBe(firstM0);
			expect(textOf(second[1] as never)).toBe(firstM1);
		} finally {
			closeQuietly(db);
		}
	});

	it("folds a legacy render epoch once, then replays m[0]/m[1] byte-identically", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-render-epoch-"),
		);
		try {
			const state = piState("ses-pi-render-epoch", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("first", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(
				Buffer.from(
					`${SENTINEL}<session-history>legacy renderer bytes</session-history>`,
				),
				"pi-m0m1-v2:ready",
				state.sessionId,
			);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: true,
				reason: "compartment_render_epoch",
			});
			const foldedMessages = [userMessage("same", 11)];
			const folded = injectM0M1Pi(
				state,
				db,
				foldedMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const foldedM0 = textOf(foldedMessages[0] as never);
			const foldedM1 = textOf(foldedMessages[1] as never);
			const replay1 = [userMessage("same", 11)];
			const replay2 = [userMessage("same", 11)];
			const replayResult1 = injectM0M1Pi(
				state,
				db,
				replay1 as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const replayResult2 = injectM0M1Pi(
				state,
				db,
				replay2 as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("compartment_render_epoch");
			expect(replayResult1.m0Materialized).toBe(false);
			expect(replayResult2.m0Materialized).toBe(false);
			expect(textOf(replay1[0] as never)).toBe(foldedM0);
			expect(textOf(replay2[0] as never)).toBe(foldedM0);
			expect(textOf(replay1[1] as never)).toBe(foldedM1);
			expect(textOf(replay2[1] as never)).toBe(foldedM1);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
			).toContain(COMPARTMENT_RENDER_EPOCH);
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("replays the pre-epoch memory order on defer and applies recency on one natural HARD", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-memory-epoch-"),
		);
		try {
			const projectIdentity = resolveProjectIdentity(cwd);
			const neverVerified = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "memory alpha record",
				importance: 50,
			});
			const verifiedYesterday = insertMemory(db, {
				projectPath: projectIdentity,
				category: "CONSTRAINTS",
				content: "memory bravo record",
				importance: 50,
			});
			db.prepare(
				"UPDATE memories SET last_seen_at = 1000, verified_at = CASE WHEN id = ? THEN 2000 ELSE NULL END WHERE id IN (?, ?)",
			).run(verifiedYesterday.id, neverVerified.id, verifiedYesterday.id);
			const memories = getMemoriesByProject(db, projectIdentity);
			const budget = Math.max(
				...memories.map((memory) =>
					estimateTokens(renderMemoryBlockV2([memory])),
				),
			);
			const state = {
				sessionId: "ses-pi-memory-epoch",
				projectIdentity,
				projectDirectory: cwd,
				injectionBudgetTokens: budget,
				hardSignals: {
					systemHash: "system",
					modelKey: "provider/old",
					cacheExpired: false,
					lastResponseTime: 0,
				},
			};
			injectM0M1Pi(
				state,
				db,
				[userMessage("first", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const oldMemory = memories.find(
				(memory) => memory.id === neverVerified.id,
			);
			if (!oldMemory) throw new Error("pre-epoch memory fixture missing");
			const oldM0 = Buffer.from(
				`<session-history></session-history>\n\n${renderMemoryBlockV2([oldMemory])}`,
			);
			db.prepare(
				"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_upgrade_state = ? WHERE session_id = ?",
			).run(
				Buffer.concat([Buffer.from(`${SENTINEL}`), oldM0]),
				encodeCachedM0UpgradeIdentity(
					"pi-m0m1-v2:ready",
					COMPARTMENT_RENDER_EPOCH,
					false,
					`m${budget}-h60000`,
					null,
				),
				state.sessionId,
			);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
			const deferMessages = [userMessage("defer", 11)];
			const defer = injectM0M1Pi(
				state,
				db,
				deferMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(defer.m0Materialized).toBe(false);
			expect(readSystemRegion(db, state.sessionId) ?? "").toBe(
				oldM0.toString("utf8"),
			);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
			).not.toContain(MEMORY_RENDER_FORMAT_EPOCH);

			state.hardSignals.modelKey = "provider/new";
			const hardMessages = [userMessage("hard", 12)];
			const hard = injectM0M1Pi(
				state,
				db,
				hardMessages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(hard.m0Materialized).toBe(true);
			expect(hard.m0Reason).toBe("model_change");
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"memory bravo record",
			);
			expect(readSystemRegion(db, state.sessionId) ?? "").not.toContain(
				"memory alpha record",
			);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
			).toContain(MEMORY_RENDER_FORMAT_EPOCH);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("rematerializes m[0] when a LEGACY compartment appears (upgrade_state HARD flip)", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-compartment-"),
		);
		try {
			const state = piState("ses-pi-compartment", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(textOf(first[0] as never)).not.toContain("Compacted setup");

			// A LEGACY compartment (no p1 tier → legacy=1) flips upgrade_state
			// "ready"→"legacy", which is a genuine HARD trigger (the session now
			// needs a /ctx-recomp rebuild). This is NOT the new-compartment path — a
			// v2 compartment (with p1) is a SOFT m[1] delta and does NOT re-
			// materialize m[0] (see the SOFT-delta test below). Asserting the legacy
			// HARD path here keeps the upgrade-detection contract pinned.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			const second = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, second as never, ["entry-1"], undefined, {
				systemRegion: { enabled: true, reason: "" },
			});

			// The region re-materialized and carries the compartment heading;
			// the body is present because the U: line keeps the legacy row at
			// P3.
			const flipRegion = readSystemRegion(db, state.sessionId) ?? "";
			expect(flipRegion).toContain("## 1-1 · Setup");
			expect(flipRegion).toContain("Compacted setup");
			expect(
				getOrCreateSessionMeta(db, state.sessionId).regionVolatileBytes,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("SOFT m[1] refresh keeps the cached m[0] sha256 unchanged while publishing a new compartment", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-soft-delta-"),
		);
		try {
			const state = piState("ses-pi-soft-delta", cwd);
			// First v2 compartment (p1 present → legacy=0, upgrade_state stays
			// "ready"). Materialize the m[0] baseline.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "First",
					content: "U: first turn\nfirst compartment body",
					p1: "U: first turn\nfirst compartment body",
				},
			]);
			const firstPass = [userMessage("hello", 10)];
			const r0 = injectM0M1Pi(
				state,
				db,
				firstPass as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(r0.m0Materialized).toBe(true);
			const baselineM0 = readSystemRegion(db, state.sessionId) ?? "";
			const baselineM0Sha = createHash("sha256")
				.update(baselineM0)
				.digest("hex");
			expect(baselineM0).toContain("first compartment body");

			// Historian publishes a SECOND v2 compartment (the delta). This is the
			// exact scenario the taxonomy fix targets: it MUST ride m[1], not fold
			// m[0].
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 2,
					endMessage: 2,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Delta",
					content: "U: second turn\nsecond compartment body",
					p1: "U: second turn\nsecond compartment body",
				},
			]);

			// Cache-busting pass (history refresh): recomputeM1ThisPass=true.
			const secondPass = [
				userMessage("covered-0", 10), // entry-0 → already baseline
				userMessage("covered-1", 11), // entry-1 → new compartment, must trim
				userMessage("keep", 12), // live tail → must survive
			];
			const r1 = injectM0M1Pi(
				state,
				db,
				secondPass as never,
				["entry-0", "entry-1", "keep"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			// (a) The fold does NOT re-materialize — the publish is a demoted
			// delta (SOFT).
			expect(r1.m0Materialized).toBe(false);
			// (b) The region bytes are byte-identical to the baseline (the
			// whole point of the split: the stable prefix stays cached).
			const regionAfter = readSystemRegion(db, state.sessionId) ?? "";
			const refreshedRegionSha = createHash("sha256")
				.update(regionAfter)
				.digest("hex");
			expect(refreshedRegionSha).toBe(baselineM0Sha);
			expect(regionAfter).not.toContain("second compartment body");
			// (c) The new compartment is the VOLATILE segment's business: the
			// bust-lane recompute (pipeline) surfaces it; the inject itself
			// leaves the segment exactly as the fold wrote it.
			const volatileAfter =
				getOrCreateSessionMeta(
					db,
					state.sessionId,
				).regionVolatileBytes?.toString("utf8") ?? "";
			expect(volatileAfter).not.toContain("second compartment body");
			// (d) The trim is fold-owned: it advanced only to the baseline
			// boundary (entry-0); the new compartment's raw messages stay
			// until a fold covers them.
			expect(r1.skippedVisibleMessages).toBe(1);
			expect(textOf(secondPass[0] as never)).toBe("covered-1");
			expect(textOf(secondPass[secondPass.length - 1] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with NULL required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-null-marker-"),
		);
		try {
			const state = piState("ses-pi-null-marker", cwd);
			const first = [userMessage("hello", 10)];
			injectM0M1Pi(state, db, first as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});

			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const second = [userMessage("hello", 10)];
			const result = injectM0M1Pi(
				state,
				db,
				second as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"<session-history>",
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps legacy cached max seq 0 when a real seq-0 compartment exists", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-legacy-zero-real-"),
		);
		try {
			const state = piState("ses-pi-legacy-zero-real", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Seq Zero",
					content: "U: first turn\nseq zero body",
				},
			]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			// Legacy rows persisted 0 both for empty snapshots and for a real seq-0
			// baseline. With a compartment present, 0 is unambiguous and must remain
			// the cached watermark, not be reinterpreted as the empty -1 sentinel.
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(false);
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"seq zero body",
			);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).regionVolatileBytes,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("normalizes legacy cached max seq 0 to empty only with zero compartments", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-legacy-zero-empty-"),
		);
		try {
			const state = piState("ses-pi-legacy-zero-empty", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				"UPDATE session_meta SET cached_m0_max_compartment_seq = 0 WHERE session_id = ?",
			).run(state.sessionId);

			expect(getCompartments(db, state.sessionId)).toHaveLength(0);
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(false);
			expect(readSystemRegion(db, state.sessionId)).toBe(
				"<session-history></session-history>",
			);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).regionVolatileBytes,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("routes cached m[0] with any partial required marker through guarded rematerialize", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-partial-marker-"),
		);
		try {
			const state = piState("ses-pi-partial-marker", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			db.prepare(
				"UPDATE session_meta SET cached_m0_materialized_at = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: true,
				reason: "cache_invalid",
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("rematerializes instead of reusing cached m[0] when compartment boundary is NULL", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-null-boundary-"),
		);
		try {
			const state = piState("ses-pi-null-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Boundary",
					content: "U: boundary turn\nboundary body",
				},
			]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				"UPDATE session_meta SET cached_m0_last_baseline_end_message_id = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: true,
				reason: "cache_invalid",
			});
			const messages = [userMessage("covered", 10), userMessage("keep", 11)];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				["entry-0", "keep"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("cache_invalid");
			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[0] as never)).toBe("keep");
		} finally {
			closeQuietly(db);
		}
	});

	it("reuses cached m[0] (no rematerialize loop) when the compartment is legitimately boundaryless", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-empty-boundary-"),
		);
		try {
			const state = piState("ses-pi-empty-boundary", cwd);
			// A compartment with EMPTY end_message_id is a legitimate state (schema
			// default ''; OpenCode degrades to no-trim). Materialize persists a null
			// boundary for it — which must NOT then be treated as stale-cache and
			// force a rematerialize every pass.
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "",
					endMessageId: "",
					title: "Boundaryless",
					content: "U: turn\nbody",
				},
			]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				[],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			// Cached boundary is null (the compartment has no usable end id), and the
			// LIVE snapshot is also boundaryless → cache is valid, not stale.
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}).value,
			).toBe(false);

			// And a second injection pass reuses the cache (no materialize) and
			// degrades to no-trim rather than looping.
			const pass1Messages = [userMessage("hello", 10)];
			const result1 = injectM0M1Pi(
				state,
				db,
				pass1Messages as never,
				[],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(result1.m0Materialized).toBe(false);
			expect(result1.skippedVisibleMessages).toBe(0);

			const pass2Messages = [userMessage("hello", 10)];
			const result2 = injectM0M1Pi(
				state,
				db,
				pass2Messages as never,
				[],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(result2.m0Materialized).toBe(false);
			expect(result2.m0Reason).toBeNull();

			// Cache-stability invariant: a boundaryless session must render
			// BYTE-IDENTICAL m[0]/m[1] across consecutive reuse passes (no
			// materialize-vs-reuse oscillation). Compare the actual injected
			// synthetic-prefix text, not just the materialized flag.
			expect(textOf(pass2Messages[0] as never)).toBe(
				textOf(pass1Messages[0] as never),
			);
		} finally {
			closeQuietly(db);
		}
	});

	it("retries instead of losing seq-0 compartment published during materialization", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0m1-seq0-race-"));
		try {
			const state = piState("ses-pi-seq0-race", cwd);
			const originalExec = db.exec.bind(db);
			let injectedRace = false;
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE" && !injectedRace) {
					injectedRace = true;
					appendCompartments(db, state.sessionId, [
						{
							sequence: 0,
							startMessage: 1,
							endMessage: 1,
							startMessageId: "entry-0",
							endMessageId: "entry-0",
							title: "First",
							content: "U: first turn\nseq zero body",
						},
					]);
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const passSnapshot = createPiM0M1PassSnapshot({
				db,
				sessionId: state.sessionId,
				compactionOff: false,
			});
			const { m0, snapshotMarkers } = materializeM0PiWithRetry(
				state,
				db,
				3,
				passSnapshot,
			);

			expect(injectedRace).toBe(true);
			expect(snapshotMarkers.maxCompartmentSeq).toBe(0);
			expect(m0).toContain("seq zero body");
		} finally {
			closeQuietly(db);
		}
	});

	it("trims against the frozen cached boundary instead of live rewritten compartments", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-frozen-boundary-"),
		);
		try {
			const state = piState("ses-pi-frozen-boundary", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "old-end",
					endMessageId: "old-end",
					title: "Frozen",
					content: "U: old turn\nfrozen body",
				},
			]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				"UPDATE compartments SET end_message_id = ? WHERE session_id = ? AND sequence = 0",
			).run("too-far", state.sessionId);

			const messages = [
				userMessage("old visible", 10),
				userMessage("must stay", 11),
				userMessage("keep", 12),
			];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				["old-end", "too-far", "keep"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.skippedVisibleMessages).toBe(1);
			expect(textOf(messages[0] as never)).toBe("must stay");
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE error exposes only SQLITE_BUSY code", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-begin-busy-code-"),
		);
		try {
			const state = piState("ses-pi-begin-busy-code", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy Code",
					content: "U: busy code turn\nbusy code fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					const error = new Error("writer unavailable") as Error & {
						code: string;
					};
					error.code = "SQLITE_BUSY";
					throw error;
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(false);
			expect(result.contentionExhausted).toBe(true);
			// Region lane: the losing pass serves the STORED region (the empty
			// install) verbatim and touches no array message.
			expect(readSystemRegion(db, state.sessionId)).toBe(
				"<session-history></session-history>",
			);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).regionVolatileBytes,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("falls back to cached m[0] when BEGIN IMMEDIATE is busy", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m0m1-begin-busy-"),
		);
		try {
			const state = piState("ses-pi-begin-busy", cwd);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 0,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-0",
					endMessageId: "entry-0",
					title: "Busy",
					content: "U: busy turn\nbusy fallback body",
				},
			]);
			const originalExec = db.exec.bind(db);
			db.exec = ((sql: string) => {
				if (sql === "BEGIN IMMEDIATE") {
					throw new Error("SQLITE_BUSY: database is locked");
				}
				return originalExec(sql);
			}) as typeof db.exec;

			const messages = [userMessage("hello", 10)];
			const result = injectM0M1Pi(
				state,
				db,
				messages as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(false);
			expect(result.contentionExhausted).toBe(true);
			expect(readSystemRegion(db, state.sessionId)).toBe(
				"<session-history></session-history>",
			);
			expect(
				getOrCreateSessionMeta(db, state.sessionId).regionVolatileBytes,
			).toBeNull();
		} finally {
			closeQuietly(db);
		}
	});

	it("reconcile rematerialization advances the memory mutation cursor and omits memory-updates", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-m1-reconcile-delta-"),
		);
		try {
			const state = piState("ses-pi-m1-reconcile-delta", cwd);
			const memory = insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Old baseline content.",
				sourceType: "historian",
			});
			injectM0M1Pi(
				state,
				db,
				[userMessage("hello", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				"UPDATE memories SET content = ?, normalized_hash = ?, updated_at = ? WHERE id = ?",
			).run("Reconciled content.", "reconciled-hash", Date.now(), memory.id);
			queueMemoryMutation(db, {
				projectPath: state.projectIdentity,
				mutationType: "update",
				targetMemoryId: memory.id,
				newContent: "Reconciled content.",
				queuedAt: 10,
			});
			setProjectState(db, state.projectIdentity, { projectMemoryEpoch: 1 });

			const bust = [userMessage("bust", 11)];
			const result = injectM0M1Pi(
				state,
				db,
				bust as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(true);
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"Reconciled content.",
			);
			expect(textOf(bust[1] as never)).not.toContain("<memory-updates>");
		} finally {
			closeQuietly(db);
		}
	});
});

describe("renderM0Pi sibling-block layout (OpenCode parity)", () => {
	it("renders <project-memory> as a SIBLING after </session-history>, not nested inside it", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0-siblings-"));
		try {
			const state = piState("ses-pi-siblings", cwd);
			appendCompartments(db, state.sessionId, [
				{
					sequence: 1,
					startMessage: 1,
					endMessage: 1,
					startMessageId: "entry-1",
					endMessageId: "entry-1",
					title: "Setup",
					content: "U: set things up\nCompacted setup",
				},
			]);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "The widget service owns rendering.",
				sourceType: "historian",
			});

			const m0 = renderM0Pi(state, db);

			// The <session-history> wrapper must close BEFORE <project-memory>
			// opens — they are siblings (matches OpenCode renderM0). A nested
			// layout (project-memory inside session-history) is the bug this
			// guards against: it would put different bytes on the wire than
			// OpenCode for identical state.
			const historyClose = m0.indexOf("</session-history>");
			const memoryOpen = m0.indexOf("<project-memory>");
			expect(historyClose).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(-1);
			expect(memoryOpen).toBeGreaterThan(historyClose);
			expect(m0).toContain("<ARCHITECTURE>\n#");
			expect(m0).not.toContain("<memory id=");
			// Compartment body lives INSIDE <session-history>; memory does NOT.
			const historyBlock = m0.slice(
				m0.indexOf("<session-history>"),
				historyClose,
			);
			expect(historyBlock).toContain("Compacted setup");
			expect(historyBlock).not.toContain("widget service");
		} finally {
			closeQuietly(db);
		}
	});

	it("materializeM0Pi binds maxMemoryId watermark to the rendered memory set", () => {
		// Regression for the round-7 HIGH: the persisted maxMemoryId watermark must
		// equal the max id of the memories actually rendered into m[0]. If it were
		// read separately (lower), a memory present in m[0] could also satisfy
		// "id > watermark" and render again in m[1] — duplicated across the split.
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-m0-watermark-"));
		try {
			const state = piState("ses-pi-watermark", cwd);
			for (const content of [
				"The widget service owns rendering.",
				"Orders flow through an async queue.",
				"Sessions use stateless JWT.",
			]) {
				insertMemory(db, {
					projectPath: state.projectIdentity,
					category: "ARCHITECTURE",
					content,
					sourceType: "historian",
				});
			}
			const maxId = getMemoriesByProject(db, state.projectIdentity, [
				"active",
				"permanent",
			]).reduce((m, x) => (x.id > m ? x.id : m), 0);

			const { snapshotMarkers } = materializeM0Pi(state, db);

			expect(maxId).toBeGreaterThan(0);
			expect(snapshotMarkers.maxMemoryId).toBe(maxId);
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD fold binds memory expiry cutoff and materializedAt to one timestamp", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-d16c-"));
		try {
			const state = piState("ses-pi-d16c", cwd);
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "KNOWN_ISSUES",
				content: "Pi D16c expiry-gap memory",
				expiresAt: 10_500,
			});
			insertMemory(db, {
				projectPath: state.projectIdentity,
				category: "ARCHITECTURE",
				content: "Pi D16c permanent anchor",
			});

			const realNow = Date.now;
			const foldAt = 10_000;
			let nowCalls = 0;
			Date.now = () => {
				nowCalls += 1;
				return nowCalls === 1 ? foldAt : 99_000;
			};

			try {
				state.hardSignals = {
					systemHash: "fold-a",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const first = materializeM0Pi(state, db);
				expect(first.m0).toContain("Pi D16c expiry-gap memory");
				expect(first.snapshotMarkers.materializedAt).toBe(foldAt);

				nowCalls = 0;
				state.hardSignals = {
					systemHash: "fold-b",
					modelKey: "model-v1",
					cacheExpired: false,
					lastResponseTime: 0,
				};
				const second = materializeM0Pi(state, db);
				expect(second.m0).toContain("Pi D16c expiry-gap memory");
				expect(
					second.m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
				).toBe(
					first.m0.match(/<project-memory>[\s\S]*?<\/project-memory>/)?.[0],
				);
			} finally {
				Date.now = realNow;
			}
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

describe("mustMaterializePi — SOFT/HARD taxonomy (parity with OpenCode)", () => {
	const baseHard = {
		systemHash: "sys-v1",
		modelKey: "anthropic/opus",
		cacheExpired: false,
		lastResponseTime: 0,
	};

	function compartment(seq: number, body: string) {
		return {
			sequence: seq,
			startMessage: seq,
			endMessage: seq,
			startMessageId: `entry-${seq}`,
			endMessageId: `entry-${seq}`,
			title: `T${seq}`,
			content: body,
			p1: body,
		};
	}

	it("does NOT materialize m[0] on a new compartment (it rides m[1])", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-tax-newcomp-"));
		try {
			const state = {
				...piState("ses-pi-tax-newcomp", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			// Publish a new compartment — the routine historian publish.
			appendCompartments(db, state.sessionId, [compartment(1, "Bravo")]);
			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a model change folds m[0]", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-tax-model-"));
		try {
			const state = {
				...piState("ses-pi-tax-model", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			const switched = {
				...state,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			expect(
				mustMaterializePi(switched, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: true,
				reason: "model_change",
				mismatch: {
					signal: "modelKey",
					cached: "anthropic/opus",
					current: "anthropic/sonnet",
				},
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("HARD: a system-hash change folds m[0]", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-tax-sys-"));
		try {
			const state = {
				...piState("ses-pi-tax-sys", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			expect(
				mustMaterializePi(changed, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: true,
				reason: "system_hash",
				mismatch: {
					signal: "systemHash",
					cached: "sys-v1",
					current: "sys-v2",
				},
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("lazy-adopts a NULL cached project marker without a no-switch HARD fold", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-project-null-a-"),
		);
		const cwdB = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-project-null-b-"),
		);
		try {
			const state = {
				...piState("ses-pi-tax-project-null", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, ["entry-0"], undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			const _baselineM0 = textOf(first[0] as never);

			db.prepare(
				"UPDATE session_meta SET cached_m0_project_identity = NULL WHERE session_id = ?",
			).run(state.sessionId);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
			const noSwitch = [userMessage("same project", 11)];
			const noSwitchResult = injectM0M1Pi(
				state,
				db,
				noSwitch as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(noSwitchResult.m0Materialized).toBe(false);
			expect(noSwitchResult.m0Reason).not.toBe("first_render");
			expect(noSwitchResult.m0Reason).not.toBe("project_change");
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain("T0");
			// The head-era lazy-adopt write is deleted: on the region lane the
			// NULL identity stays until the next genuine fold records it. No
			// fold fires on the no-switch pass itself (parity with OpenCode).

			const switched = {
				...piState(state.sessionId, cwdB),
				hardSignals: baseHard,
			};
			// Region lane (Unit 7): the lazy-adopt WRITE is deleted (it was
			// head-only); a NULL cached identity never folds by itself — the
			// switch fold records the identity when a genuine arm fires.
			expect(
				mustMaterializePi(switched, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("HARD: a genuine same-session project switch folds exactly once, then stabilizes", () => {
		const db = createTestDb();
		const cwdA = createTestTempDirFromPath(join(tmpdir(), "pi-tax-project-a-"));
		const cwdB = createTestTempDirFromPath(join(tmpdir(), "pi-tax-project-b-"));
		try {
			const stateA = {
				...piState("ses-pi-tax-project-switch", cwdA),
				hardSignals: baseHard,
			};
			insertMemory(db, {
				projectPath: stateA.projectIdentity,
				category: "ARCHITECTURE",
				content: "Project A memory must not replay after /cd.",
			});
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(stateA, db, first as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(readSystemRegion(db, stateA.sessionId) ?? "").toContain(
				"Project A memory",
			);

			const stateB = {
				...piState(stateA.sessionId, cwdB),
				hardSignals: baseHard,
			};
			insertMemory(db, {
				projectPath: stateB.projectIdentity,
				category: "ARCHITECTURE",
				content: "Project B memory is the switched project baseline.",
			});

			const switched = [userMessage("after cd", 11)];
			const switchedResult = injectM0M1Pi(
				stateB,
				db,
				switched as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(switchedResult.m0Materialized).toBe(true);
			expect(switchedResult.m0Reason).toBe("project_change");
			const switchedRegion = readSystemRegion(db, stateA.sessionId) ?? "";
			expect(switchedRegion).toContain("Project B memory");
			expect(textOf(switched[0] as never)).not.toContain("Project A memory");

			const stable = [userMessage("after cd stable", 12)];
			const stableResult = injectM0M1Pi(
				stateB,
				db,
				stable as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(stableResult.m0Materialized).toBe(false);
			expect(stableResult.m0Reason).toBeNull();
			// Region lane: the replay stability is the region row — the stable
			// pass serves it byte-identically and touches no array message.
			expect(readSystemRegion(db, stateA.sessionId) ?? "").toBe(switchedRegion);
			expect(textOf(stable[0] as never)).toBe("after cd stable");
		} finally {
			rmSync(cwdA, { recursive: true, force: true });
			rmSync(cwdB, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("model and system changes materialize with classified reasons, not first_render", () => {
		const db = createTestDb();
		const cwdModel = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-model-reason-"),
		);
		const cwdSystem = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-system-reason-"),
		);
		try {
			const modelState = {
				...piState("ses-pi-tax-model-reason", cwdModel),
				hardSignals: baseHard,
			};
			injectM0M1Pi(
				modelState,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const modelChanged = {
				...modelState,
				hardSignals: { ...baseHard, modelKey: "anthropic/sonnet" },
			};
			const modelPass = [userMessage("model", 11)];
			const modelResult = injectM0M1Pi(
				modelChanged,
				db,
				modelPass as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(modelResult.m0Materialized).toBe(true);
			expect(modelResult.m0Reason).toBe("model_change");
			expect(modelResult.m0Reason).not.toBe("first_render");

			const systemState = {
				...piState("ses-pi-tax-system-reason", cwdSystem),
				hardSignals: baseHard,
			};
			injectM0M1Pi(
				systemState,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const systemChanged = {
				...systemState,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const systemPass = [userMessage("system", 11)];
			const systemResult = injectM0M1Pi(
				systemChanged,
				db,
				systemPass as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(systemResult.m0Materialized).toBe(true);
			expect(systemResult.m0Reason).toBe("system_hash");
			expect(systemResult.m0Reason).not.toBe("first_render");
		} finally {
			rmSync(cwdModel, { recursive: true, force: true });
			rmSync(cwdSystem, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("an empty current HARD signal is never treated as a change", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-tax-empty-"));
		try {
			const state = {
				...piState("ses-pi-tax-empty", cwd),
				hardSignals: baseHard,
			};
			appendCompartments(db, state.sessionId, [compartment(0, "Alpha")]);
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			const unknown = {
				...state,
				hardSignals: {
					systemHash: "",
					modelKey: "",
					cacheExpired: false,
					lastResponseTime: 0,
				},
			};
			expect(
				mustMaterializePi(unknown, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("does NOT materialize m[0] on a project docs hash change", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-tax-docs-soft-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-soft", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi docs\n");
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# New Pi docs\n");

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			closeQuietly(db);
		}
	});

	it("folds current project docs on the next natural HARD materialization", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(join(tmpdir(), "pi-tax-docs-hard-"));
		try {
			const state = {
				...piState("ses-pi-tax-docs-hard", cwd),
				hardSignals: baseHard,
			};
			writeFileSync(join(cwd, "ARCHITECTURE.md"), "# Old Pi architecture\n");
			const first = [userMessage("hi", 10)];
			injectM0M1Pi(state, db, first as never, undefined, undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"Old Pi architecture",
			);

			writeFileSync(
				join(cwd, "ARCHITECTURE.md"),
				"# Updated Pi architecture\nFresh Pi docs folded on hard bust.\n",
			);
			const changed = {
				...state,
				hardSignals: { ...baseHard, systemHash: "sys-v2" },
			};
			const second = [userMessage("hi again", 11)];
			const result = injectM0M1Pi(
				changed,
				db,
				second as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			expect(result.m0Materialized).toBe(true);
			expect(result.m0Reason).toBe("system_hash");
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"Updated Pi architecture",
			);
			expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
				"Fresh Pi docs folded on hard bust.",
			);
			expect(textOf(second[0] as never)).not.toContain("Old Pi architecture");
		} finally {
			closeQuietly(db);
		}
	});
	it("reproduces the copied live marker tuple and keeps three canonical-alias replays byte-identical", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-live-marker-repro-"),
		);
		try {
			const state = {
				...piState("019de471-4fdc-762d-9286-624dfad0b5fe", cwd),
				projectIdentity: "git:f78f6db52b23c81d58dae3879c9383f550ec180e",
				injectionBudgetTokens: 15_000,
				historyBudgetTokens: 27_540,
				muralEnabled: true,
				hardSignals: {
					...baseHard,
					systemHash: "38b2cc92af20c9236054057c7da1a3df",
					modelKey: "openai-codex/gpt-5.6-sol",
				},
			};
			appendCompartments(db, state.sessionId, [
				{
					sequence: 417,
					startMessage: 417,
					endMessage: 417,
					startMessageId: "entry-417",
					endMessageId: "entry-417",
					title: "Cached production boundary",
					content: "cached production compartment",
					p1: "cached production compartment",
				},
			]);
			db.prepare(
				"INSERT INTO m0_mutation_log (id, session_id, mutation_type, target_id, queued_at) VALUES (15, ?, 'compartment_upgrade', NULL, 1)",
			).run(state.sessionId);
			const firstMessages = [userMessage("same quiet tail", 10)];
			injectM0M1Pi(state, db, firstMessages as never, ["entry-0"], undefined, {
				systemRegion: { enabled: true, reason: "" },
			});
			appendCompartments(db, state.sessionId, [
				{
					sequence: 425,
					startMessage: 425,
					endMessage: 425,
					startMessageId: "entry-425",
					endMessageId: "entry-425",
					title: "Live additive compartment",
					content: "new m1-only content after the cached boundary",
					p1: "new m1-only content after the cached boundary",
				},
			]);
			const firstRegion = readSystemRegion(db, state.sessionId) ?? "";
			const meta = getOrCreateSessionMeta(db, state.sessionId);
			expect(meta.cachedM0ModelKey).toBe("openai/gpt-5.6-sol");
			expect(meta.cachedM0MaxCompartmentSeq).toBe(417);
			expect(meta.cachedM0MaxMutationId).toBe(15);
			expect(meta.cachedM0UpgradeState).toContain("mural-enabled:1");
			expect(meta.cachedM0UpgradeState).toContain(
				"render-budgets:m15000-h27540",
			);

			for (let pass = 0; pass < 3; pass += 1) {
				const messages = [userMessage("same quiet tail", 10)];
				const result = injectM0M1Pi(
					state,
					db,
					messages as never,
					["entry-0"],
					undefined,
					{ systemRegion: { enabled: true, reason: "" } },
				);
				expect(result.m0Materialized).toBe(false);
				expect(result.m0Reason).toBeNull();
				expect(readSystemRegion(db, state.sessionId) ?? "").toBe(firstRegion);
			}

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
			// Region-lane exemption (Unit 7): a flag-UNSET state means "not
			// observed this pass" — no fold; the flip fires on an explicit flag.
			expect(
				mustMaterializePi(
					{ ...state, muralEnabled: undefined },
					db,
					undefined,
					undefined,
					{ systemRegionMode: true },
				),
			).toEqual({ value: false, reason: null });
			expect(
				mustMaterializePi(
					{ ...state, muralEnabled: false },
					db,
					undefined,
					undefined,
					{ systemRegionMode: true },
				),
			).toEqual({
				value: true,
				reason: "render_config:mural(true→false)",
				mismatch: { signal: "muralEnabled", cached: true, current: false },
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not hard-fold when the current model switches from canonical to Pi alias spelling", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-model-alias-forward-"),
		);
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-forward", cwd),
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			const aliasOnly = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			expect(
				mustMaterializePi(aliasOnly, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("persists a Pi-native baseline canonically, then accepts the reverse spelling flip", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-model-alias-reverse-"),
		);
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-reverse", cwd),
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(getOrCreateSessionMeta(db, state.sessionId).cachedM0ModelKey).toBe(
				"openai/gpt-5.6-sol",
			);

			const aliasOnly = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			expect(
				mustMaterializePi(aliasOnly, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("does not hard-fold when an existing cached baseline stores a native alias", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-model-alias-upgrade-"),
		);
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-upgrade", cwd),
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-sol" },
			};
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			db.prepare(
				"UPDATE session_meta SET cached_m0_model_key = ? WHERE session_id = ?",
			).run("openai-codex/gpt-5.6-sol", state.sessionId);

			expect(
				mustMaterializePi(state, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toEqual({
				value: false,
				reason: null,
			});
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});

	it("folds exactly once for a genuinely different model in the same alias family", () => {
		const db = createTestDb();
		const cwd = createTestTempDirFromPath(
			join(tmpdir(), "pi-tax-model-alias-real-switch-"),
		);
		try {
			const state = {
				...piState("ses-pi-tax-model-alias-real-switch", cwd),
				hardSignals: { ...baseHard, modelKey: "openai-codex/gpt-5.6-sol" },
			};
			injectM0M1Pi(
				state,
				db,
				[userMessage("hi", 10)] as never,
				["entry-0"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);

			const realSwitch = {
				...state,
				hardSignals: { ...baseHard, modelKey: "openai/gpt-5.6-codex" },
			};
			expect(
				mustMaterializePi(realSwitch, db, undefined, undefined, {
					systemRegionMode: true,
				}),
			).toMatchObject({
				value: true,
				reason: "model_change",
				mismatch: {
					signal: "modelKey",
					cached: "openai/gpt-5.6-sol",
					current: "openai/gpt-5.6-codex",
				},
			});
			const folded = injectM0M1Pi(
				realSwitch,
				db,
				[userMessage("switch", 11)] as never,
				["entry-1"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			const replay = injectM0M1Pi(
				realSwitch,
				db,
				[userMessage("switch", 11)] as never,
				["entry-1"],
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(folded.m0Materialized).toBe(true);
			expect(folded.m0Reason).toBe("model_change");
			expect(replay.m0Materialized).toBe(false);
			expect(replay.m0Reason).toBeNull();
		} finally {
			rmSync(cwd, { recursive: true, force: true });
			closeQuietly(db);
		}
	});
});

it("Fable HARD history uses the real-token budget in Pi", () => {
	const db = createTestDb();
	try {
		const compartments = Array.from({ length: 52 }, (_, i) => ({
			startMessage: i + 1,
			endMessage: i + 1,
			title: `Arc ${i}`,
			content: "",
			p1: "P1 summary code decision result ".repeat(640),
			p2: "P2 summary code decision result ".repeat(320),
			p3: "P3 summary code decision result ".repeat(160),
			p4: "P4 summary code decision result ".repeat(48),
			importance: 50,
			legacy: 0,
		}));
		const state = {
			sessionId: "calibration-history",
			projectIdentity: "",
			projectDirectory: "",
			memoryEnabled: false,
			injectDocs: false,
			historyBudgetTokens: 60000,
			hardSignals: {
				modelKey: "anthropic/claude-fable-5-1",
				systemHash: "",
				cacheExpired: false,
				lastResponseTime: 0,
			},
		};
		const actual = renderM0Pi(state, db, "", 1, [], compartments, []);
		const expected = renderM0Pi(
			{
				...state,
				historyBudgetTokens: 38173,
				hardSignals: { ...state.hardSignals, modelKey: "unknown/neutral" },
			},
			db,
			"",
			1,
			[],
			compartments,
			[],
		);
		expect(actual).toBe(expected);
		expect(actual).not.toBe(
			renderM0Pi(
				{
					...state,
					hardSignals: { ...state.hardSignals, modelKey: "unknown/neutral" },
				},
				db,
				"",
				1,
				[],
				compartments,
				[],
			),
		);
	} finally {
		closeQuietly(db);
	}
});

it("Pi keeps policy-identified m0 frozen as live budgets rise and folds a policy edit once", () => {
	const db = createTestDb();
	try {
		const state = {
			...piState("ses-pi-policy", ""),
			historyBudgetTokens: 13762,
			historyBudgetPolicyIdentity: "p0.15:percentage:40",
		};
		const first = injectM0M1Pi(
			state,
			db,
			[userMessage("seed", 1)] as never,
			undefined,
			undefined,
			{ systemRegion: { enabled: true, reason: "" } },
		);
		expect(first.m0Materialized).toBe(true);
		const baseline = getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes;
		for (const historyBudgetTokens of [15670, 16200, 16800]) {
			const replay = injectM0M1Pi(
				{ ...state, historyBudgetTokens },
				db,
				[userMessage("grow", 2)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			);
			expect(replay.m0Materialized).toBe(false);
			expect(getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes).toEqual(
				baseline,
			);
		}
		const edited = {
			...state,
			historyBudgetTokens: 22400,
			historyBudgetPolicyIdentity: "p0.2:percentage:40",
		};
		expect(
			mustMaterializePi(edited, db, undefined, undefined, {
				systemRegionMode: true,
			}).reason,
		).toContain("render_config:budget(");
		expect(
			injectM0M1Pi(
				edited,
				db,
				[userMessage("edit", 3)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			).m0Materialized,
		).toBe(true);
		expect(
			injectM0M1Pi(
				edited,
				db,
				[userMessage("replay", 4)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			).m0Materialized,
		).toBe(false);
	} finally {
		closeQuietly(db);
	}
});

it("Pi adopts legacy numeric history silently and retains absolute memory-budget edits", () => {
	const db = createTestDb();
	try {
		const state = {
			...piState("ses-pi-legacy-policy", ""),
			historyBudgetTokens: 12000,
			injectionBudgetTokens: 4000,
		};
		injectM0M1Pi(
			state,
			db,
			[userMessage("legacy", 1)] as never,
			undefined,
			undefined,
			{ systemRegion: { enabled: true, reason: "" } },
		);
		const current = {
			...state,
			historyBudgetTokens: 16000,
			historyBudgetPolicyIdentity: "p0.15:percentage:40",
		};
		expect(
			mustMaterializePi(current, db, undefined, undefined, {
				systemRegionMode: true,
			}).value,
		).toBe(false);
		expect(
			mustMaterializePi(
				{ ...current, injectionBudgetTokens: 5000 },
				db,
				undefined,
				undefined,
				{ systemRegionMode: true },
			).reason,
		).toBe("render_config:budget(m4000-h12000→m5000-hp0.15:percentage:40)");
		const hard = {
			...current,
			hardSignals: {
				systemHash: "new-system",
				modelKey: "",
				cacheExpired: false,
				lastResponseTime: 0,
			},
		};
		expect(
			injectM0M1Pi(
				hard,
				db,
				[userMessage("hard", 2)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			).m0Materialized,
		).toBe(true);
		expect(
			getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
		).toContain("hp0.15:percentage:40");
	} finally {
		closeQuietly(db);
	}
});

it("Pi review: legacy replay survives restart and only a natural HARD records policy", () => {
	const db = createTestDb();
	try {
		const hardSignals = {
			modelKey: "review/larger-model",
			systemHash: "",
			cacheExpired: false,
			lastResponseTime: 0,
		};
		const legacy = {
			...piState("ses-pi-review-restart", ""),
			historyBudgetTokens: 12000,
			hardSignals,
		};
		injectM0M1Pi(
			legacy,
			db,
			[userMessage("seed", 1)] as never,
			undefined,
			undefined,
			{ systemRegion: { enabled: true, reason: "" } },
		);
		// The crafted legacy row is "written before rendered-budgets joined the
		// identity" relative to the current epoch world: it keeps the trailing
		// profile-render epoch (rows in the wild after the template-epoch ship
		// always carry it) but drops the numeric budgets component.
		const legacyIdentity =
			`${getOrCreateSessionMeta(db, legacy.sessionId).cachedM0UpgradeState?.split("|rendered-budgets:")[0] ?? ""}` +
			`|profile-render:${PROFILE_RENDER_EPOCH}`;
		db.prepare(
			"UPDATE session_meta SET cached_m0_upgrade_state = ? WHERE session_id = ?",
		).run(legacyIdentity, legacy.sessionId);
		const before = getOrCreateSessionMeta(db, legacy.sessionId);
		expect(before.cachedM0UpgradeState).toContain("-h12000");
		for (let restart = 0; restart < 2; restart++) {
			const state = {
				...piState(legacy.sessionId, ""),
				historyBudgetTokens: restart === 0 ? 16000 : 1,
				hardSignals,
				historyBudgetPolicyIdentity: "p0.15:percentage:40",
			};
			expect(
				injectM0M1Pi(
					state,
					db,
					[userMessage("replay", 2)] as never,
					undefined,
					undefined,
					{ systemRegion: { enabled: true, reason: "" } },
				).m0Materialized,
			).toBe(false);
			const after = getOrCreateSessionMeta(db, legacy.sessionId);
			expect(after.cachedM0Bytes).toEqual(before.cachedM0Bytes);
			expect(after.cachedM0UpgradeState).toBe(before.cachedM0UpgradeState);
		}
		const hard = {
			...piState(legacy.sessionId, ""),
			historyBudgetTokens: 100,
			historyBudgetPolicyIdentity: "p0.15:percentage:40",
			hardSignals: {
				modelKey: "review/smaller-model",
				systemHash: "",
				cacheExpired: false,
				lastResponseTime: 0,
			},
		};
		expect(
			mustMaterializePi(hard, db, undefined, undefined, {
				systemRegionMode: true,
			}).reason,
		).toBe("model_change");
		expect(
			injectM0M1Pi(
				hard,
				db,
				[userMessage("hard", 3)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			).m0Materialized,
		).toBe(true);
		expect(
			getOrCreateSessionMeta(db, legacy.sessionId).cachedM0UpgradeState,
		).toContain("-hp0.15:percentage:40");
		expect(
			injectM0M1Pi(
				hard,
				db,
				[userMessage("replay", 4)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			).m0Materialized,
		).toBe(false);
	} finally {
		closeQuietly(db);
	}
});

it("Pi shrinking budget refolds an oversized baseline once with empty m1", () => {
	const db = createTestDb();
	try {
		const state = {
			...piState("ses-pi-review-shrink", ""),
			historyBudgetTokens: 12000,
			historyBudgetPolicyIdentity: "p0.15:percentage:40",
		};
		appendCompartments(db, state.sessionId, [
			{
				sequence: 1,
				startMessage: 1,
				endMessage: 1,
				startMessageId: "seed",
				endMessageId: "seed",
				title: "large baseline",
				content: "",
				p1: "history bytes ".repeat(500),
				p2: "dense",
				p3: "brief",
				p4: "anchor",
				importance: 100,
			},
		]);
		injectM0M1Pi(
			state,
			db,
			[userMessage("seed", 1)] as never,
			undefined,
			undefined,
			{ systemRegion: { enabled: true, reason: "" } },
		);
		const before = getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes;
		expect(before?.toString()).toContain("large baseline");
		const shrink = { ...state, historyBudgetTokens: 1 };
		const resized = injectM0M1Pi(
			shrink,
			db,
			[userMessage("resize", 2)] as never,
			undefined,
			undefined,
			{ systemRegion: { enabled: true, reason: "" } },
		);
		expect(resized.m0Materialized).toBe(true);
		expect(resized.m0Reason).toContain("render_config:budget_shrink(");
		const after = getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes;
		expect(after?.length).toBeLessThan(before?.length ?? 0);
		expect(
			getOrCreateSessionMeta(db, state.sessionId).cachedM0UpgradeState,
		).toContain("|rendered-budgets:");
		for (const _recompute of [false, true, true]) {
			expect(
				injectM0M1Pi(
					shrink,
					db,
					[userMessage("replay", 3)] as never,
					undefined,
					undefined,
					{ systemRegion: { enabled: true, reason: "" } },
				).m0Materialized,
			).toBe(false);
			expect(getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes).toEqual(
				after,
			);
		}
		expect(
			injectM0M1Pi(
				state,
				db,
				[userMessage("growth", 4)] as never,
				undefined,
				undefined,
				{ systemRegion: { enabled: true, reason: "" } },
			).m0Materialized,
		).toBe(false);
		expect(getOrCreateSessionMeta(db, state.sessionId).cachedM0Bytes).toEqual(
			after,
		);
	} finally {
		closeQuietly(db);
	}
});

// Round-2 review C2c: a session row written by the OpenCode-1 frozen-region
// store must never surface as Pi head text. The Pi reader treats sentinel
// rows as absent (fold/first-render path), never as content.
describe("frozen-region cross-lane discrimination (Pi reader)", () => {
	const SENTINEL = "<!-- mc:system-region v1 -->";

	it("a sentinel row folds instead of serving region bytes as head text", () => {
		const db = createTestDb();
		const state = piState("ses-pi-sentinel", process.cwd());
		// Real materialized cache first: markers are complete, only the
		// bytes are foreign (a region row written by the v1-TS lane).
		materializeM0Pi(state, db);
		db.prepare(
			"UPDATE session_meta SET cached_m0_bytes = ? WHERE session_id = ?",
		).run(
			Buffer.from(`${SENTINEL}\n<project-memory>x</project-memory>`, "utf8"),
			state.sessionId,
		);
		// Region lane (Unit 7): the sentinel row is a VALID region row — it
		// serves verbatim as region bytes (never head text; the head lane is
		// deleted) and needs no fold.
		expect(
			mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			}),
		).toEqual({
			value: false,
			reason: null,
		});
		expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
			"<project-memory>x</project-memory>",
		);
	});

	// Executable control for the caller guard above: neutralizing the
	// !isSystemRegionBytes(cached.cached_m0_bytes) conjunction at the two
	// contention fallbacks makes the FIRST law fail with the reader's
	// /region/ throw instead of a fresh head (verified in review round 5;
	// kept as transcript, not a permanent source-mutating row). The predicate
	// the guard uses is pinned directly:
	it("G1: the guard predicate discriminates the region row shape", () => {
		expect(isSystemRegionBytes(Buffer.from(`${SENTINEL}\nx`, "utf8"))).toBe(
			true,
		);
		expect(isSystemRegionBytes(Buffer.from("<session-history>x", "utf8"))).toBe(
			false,
		);
		expect(isSystemRegionBytes(null)).toBe(false);
	});

	it("control: the same cache with its own head bytes is not invalid", () => {
		const db = createTestDb();
		const state = piState("ses-pi-headlane", process.cwd());
		materializeM0Pi(state, db);
		expect(
			mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			}).reason,
		).not.toBe("cache_invalid");
	});
});

// Round-6 review H3, superseded by Stage P2 (design §23 D6): the trim law
// is now fold-co-residence — a boundary may drive trimming on a region row
// ONLY when written by the fold rotation transaction (bytes + markers +
// boundary under one BEGIN IMMEDIATE in materializeM0Pi). The funnel's
// direct writers null the head-era boundary at the write site, so no
// funnel-written row reaches the reader with a boundary; the reader keeps
// its refusal for rows the funnel reader cannot serve (corrupt). The
// head-lane refusal stands. Out-of-band SQL that re-pairs a boundary with
// a region row is outside the production writer set and is held by the
// region-writer census (system-region-pi-census.test.ts).
it("H3: a funnel-written region (boundary NULLed at the write site) must not drive trimming", () => {
	const db = createTestDb();
	const state = piState("ses-pi-trim-region", process.cwd());
	const sessionId = state.sessionId;
	const {
		appendCompartments,
	} = require("@magic-context/core/features/magic-context/compartment-storage");
	appendCompartments(db, sessionId, [
		{
			sequence: 1,
			startMessage: 1,
			endMessage: 1,
			startMessageId: "m1-id",
			endMessageId: "m2-id",
			title: "Covered",
			content: "U: covered\ncompartment body",
		},
	]);
	// Head-era row: real head bytes, m1 payload, live boundary "m2-id".
	db.prepare("INSERT INTO session_meta (session_id) VALUES (?)").run(sessionId);
	db.prepare(
		`UPDATE session_meta
			    SET cached_m0_bytes = ?, cached_m1_bytes = ?,
			        cached_m0_last_baseline_end_message_id = ?
			  WHERE session_id = ?`,
	).run(
		Buffer.from("<session-history>baseline</session-history>", "utf8"),
		Buffer.from("<session-history-since>delta</session-history-since>", "utf8"),
		"m2-id",
		sessionId,
	);
	const messages = [
		userMessage("covered"),
		userMessage("covered2"),
		userMessage("live tail"),
	];
	const ids = ["m1-id", "m2-id", "m3-id"];
	// Instrument sanity: the boundary is live and the head row trims.
	expect(
		trimPiMessagesToCachedBoundary(db, sessionId, [...messages], [...ids]),
	).toBeGreaterThan(0);
	// Convert to a region row through the store's writer (the shape the
	// reviewer named: install without touching head-era columns).
	const {
		writeSystemRegion,
	} = require("@magic-context/core/features/magic-context/system-region");
	writeSystemRegion(db, sessionId, "<project-memory>frozen</project-memory>");
	// Write-site property: the head-era boundary column is gone.
	expect(
		(
			db
				.prepare(
					"SELECT cached_m0_last_baseline_end_message_id AS b FROM session_meta WHERE session_id = ?",
				)
				.get(sessionId) as { b: string | null }
		).b,
	).toBeNull();
	// Reader property: a funnel-written region has no boundary to derive
	// from — trim declines (no fold ever wrote this pair).
	expect(
		trimPiMessagesToCachedBoundary(db, sessionId, [...messages], [...ids]),
	).toBe(0);
	// Reader refusal keeps its force for unservable region rows: an
	// out-of-band boundary re-seeded behind a CORRUPT region must not trim.
	db.prepare(
		"UPDATE session_meta SET cached_m0_bytes = ?, cached_m0_last_baseline_end_message_id = ? WHERE session_id = ?",
	).run(
		Buffer.concat([
			Buffer.from("<!-- mc:system-region v1 -->\n", "utf8"),
			Buffer.from([0xed, 0xa0, 0x80]),
		]),
		"m2-id",
		sessionId,
	);
	expect(
		trimPiMessagesToCachedBoundary(db, sessionId, [...messages], [...ids]),
	).toBe(0);
});

// Stage P (round 10): property closure at the Pi row READER. All cached_m0
// consumers derive their decisions from the pass-snapshot row (context-handler
// firstRenderBust) or the replay pair (applyCachedPiRow) — a region-shaped m0
// must present as ABSENT at the reader, making every truthiness decision
// structurally correct (L1 boot-is-replay for region rows: the head lane
// behaves exactly as a first render).
describe("pi region-discrimination: row reader property closure (stage P)", () => {
	const REGION_SENTINEL = "<!-- mc:system-region v1 -->";

	function regionRow(db: ReturnType<typeof createTestDb>, sessionId: string) {
		db.prepare(
			"UPDATE session_meta SET cached_m0_bytes = ?, cached_m1_bytes = NULL WHERE session_id = ?",
		).run(
			Buffer.from(
				`${REGION_SENTINEL}\n<project-memory>frozen</project-memory>`,
				"utf8",
			),
			sessionId,
		);
	}

	it("the pass snapshot presents a region row as absent (reader-level closure)", () => {
		const db = createTestDb();
		const state = piState("ses-pi-snapshot-region", process.cwd());
		materializeM0Pi(state, db);
		expect(
			createPiM0M1PassSnapshot({ db, sessionId: state.sessionId }).cachedRow,
		).not.toBeNull();
		regionRow(db, state.sessionId);
		expect(
			createPiM0M1PassSnapshot({ db, sessionId: state.sessionId }).cachedRow,
		).toBeNull();
		closeQuietly(db);
	});

	it("control: a head-shaped row still presents its cachedRow to the snapshot", () => {
		const db = createTestDb();
		const state = piState("ses-pi-snapshot-head", process.cwd());
		materializeM0Pi(state, db);
		const snapshot = createPiM0M1PassSnapshot({
			db,
			sessionId: state.sessionId,
		});
		expect(snapshot.cachedRow?.cached_m0_bytes).not.toBeNull();
		expect(
			isSystemRegionBytes(snapshot.cachedRow?.cached_m0_bytes ?? null),
		).toBe(false);
		closeQuietly(db);
	});

	it("L1: a region row leaves the head lane in the first-render decision shape", () => {
		const db = createTestDb();
		const state = piState("ses-pi-l1-region", process.cwd());
		materializeM0Pi(state, db);
		regionRow(db, state.sessionId);
		// Region lane (Unit 7): the region row serves verbatim and the array
		// carries no MC content — the foreign panel never reaches the wire.
		expect(
			mustMaterializePi(state, db, undefined, undefined, {
				systemRegionMode: true,
			}).value,
		).toBe(false);
		const messages = [userMessage("after boot")];
		injectM0M1Pi(state, db, messages, undefined, undefined, {
			systemRegion: { enabled: true, reason: "" },
		});
		expect(textOf(messages[0])).toBe("after boot");
		// The region row serves its own payload verbatim — the deleted head
		// lane was the only path that could decode it as head text.
		expect(readSystemRegion(db, state.sessionId) ?? "").toContain(
			"<project-memory>frozen</project-memory>",
		);
		closeQuietly(db);
	});
});
