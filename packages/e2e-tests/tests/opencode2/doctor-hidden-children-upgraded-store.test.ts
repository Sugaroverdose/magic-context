import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { cleanupRetiredHiddenChildren } from "../../../cli/src/commands/doctor-hidden-children";
import { resolveProjectIdentityForSession } from "../../../plugin/src/features/magic-context/memory/project-identity";
import { Database } from "../../../plugin/src/shared/sqlite";
import { MockProvider } from "../../src/mock-provider/server";
import {
	conversionFixture,
	SHARED_MOCK_MODEL_ID,
	SHARED_MOCK_PROVIDER_ID,
	spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

/**
 * `doctor` must clean up retired hidden children on a store OpenCode 2 converted
 * from OpenCode 1 in place, the way a user's store looks after upgrading.
 *
 * OpenCode 2 copies OpenCode 1's sessions into `session_v2` and leaves the old
 * `message` and `part` tables in the same file. Doctor's schema check used to
 * read those tables as "not an OpenCode 2 store" and refused the cleanup with
 * "OpenCode store is not the verified OpenCode 2 session_v2 schema".
 */
interface V1Client {
	session: {
		create(opts: { query: { directory: string } }): Promise<{ data?: { id: string } }>;
		prompt(opts: {
			path: { id: string };
			body: {
				model: { providerID: string; modelID: string };
				parts: Array<{ type: "text"; text: string }>;
			};
		}): Promise<{ data?: { info?: { error?: unknown } } }>;
	};
}

const MAPPER_PROMPT = "memory mapper for the magic-context system";

async function eventually<T>(read: () => T | undefined, what: string, timeoutMs = 45_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(100);
	}
}

function withDb<T>(path: string, read: (db: Database) => T, readwrite = false): T {
	const db = readwrite
		? new Database(path)
		: new Database(path, { readonly: true });
	try {
		return read(db);
	} finally {
		db.close();
	}
}

function retiredChildren(contextDbPath: string): string[] {
	return withDb(contextDbPath, (db) =>
		(
			db
				.prepare("SELECT value FROM schema_migrations_meta WHERE key LIKE 'opencode2_hidden_children:%'")
				.all() as Array<{ value: string }>
		).flatMap(({ value }) =>
			(JSON.parse(value) as { retired_children: Array<{ id: string }> }).retired_children.map(
				(child) => child.id,
			),
		),
	);
}

