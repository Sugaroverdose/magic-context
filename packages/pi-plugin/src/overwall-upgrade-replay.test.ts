import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	copySessionStateForClone,
	getTagsBySession,
	updateSessionMeta,
	updateTagDropMode,
	updateTagStatus,
} from "@magic-context/core/features/magic-context/storage";
import { getNativeToolInputs } from "@magic-context/core/features/magic-context/storage-native-replay";
import { createTestTempDirFromPath } from "../../plugin/src/shared/test-temp-dir";
import {
	clearContextHandlerSession,
	registerPiContextHandler,
} from "./context-handler";
import {
	GOLDEN_FULL_DROP_CARRIER,
	GOLDEN_FULL_DROP_OUTPUT,
} from "./fpe-wire-golden";
import {
	assistantMessage,
	createFakePi,
	createTestDb,
	fakeContext,
	toolResultMessage,
	userMessage,
} from "./test-utils.test";

function fixture(
	native: boolean,
	count = 200,
	db = createTestDb(),
	session = `review-${native}`,
	remap = false,
) {
	const fake = createFakePi();
	const model = {
		id: "native-upgrade-codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		contextWindow: 100000,
		compat: {
			requiresReasoningContentForAllAssistantTurns: false,
			requiresReasoningContentForToolCalls: false,
		},
	};
	const source = [
		userMessage("first", 1),
		...Array.from({ length: count }, (_, i) => [
			assistantMessage("", 2 + i * 2, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [
					{
						type: "toolCall",
						id: `call-${i}|fc-${i}`,
						name: "read",
						arguments: { path: `original-${i}` },
					},
				],
				...(native
					? {
							providerPayload: {
								type: "openaiResponsesHistory",
								items: [
									{
										type: "function_call",
										id: `fc-${i}`,
										call_id: `call-${i}`,
										name: "read",
										arguments: JSON.stringify({ path: `original-${i}` }),
									},
								],
							},
						}
					: {}),
			}),
			toolResultMessage(`call-${i}|fc-${i}`, `output-${i}`, 3 + i * 2),
		]).flat(),
		userMessage("continue", 1000),
	];
	const ids = source.map((_, i) => `${remap ? "clone-" : ""}entry-${i}`);
	const restart = () => {
		clearContextHandlerSession(session);
		registerPiContextHandler(fake.pi as never, {
			db,
			heuristics: { clearReasoningAge: 100 },
			scheduler: { executeThresholdPercentage: 80 },
		});
	};
	restart();
	const pass = async (percent: number) => {
		updateSessionMeta(db, session, {
			lastResponseTime: Date.now(),
			cacheTtl: "59m",
		});
		const messages = structuredClone(source);
		const handler = fake.handlers.get("context") as unknown as (
			input: { messages: unknown[] },
			ctx: unknown,
		) => Promise<{ messages: unknown[] }>;
		const out = await handler(
			{ messages },
			{
				...fakeContext(session, process.cwd(), ids, messages),
				model,
				getContextUsage: () => ({
					percent,
					tokens: percent * 1000,
					contextWindow: 100000,
				}),
			},
		);
		return out.messages;
	};
	const seed = async () => {
		await pass(0);
		for (const t of getTagsBySession(db, session))
			if (t.type === "tool") {
				updateTagStatus(db, session, t.tagNumber, "dropped");
				updateTagDropMode(db, session, t.tagNumber, "full");
			}
	};
	return {
		db,
		session,
		source,
		ids,
		pass,
		seed,
		restart,
		close: () => {
			clearContextHandlerSession(session);
			db.close();
		},
	};
}
type TranscriptMessage = {
	role: string;
	content?: Array<{ type: string }>;
};
const calls = (m: TranscriptMessage[]) =>
	m.flatMap((x) =>
		x.role === "assistant"
			? (x.content ?? []).filter((p) => p.type === "toolCall")
			: [],
	).length;
// Released-pair args carry a session-keyed FPE token, so they cannot be
// compared across sessions byte-for-byte; seat-equal structure can. Replace
// the toolCall args with a constant so the comparison covers everything else.
const stripCarriers = (m: unknown[]) =>
	JSON.stringify(
		m.map((msg) => {
			const content = (msg as { content?: unknown }).content;
			if (!Array.isArray(content)) return msg;
			return {
				...(msg as object),
				content: content.map((p) => {
					const part = p as { type?: string; arguments?: unknown };
					return part?.type === "toolCall" && part.arguments !== undefined
						? { ...part, arguments: "<carrier>" }
						: p;
				}),
			};
		}),
	);
