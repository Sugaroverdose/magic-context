/// <reference types="bun-types" />

/**
 * Rust mode renders workspace-shared memories owned by OTHER projects in
 * <project-memory>, but the module mirrors only the authority project's own
 * rows. Those ids therefore have no module counterpart and never gain one.
 *
 * This scenario drives the real hermetic stack and asserts the three outcomes a
 * reader needs from such an id: a read is served, a mutation is refused with a
 * reason that is honestly permanent, and one such id in a batch no longer costs
 * the caller the ids that did resolve.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { RustTestHarness } from "../src/rust-harness";
import { rustPrereqs } from "../src/rust-scenario-support";

const FOREIGN_PROJECT = "git:0000000000000000000000000000000000000478";
const FOREIGN_SHARED_CONTENT =
    "Shared constraint from a neighbouring project: never hand-edit generated wire fixtures.";

function normalizedHash(content: string): string {
    return createHash("sha256").update(content.trim().toLowerCase()).digest("hex");
}

describe.skipIf(!rustPrereqs.ok)("rust mode workspace-shared memory addressing", () => {
    let h: RustTestHarness;

    beforeEach(async () => {
        h = await RustTestHarness.create({
            startInTsMode: true,
            startHistorianProducer: false,
            magicContextConfig: {
                memory: { enabled: true, injection_budget_tokens: 1_000 },
                embedding: { provider: "off" },
            },
        });
    });

    afterEach(async () => {
        await h?.dispose();
    });

    it(
        "reads a foreign shared id, refuses to mutate it permanently, and reports a mixed batch per id",
        async () => {
            const sessionId = await h.createSession();

            // One TS-mode write bootstraps this project's identity and gives the
            // module a row of its own to mirror.
            let bootstrapWrite = false;
            h.mock.addMatcher((body) => {
                if (
                    bootstrapWrite ||
                    !JSON.stringify(body.system ?? "").includes("## Magic Context")
                ) {
                    return null;
                }
                const tools = Array.isArray(body.tools) ? body.tools : [];
                const memoryTool = tools.find(
                    (tool) =>
                        tool !== null &&
                        typeof tool === "object" &&
                        (tool as { name?: unknown }).name === "ctx_memory",
                ) as { name: string } | undefined;
                if (!memoryTool) return null;
                bootstrapWrite = true;
                return {
                    content: [
                        {
                            type: "tool_use",
                            id: "toolu_shared_memory_bootstrap",
                            name: memoryTool.name,
                            input: {
                                action: "write",
                                category: "CONSTRAINTS",
                                content: "Own project constraint that the module mirrors.",
                            },
                        },
                    ],
                    stop_reason: "tool_use",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 10,
                        cache_creation_input_tokens: 100,
                    },
                };
            });
            await h.sendPrompt(sessionId, "initialize the TypeScript memory store");
            expect(bootstrapWrite).toBe(true);

            const contextDbPath = join(h.env.dataDir, "cortexkit", "magic-context", "context.db");
            const seedDb = new Database(contextDbPath);
            let projectIdentity = "";
            let ownMemoryId = 0;
            let foreignMemoryId = 0;
            try {
                const ownRow = seedDb
                    .prepare("SELECT id, project_path FROM memories ORDER BY id LIMIT 1")
                    .get() as { id: number; project_path: string } | undefined;
                expect(ownRow).toBeTruthy();
                projectIdentity = ownRow?.project_path ?? "";
                ownMemoryId = ownRow?.id ?? 0;

                // A workspace that shares CONSTRAINTS between this project and a
                // neighbour, plus the neighbour's shared memory: exactly the rows
                // <project-memory> renders by host id and the module never mirrors.
                seedDb.transaction(() => {
                    seedDb
                        .prepare(
                            "INSERT INTO workspaces (id, name, created_at, updated_at, share_categories) VALUES (1, 'hermetic-ws', 1, 1, ?)",
                        )
                        .run(JSON.stringify(["CONSTRAINTS"]));
                    const member = seedDb.prepare(
                        "INSERT INTO workspace_members (workspace_id, project_path, display_name, display_path, added_at) VALUES (1, ?, ?, ?, 1)",
                    );
                    member.run(projectIdentity, "Own", projectIdentity);
                    member.run(FOREIGN_PROJECT, "Neighbour", FOREIGN_PROJECT);
                    seedDb
                        .prepare(
                            `INSERT INTO memories(
                                project_path, category, content, normalized_hash, importance, scope,
                                shareable, source_session_id, source_type, seen_count, retrieval_count,
                                first_seen_at, created_at, updated_at, last_seen_at, status,
                                verification_status
                            ) VALUES (?, 'CONSTRAINTS', ?, ?, 60, 'project', 1, ?, 'agent', 1, 0,
                                ?, ?, ?, ?, 'active', 'unverified')`,
                        )
                        .run(
                            FOREIGN_PROJECT,
                            FOREIGN_SHARED_CONTENT,
                            normalizedHash(FOREIGN_SHARED_CONTENT),
                            sessionId,
                            1_800_000_000_000,
                            1_800_000_000_000,
                            1_800_000_000_000,
                            1_800_000_000_000,
                        );
                })();
                foreignMemoryId = (
                    seedDb
                        .prepare("SELECT id FROM memories WHERE project_path = ?")
                        .get(FOREIGN_PROJECT) as { id: number }
                ).id;
            } finally {
                seedDb.close();
            }
            expect(projectIdentity).toBeTruthy();
            expect(foreignMemoryId).toBeGreaterThan(0);

            await h.restart({ rust: true });
            await h.sendPrompt(sessionId, "activate Rust authority over the seeded memories");
            await h.waitForRustPasses(1);

            // The foreign row has no module mapping, by construction.
            const moduleDb = new Database(
                join(h.env.dataDir, "cortexkit", "magic-context", "store.db"),
                { readonly: true },
            );
            try {
                const mirrored = moduleDb
                    .prepare("SELECT COUNT(*) AS count FROM mc_memories WHERE host_row_id = ?")
                    .get(foreignMemoryId) as { count: number };
                expect(mirrored.count).toBe(0);
            } finally {
                moduleDb.close();
            }

            let toolUseCount = 0;
            const invokeMemoryTool = async (
                input: Record<string, unknown>,
                prompt: string,
            ): Promise<string> => {
                h.mock.reset();
                h.mock.setDefault({
                    text: "ok",
                    usage: {
                        input_tokens: 100,
                        output_tokens: 20,
                        cache_creation_input_tokens: 100,
                    },
                });
                let emitted = false;
                h.mock.addMatcher((body) => {
                    if (emitted || !JSON.stringify(body.system ?? "").includes("## Magic Context")) {
                        return null;
                    }
                    const tools = Array.isArray(body.tools) ? body.tools : [];
                    const memoryTool = tools.find(
                        (tool) =>
                            tool !== null &&
                            typeof tool === "object" &&
                            (tool as { name?: unknown }).name === "ctx_memory",
                    ) as { name: string } | undefined;
                    if (!memoryTool) return null;
                    emitted = true;
                    toolUseCount += 1;
                    return {
                        content: [
                            {
                                type: "tool_use",
                                id: `toolu_shared_memory_${toolUseCount}`,
                                name: memoryTool.name,
                                input,
                            },
                        ],
                        stop_reason: "tool_use",
                        usage: {
                            input_tokens: 100,
                            output_tokens: 10,
                            cache_creation_input_tokens: 100,
                        },
                    };
                });
                // Only the messages this call added; an earlier tool result must
                // never satisfy a later assertion.
                const before = (await h.listMessages(sessionId)).length;
                await h.sendPrompt(sessionId, prompt);
                expect(emitted).toBe(true);
                return JSON.stringify((await h.listMessages(sessionId)).slice(before));
            };

            const read = await invokeMemoryTool(
                { action: "get", ids: [foreignMemoryId] },
                "read the shared memory through ctx_memory",
            );
            expect(read).toContain("never hand-edit generated wire fixtures");
            expect(read).not.toContain("has no module mapping yet");

            const mutation = await invokeMemoryTool(
                {
                    action: "update",
                    ids: [foreignMemoryId],
                    content: "this project must not rewrite a neighbour's memory",
                },
                "try to curate the shared memory through ctx_memory",
            );
            expect(mutation).toContain("not owned by this project's module");
            expect(mutation).toContain("retrying will not help");

            const mixed = await invokeMemoryTool(
                { action: "get", ids: [ownMemoryId, foreignMemoryId, 987_654] },
                "read a mixed batch of memory ids through ctx_memory",
            );
            expect(mixed).toContain("Own project constraint that the module mirrors.");
            expect(mixed).toContain("never hand-edit generated wire fixtures");
            expect(mixed).toContain("id 987654: not found or not visible from this project");

            // The neighbour's row is untouched by the refused mutation.
            const verifyDb = new Database(contextDbPath, { readonly: true });
            try {
                const row = verifyDb
                    .prepare("SELECT content FROM memories WHERE id = ?")
                    .get(foreignMemoryId) as { content: string };
                expect(row.content).toBe(FOREIGN_SHARED_CONTENT);
            } finally {
                verifyDb.close();
            }
            expect(toolUseCount).toBe(3);
        },
        300_000,
    );
});
