/// <reference types="bun-types" />

import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { computeNormalizedHash } from "../../plugin/src/features/magic-context/memory/normalize-hash";
import { resolveProjectIdentity } from "../../plugin/src/features/magic-context/memory/project-identity";
import { TestHarness } from "../src/harness";
import { PiTestHarness } from "../src/pi-harness";

let oc: TestHarness | null = null;
let pi: PiTestHarness | null = null;

afterAll(async () => {
    await pi?.dispose();
    await oc?.dispose();
});

function insertMemory(dbPath: string, projectIdentity: string, sessionId: string | null, content: string) {
    const db = new Database(dbPath);
    try {
        const now = Date.now();
        db.prepare(
            `INSERT INTO memories (
                project_path, category, content, normalized_hash,
                source_session_id, source_type, seen_count, retrieval_count,
                first_seen_at, created_at, updated_at, last_seen_at, status
            ) VALUES (?, 'WORKFLOW_RULES', ?, ?, ?, 'agent', 1, 0, ?, ?, ?, ?, 'active')`,
        ).run(projectIdentity, content, computeNormalizedHash(content), sessionId, now, now, now, now);
    } finally {
        db.close();
    }
}

describe("pi cross harness", () => {
    it("shares project memories between OpenCode and Pi both directions", async () => {
        oc = await TestHarness.create();
        pi = await PiTestHarness.create({ sharedDataDir: oc.opencode.env.dataDir });

        const sharedWorkdir = realpathSync(pathResolve(oc.opencode.env.workdir));
        (pi.env as { workdir: string }).workdir = sharedWorkdir;
        const projectIdentity = resolveProjectIdentity(sharedWorkdir);

        oc.mock.reset();
        oc.mock.setDefault({
            text: "oc bootstrap",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });
        const ocSession = await oc.createSession();
        await oc.sendPrompt(ocSession, "bootstrap opencode shared db");

        pi.mock.reset();
        pi.mock.setDefault({
            text: "pi bootstrap",
            usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 100 },
        });
        const piTurn = await pi.sendPrompt("bootstrap pi shared db", { timeoutMs: 60_000 });
        const piProjectIdentity = resolveProjectIdentity(realpathSync(pathResolve(pi.env.workdir)));

        const dbPath = pi.contextDbPath();
        const fromOpenCode = "OpenCode wrote this memory for Pi flagship search";
        insertMemory(dbPath, projectIdentity, ocSession, fromOpenCode);

        pi.mock.reset();
        pi.mock.script([
            {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_pi_search_oc",
                        name: "ctx_search",
                        input: { query: "flagship search", sources: ["memory"], limit: 5 },
                    },
                ],
                stop_reason: "tool_use",
                usage: { input_tokens: 120, output_tokens: 5, cache_creation_input_tokens: 120 },
            },
            {
                text: "Pi found OpenCode memory",
                usage: { input_tokens: 140, output_tokens: 10, cache_creation_input_tokens: 140 },
            },
        ]);
        const searchTurn = await pi.sendPrompt("search for flagship memory", { timeoutMs: 60_000 });
        expect(searchTurn.stdout).toContain(fromOpenCode);

        const fromPi = "Pi wrote this memory for OpenCode injection";
        insertMemory(dbPath, piProjectIdentity, piTurn.sessionId, fromPi);

        oc.mock.reset();
        oc.mock.setDefault({
            text: "oc sees pi",
            usage: { input_tokens: 130, output_tokens: 10, cache_creation_input_tokens: 130 },
        });
        await oc.sendPrompt(ocSession, "read pi memory from opencode");
        expect(JSON.stringify(oc.mock.lastRequest()!.body)).toContain(fromPi);
    }, 120_000);
});