for (const native of [false, true])
	test(`Q1 200 legacy full ${native ? "native" : "plain"} first defer equals base bytes`, async () => {
		const f = fixture(native);
		try {
			await f.seed();
			const first = await f.pass(0);
			// Legacy `full` markers replay through the shape renderers: every
			// pair survives with a session-keyed FPE token in the copy-source
			// seat and `...` in the result slot. The pre-FPE base fixtures
			// pinned the removed `[dropped §N§]` render, so the bytes here are
			// recomputed and pinned relatively across defer passes and a
			// restart; the released shape is pinned as golden fragments.
			expect(calls(first)).toBe(200);
			expect(getNativeToolInputs(f.db, f.session).size).toBe(0);
			expect(JSON.stringify(first)).toContain(GOLDEN_FULL_DROP_CARRIER);
			expect(JSON.stringify(first)).toContain(GOLDEN_FULL_DROP_OUTPUT);
			if (native) {
				// The Responses raw lane keeps the original argument bytes.
				const kept = (
					first[1] as {
						providerPayload: { items: Array<{ arguments: string }> };
					}
				).providerPayload.items[0]!;
				expect(kept.arguments).toBe(JSON.stringify({ path: "original-0" }));
			}
			const priced = await f.pass(90);
			expect(calls(priced)).toBe(200);
			expect(getNativeToolInputs(f.db, f.session).size).toBe(200);
			const pricedBytes = JSON.stringify(priced);
			if (!native) {
				// With no native transition to persist, the defer pass already
				// served the released bytes: the served prefix never moves.
				expect(JSON.stringify(first)).toBe(pricedBytes);
			}
			expect(JSON.stringify(await f.pass(0))).toBe(pricedBytes);
			f.restart();
			expect(JSON.stringify(await f.pass(0))).toBe(pricedBytes);
		} finally {
			f.close();
		}
	}, 120000);
test("Q2 partial marker batch replays exactly after restart", async () => {
	const f = fixture(true, 10);
	try {
		await f.seed();
		f.db.exec(
			`CREATE TRIGGER partial BEFORE UPDATE OF trailing_blank_decisions ON session_meta WHEN (SELECT count(*) FROM json_each(json_extract(NEW.trailing_blank_decisions, '$.piNative.toolInputs'))) > 5 BEGIN SELECT RAISE(FAIL,'partial failure'); END`,
		);
		const priced = await f.pass(90);
		// The partial write dies mid-document past the fifth marker entry;
		// released pairs stay on the wire regardless, so all ten calls stand.
		expect(getNativeToolInputs(f.db, f.session).size).toBe(5);
		expect(calls(priced)).toBe(10);
		f.db.exec("DROP TRIGGER partial");
		f.restart();
		expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(priced));
		expect(getNativeToolInputs(f.db, f.session).size).toBe(5);
	} finally {
		f.close();
	}
});
test("Q3 cloned native markers survive remapped entry ids", async () => {
	const f = fixture(true, 10);
	try {
		await f.seed();
		const priced = await f.pass(90);
		expect(calls(priced)).toBe(10);
		const result = copySessionStateForClone(f.db, f.session, "review-clone", {
			includeTag: () => true,
			includeMessageId: () => true,
			resolveBoundaryOrdinal: () => 0,
			mapMessageId: (id) => (id.startsWith("entry-") ? `clone-${id}` : id),
			selectPendingPiMarker: () => null,
		});
		expect(result.kind).toBe("migrated");
		expect(getNativeToolInputs(f.db, "review-clone")).toEqual(
			getNativeToolInputs(f.db, f.session),
		);
			const c = fixture(true, 10, f.db, "review-clone", true);
			const deferred = await c.pass(0);
			expect(calls(deferred)).toBe(10);
			// FPE tokens are keyed to the session, so the clone re-renders the
			// released `full` shape under its own token: every pair survives at
			// the same seat and the result slots are byte-identical, while the
			// carrier strings themselves are per-session and not comparable.
			expect(stripCarriers(deferred)).toBe(stripCarriers(priced));
			// Within the clone the bytes are stable across passes.
			expect(JSON.stringify(await c.pass(0))).toBe(
				JSON.stringify(deferred),
			);
			clearContextHandlerSession("review-clone");
	} finally {
		f.close();
	}
});

