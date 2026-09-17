import { describe, expect, it } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getProjectEmbeddingSnapshot } from "@magic-context/core/features/magic-context/memory/embedding";
import {
	getProjectEmbeddings,
	peekProjectEmbeddings,
	resetEmbeddingCacheForTests,
} from "@magic-context/core/features/magic-context/memory/embedding-cache";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";
import { createTestTempDir } from "@magic-context/core/shared/test-temp-dir";

import { ensureProjectRegisteredFromPiDirectory } from "./embedding-bootstrap";
import { createTestDb } from "./test-utils.test";

describe("ensureProjectRegisteredFromPiDirectory", () => {
	it("preserves the embedding cache across consecutive identical registrations", async () => {
		const db = createTestDb();
		const oldHome = process.env.HOME;
		const oldConfigHome = process.env.XDG_CONFIG_HOME;
		const directory = createTestTempDir("pi-embedding-bootstrap-").dir;
		const fakeHome = createTestTempDir("pi-embedding-home-").dir;
		process.env.HOME = fakeHome;
		process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
		resetEmbeddingCacheForTests();
		try {
			const projectIdentity = resolveProjectIdentity(directory);

			await ensureProjectRegisteredFromPiDirectory(directory, db);
			const modelId =
				getProjectEmbeddingSnapshot(projectIdentity)?.modelId ?? "off";
			const cached = getProjectEmbeddings(db, projectIdentity, modelId);
			cached.set(42, { embedding: new Float32Array([1, 2, 3]), modelId });

			await ensureProjectRegisteredFromPiDirectory(directory, db);

			expect(peekProjectEmbeddings(projectIdentity, modelId)).toBe(cached);
			expect(peekProjectEmbeddings(projectIdentity, modelId)?.get(42)).toEqual({
				embedding: new Float32Array([1, 2, 3]),
				modelId,
			});
		} finally {
			resetEmbeddingCacheForTests();
			if (oldHome === undefined) {
				delete process.env.HOME;
			} else {
				process.env.HOME = oldHome;
			}
			if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = oldConfigHome;
			closeQuietly(db);
		}
	});

	it("registers the fallback identity when native discovery is unavailable", async () => {
		const db = createTestDb();
		const directory = createTestTempDir("pi-embedding-synapse-").dir;
		const fakeHome = createTestTempDir("pi-embedding-synapse-home-").dir;
		const previous = {
			HOME: process.env.HOME,
			XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
		};
		process.env.HOME = fakeHome;
		process.env.XDG_CONFIG_HOME = path.join(fakeHome, ".config");
		resetEmbeddingCacheForTests();
		try {
			// Provider and SubC settings are user-tier only.
			const configDir = path.join(fakeHome, ".config", "cortexkit");
			await fs.mkdir(configDir, { recursive: true });
			await fs.writeFile(
				path.join(configDir, "magic-context.json"),
				JSON.stringify({
					embedding: { provider: "synapse", fallback_provider: "off" },
					subc: { connection_file: path.join(fakeHome, "absent-subc.json") },
				}),
			);
			const projectIdentity = resolveProjectIdentity(directory);
			await ensureProjectRegisteredFromPiDirectory(directory, db);
			expect(getProjectEmbeddingSnapshot(projectIdentity)?.provider).toBe(
				"off",
			);
			expect(getProjectEmbeddingSnapshot(projectIdentity)?.modelId).not.toMatch(
				/synapse/u,
			);
		} finally {
			resetEmbeddingCacheForTests();
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			closeQuietly(db);
		}
	});
});
