/**
 * The dropped-input guard must run through the plugin ENTRY the host loads,
 * not just the runtime hook object: in v0.42.0 the guard existed on the runtime
 * object but the entry wrapper never delegated `tool.execute.before`, so a
 * model copying a `[dropped N]` placeholder into a bash call executed it
 * unblocked on every OpenCode surface. This drives a real tool call carrying
 * the placeholder through a live OpenCode and asserts the tool never ran.
 */
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TestHarness } from "../src/harness";

const USAGE = { input_tokens: 2_000, output_tokens: 20, cache_creation_input_tokens: 0 };

describe("dropped-input guard through the plugin entry", () => {
    let h: TestHarness;
    beforeEach(async () => {
        h = await TestHarness.create({ contextLimit: 200_000 });
    });
    afterEach(async () => {
        await h.dispose();
    });

    it("refuses a bash call whose command is a copied drop placeholder", async () => {
        const sessionId = await h.createSession();
        // A second, harmless argument proves the refusal is per-call, not a
        // coincidence of the command text: it must not appear in any output.
        const marker = "hello-from-a-blocked-call";
        let emitted = false;
        h.mock.addMatcher((body) => {
            if (emitted) return null;
            const tools = Array.isArray(body.tools) ? body.tools : [];
            const bash = tools
                .map((t) => (t && typeof t === "object" ? (t as { name?: unknown }).name : null))
                .find((n) => typeof n === "string" && /(^|_)bash$/.test(n)) as string | undefined;
            if (!bash) return null;
            emitted = true;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: "toolu_dropped_copy_01",
                        name: bash,
                        input: { command: "[dropped §7§]", description: marker },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: USAGE,
            };
        });
        h.mock.setDefault({ text: "done", usage: USAGE });

        await h.sendPrompt(sessionId, "run the thing", { timeoutMs: 90_000 });
        await h.waitForMockQuiescence({ label: "guarded tool turn settles" });
        expect(emitted).toBe(true);

        // The tool part OpenCode persisted must carry the guard's refusal, not a
        // real shell output: the command never executed.
        const opencodeDbPath = ["opencode.db", "opencode-local.db"]
            .map((f) => join(h.opencode.env.dataDir, "opencode", f))
            .find((p) => existsSync(p));
        expect(opencodeDbPath).toBeDefined();
        const db = new Database(opencodeDbPath!, { readonly: true });
        try {
            const rows = db
                .query(
                    "SELECT data FROM part WHERE session_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.callID') = 'toolu_dropped_copy_01'",
                )
                .all(sessionId) as { data: string }[];
            expect(rows.length).toBe(1);
            const state = JSON.parse(rows[0]!.data).state as { status: string; error?: string; output?: string };
            expect(state.status).toBe("error");
            expect(String(state.error ?? state.output ?? "")).toContain("dropped placeholder");
            expect(String(state.error ?? state.output ?? "")).not.toContain(marker);
        } finally {
            db.close();
        }
        // And the model was told how to recover, on the wire of the next request.
        const followUp = h.requests().find((r) => JSON.stringify(r.body).includes("Recover the original arguments with ctx_expand"));
        expect(followUp).toBeDefined();
    }, 120_000);
});