test("Q2 malformed document after mint retains pairs on restart defer", async () => {
	const f = fixture(true, 10);
	try {
		await f.seed();
		expect(calls(await f.pass(90))).toBe(10);
		f.db
			.prepare(
				"UPDATE session_meta SET trailing_blank_decisions = ? WHERE session_id = ?",
			)
			.run("{", f.session);
		f.restart();
		const deferred = await f.pass(0);
		expect(calls(deferred)).toBe(10);
		expect(JSON.stringify(await f.pass(0))).toBe(JSON.stringify(deferred));
	} finally {
		f.close();
	}
});
test("Q3 Pi filter with remapped entries does not inherit source authorization", async () => {
	const { __test } = await import("./clone-inheritance");
	const f = fixture(true, 10);
	try {
		await f.seed();
		await f.pass(90);
		const entries = f.source.map((message, index) => ({
			type: "message",
			id: `clone-entry-${index}`,
			parentId: index ? `clone-entry-${index - 1}` : null,
			message,
		}));
		const copied = copySessionStateForClone(
			f.db,
			f.session,
			"review-pi-remap",
			__test.createCloneFilter(entries),
		);
		expect(copied.tagsCopied).toBe(0);
		expect(getNativeToolInputs(f.db, "review-pi-remap").size).toBe(0);
		const c = fixture(true, 10, f.db, "review-pi-remap", true);
		expect(calls(await c.pass(0))).toBe(10);
		clearContextHandlerSession("review-pi-remap");
	} finally {
		f.close();
	}
});

	for (const native of [false, true]) {
		test(`identity-preserving Pi forks inherit removal markers (native=${native})`, async () => {
			const { __test } = await import("./clone-inheritance");
			const f = fixture(native, 10);
			const cloneSession = `identity-clone-${native}`;
			try {
				await f.seed();
				const priced = await f.pass(90);
				expect(calls(priced)).toBe(10);
			const entries = f.source.map((message, index) => ({
				type: "message",
				id: f.ids[index],
				parentId: index ? f.ids[index - 1] : null,
				message,
			}));
			const copied = copySessionStateForClone(
				f.db,
				f.session,
				cloneSession,
				__test.createCloneFilter(entries),
			);
			expect(copied.kind).toBe("migrated");
			expect(getNativeToolInputs(f.db, cloneSession)).toEqual(
				getNativeToolInputs(f.db, f.session),
			);
			const clone = fixture(native, 10, f.db, cloneSession);
			const deferred = await clone.pass(0);
			expect(calls(deferred)).toBe(10);
			// Structural equality across the fork; FPE carriers are session-
			// keyed, so they are excluded, and the clone's own bytes stay
			// stable on the next pass.
			expect(stripCarriers(deferred)).toBe(stripCarriers(priced));
			expect(JSON.stringify(await clone.pass(0))).toBe(
				JSON.stringify(deferred),
			);
		} finally {
			clearContextHandlerSession(cloneSession);
			f.close();
		}
	});
}

// The parent runs this case in fresh Bun processes over the same file-backed database.
const childMode = process.env.MC_OVERWALL_RESTART_MODE;
(childMode ? test : test.skip)("removal marker child", async () => {
	const root = process.env.MC_OVERWALL_RESTART_DIR;
	if (!root) throw new Error("missing isolated restart directory");
	const native = process.env.MC_OVERWALL_RESTART_NATIVE === "true";
	const f = fixture(
		native,
		10,
		createTestDb(join(root, "context.db")),
		"process-restart",
	);
	try {
		if (childMode === "mint") await f.seed();
		const messages = await f.pass(childMode === "mint" ? 90 : 0);
		const markers = [...getNativeToolInputs(f.db, f.session)];
		// The marker lane survives; the wire keeps the released pair (token
		// carrier args + `...` result) instead of erasing it.
		expect(calls(messages)).toBe(10);
		expect(JSON.stringify(messages)).toContain(GOLDEN_FULL_DROP_CARRIER);
		expect(JSON.stringify(messages)).toContain(GOLDEN_FULL_DROP_OUTPUT);
		expect(markers).toHaveLength(10);
		expect(
			markers.every(
				([, value]) => value === '{"__magic_context_remove_tool_arc__":true}',
			),
		).toBe(true);
		writeFileSync(
			join(root, `${childMode}.json`),
			JSON.stringify({ messages, markers }),
		);
	} finally {
		f.close();
	}
});

for (const native of [false, true]) {
	test(`removal markers survive a separate-process restart (native=${native})`, () => {
		const root = createTestTempDirFromPath(
			join(tmpdir(), "mc-overwall-restart-"),
		);
		try {
			for (const mode of ["mint", "replay"]) {
				const child = Bun.spawnSync({
					windowsHide: true,
					cmd: [
						process.execPath,
						"test",
						import.meta.path,
						"-t",
						"^removal marker child$",
					],
					cwd: process.cwd(),
					env: {
						...process.env,
						MC_OVERWALL_RESTART_MODE: mode,
						MC_OVERWALL_RESTART_DIR: root,
						MC_OVERWALL_RESTART_NATIVE: String(native),
					},
					stdout: "pipe",
					stderr: "pipe",
					timeout: 30000,
				});
				expect(child.exitCode, new TextDecoder().decode(child.stderr)).toBe(0);
			}
			expect(readFileSync(join(root, "replay.json"), "utf8")).toBe(
				readFileSync(join(root, "mint.json"), "utf8"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 120000);
}