test("doctor cleans up retired hidden children on a store converted from OpenCode 1", async () => {
	const fixture = conversionFixture("issue-602-upgraded-store");
	const mock = new MockProvider();
	const provider = await mock.start();
	mock.setDefault({ text: "ok", usage: { input_tokens: 200, output_tokens: 10 } });
	let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
	let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
	try {
		// An OpenCode 1 user with one session.
		v1 = await spawnOpencode1({
			fixture,
			mock,
			mockBaseURL: provider.baseURL,
			magicContextConfig: { dreamer: { disable: true }, historian: { disable: true } },
			logLabel: "v1",
		});
		const sdk = await import("@opencode-ai/sdk");
		const client1 = sdk.createOpencodeClient({ baseUrl: v1.url }) as unknown as V1Client;
		const created = await client1.session.create({ query: { directory: fixture.cwd } });
		const v1Session = created.data?.id;
		if (!v1Session) throw new Error("OpenCode 1 did not create a session");
		const turn = await client1.session.prompt({
			path: { id: v1Session },
			body: {
				model: { providerID: SHARED_MOCK_PROVIDER_ID, modelID: SHARED_MOCK_MODEL_ID },
				parts: [{ type: "text", text: "a turn on OpenCode 1" }],
			},
		});
		if (!turn.data || turn.data.info?.error)
			throw new Error(`OpenCode 1 turn failed: ${JSON.stringify(turn)}`);
		await v1.stop();
		v1 = undefined;

		// The same user upgrades: OpenCode 2 converts the store in place and runs a
		// hidden child, which a bare `serve` leaves recorded as retired.
		fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2");
		v2 = await spawnOpencode2({
			existingIsolation: fixture,
			existingMock: { mock, baseURL: provider.baseURL },
			magicContextConfig: {
				dreamer: { tasks: { "map-memories": { schedule: "0 3 * * *" } } },
			},
		});
		const client2 = OpenCode.make({
			baseUrl: v2.url,
			headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
		});
		const session = await client2.session.create({
			title: "after the upgrade",
			location: { directory: fixture.cwd },
			model: { providerID: SHARED_MOCK_PROVIDER_ID, id: SHARED_MOCK_MODEL_ID },
		});
		await waitForPluginActive(client2, fixture.cwd);
		writeFileSync(join(fixture.cwd, "src-fixture.ts"), "export const fixture = true;\n");
		const memoryId = withDb(
			fixture.contextDbPath,
			(db) => {
				const now = Date.now();
				return Number(
					db
						.prepare(
							"INSERT INTO memories (project_path, category, content, normalized_hash, first_seen_at, created_at, updated_at, last_seen_at) VALUES (?, 'ARCHITECTURE', 'The fixture flag lives in src-fixture.ts', 'fixture-flag', ?, ?, ?, ?)",
						)
						.run(resolveProjectIdentityForSession(fixture.cwd, false), now, now, now, now)
						.lastInsertRowid,
				);
			},
			true,
		);
		mock.addMatcher((body) =>
			JSON.stringify(body).includes(MAPPER_PROMPT)
				? {
						text: `<mappings><memory id="${memoryId}" files="src-fixture.ts"/></mappings>`,
						usage: { input_tokens: 120, output_tokens: 20 },
					}
				: null,
		);
		await client2.session.command({ sessionID: session.id, name: "ctx-dream", text: "map-memories" });
		const retired = await eventually(() => {
			const ids = retiredChildren(fixture.contextDbPath);
			return ids.length > 0 ? ids : undefined;
		}, "the hidden child to be recorded as retired");
		await v2.stopHost();
		v2 = undefined;

		// The store really is an in-place conversion: OpenCode 1's tables are still there.
		const tables = withDb(fixture.openCodeDbPath, (db) =>
			(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
				(row) => row.name,
			),
		);
		expect(tables).toEqual(expect.arrayContaining(["session_v2", "session_message", "message", "part"]));
		const hidden = retired.filter((id) =>
			withDb(fixture.openCodeDbPath, (db) =>
				Boolean(db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(id)),
			),
		);
		expect(hidden.length).toBeGreaterThan(0);

		const reports: string[] = [];
		const result = await cleanupRetiredHiddenChildren({
			contextDbPath: fixture.contextDbPath,
			hostDbPath: fixture.openCodeDbPath,
			fix: true,
			// This test process has itself opened both stores to seed and inspect them,
			// which the open-holder check would report. That check has its own tests in
			// the CLI package; this one is about the schema check.
			inspectHolders: () => {},
			report: (line) => reports.push(line),
		});
		expect(reports.join("\n")).toContain("retired hidden sessions are waiting for deletion");
		expect(result.deleted).toBe(hidden.length);
		if (result.backup) rmSync(result.backup, { recursive: true, force: true });
		withDb(fixture.openCodeDbPath, (db) => {
			for (const id of hidden) expect(db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get(id)).toBeNull();
			// The converted OpenCode 1 session and its old rows are untouched.
			expect(db.prepare("SELECT 1 AS present FROM session_v2 WHERE id = ?").get(v1Session)).toEqual({
				present: 1,
			});
			expect(
				(db.prepare("SELECT COUNT(*) AS count FROM message WHERE session_id = ?").get(v1Session) as {
					count: number;
				}).count,
			).toBeGreaterThan(0);
		});
	} finally {
		await v1?.stop();
		await v2?.stopHost();
		await mock.stop();
	}
}, 240_000);
