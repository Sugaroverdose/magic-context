import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import { estimateTokens } from "../../../plugin/src/hooks/magic-context/read-session-formatting";
import { Database } from "../../../plugin/src/shared/sqlite";
import { MockProvider } from "../../src/mock-provider/server";
import {
    conversionFixture,
    SHARED_MOCK_MODEL_ID,
    SHARED_MOCK_PROVIDER_ID,
    spawnOpencode1,
} from "../../src/opencode2-runner/conversion-lane";
import { spawnOpencode2, waitForPluginActive } from "../../src/opencode2-runner/spawn";

const CONTEXT_LIMIT = 24_000;
const OUTPUT_LIMIT = 1_024;
const OVERFLOW_MODEL_ID = "converted-overflow-model";

interface V1Client {
    session: {
        create(opts: { query: { directory: string } }): Promise<{ data?: { id: string } }>;
        prompt(opts: {
            path: { id: string };
            body: {
                model: { providerID: string; modelID: string };
                parts: Array<Record<string, unknown>>;
            };
        }): Promise<{ data?: { info?: { error?: unknown } }; error?: unknown }>;
    };
}

function contextRows<T>(path: string, sql: string, ...params: unknown[]): T[] {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        return db.prepare(sql).all(...params) as T[];
    } finally {
        db.close();
    }
}

function convertedToolArcCount(path: string, sessionId: string, callIds: readonly string[]): number {
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
        const placeholders = callIds.map(() => "?").join(",");
        const row = db
            .prepare(
                `SELECT COUNT(DISTINCT json_extract(part.value, '$.id')) AS count
                   FROM session_message AS message,
                        json_each(message.data, '$.content') AS part
                  WHERE message.session_id = ?
                    AND json_extract(part.value, '$.type') IN ('tool', 'tool-call', 'tool-result')
                    AND json_extract(part.value, '$.id') IN (${placeholders})`,
            )
            .get(sessionId, ...callIds) as { count: number };
        return row.count;
    } finally {
        db.close();
    }
}

function requestTokens(body: Record<string, unknown>): number {
    return estimateTokens(
        JSON.stringify({
            input: body.input ?? body.messages,
            instructions: body.instructions ?? body.system,
            tools: body.tools,
        }),
    );
}

test("the first priced pass reclaims an over-window converted-store tail", async () => {
    const fixture = conversionFixture("converted-store-overwindow-e2e");
    const mock = new MockProvider();
    const provider = await mock.start();
    let v1: Awaited<ReturnType<typeof spawnOpencode1>> | undefined;
    let v2: Awaited<ReturnType<typeof spawnOpencode2>> | undefined;
    try {
        const quiet = { text: "ok", usage: { input_tokens: 1_200, output_tokens: 20 } };
        mock.setDefault(quiet);
        const magicContextConfig = {
            execute_threshold_percentage: 40,
            history_budget_percentage: 0.15,
            memory: { enabled: false },
            historian: { disable: true },
            dreamer: { disable: true },
        };

        v1 = await spawnOpencode1({
            fixture,
            mock,
            mockBaseURL: provider.baseURL,
            magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT,
            modelOutputLimit: OUTPUT_LIMIT,
            logLabel: "v1-overwindow",
        });
        const sdk = await import("@opencode-ai/sdk");
        const client1 = sdk.createOpencodeClient({ baseUrl: v1.url }) as unknown as V1Client;
        const created = await client1.session.create({ query: { directory: fixture.cwd } });
        const sessionId = created.data?.id;
        if (!sessionId) throw new Error("OpenCode 1 did not create the conversion fixture session");

        const callIds = [0, 1, 2].map((index) => `toolu_converted_overwindow_${index}`);
        const files = callIds.map((callId, index) => {
            const path = join(fixture.cwd, `overwindow-${index}.txt`);
            const lines = Array.from(
                { length: 1_200 },
                (_, line) => `${callId} line ${line} ${"payload ".repeat(10)}`,
            );
            writeFileSync(path, `${lines.join("\n")}\n`);
            return path;
        });
        let requestedTool: { callId: string; filePath: string; marker: string } | null = null;
        mock.addMatcher((body) => {
            const bodyText = JSON.stringify(body);
            if (
                !requestedTool ||
                !bodyText.includes(requestedTool.marker) ||
                !bodyText.includes('"name":"read"')
            ) {
                return null;
            }
            const next = requestedTool;
            requestedTool = null;
            return {
                content: [
                    {
                        type: "tool_use",
                        id: next.callId,
                        name: "read",
                        input: { filePath: next.filePath },
                    },
                ],
                stop_reason: "tool_use" as const,
                usage: { input_tokens: 1_200, output_tokens: 20 },
            };
        });

        for (let index = 0; index < callIds.length; index += 1) {
            const turnMarker = `capture converted tool output ${index}`;
            requestedTool = {
                callId: callIds[index]!,
                filePath: files[index]!,
                marker: turnMarker,
            };
            const result = await client1.session.prompt({
                path: { id: sessionId },
                body: {
                    model: {
                        providerID: SHARED_MOCK_PROVIDER_ID,
                        modelID: SHARED_MOCK_MODEL_ID,
                    },
                    parts: [{ type: "text", text: turnMarker }],
                },
            });
            if (!result.data || result.data.info?.error) {
                throw new Error(`OpenCode 1 tool turn failed: ${JSON.stringify(result)}`);
            }
            expect(requestedTool).toBeNull();
        }

        const settle = await client1.session.prompt({
            path: { id: sessionId },
            body: {
                model: {
                    providerID: SHARED_MOCK_PROVIDER_ID,
                    modelID: SHARED_MOCK_MODEL_ID,
                },
                parts: [{ type: "text", text: "settle converted tool tagging" }],
            },
        });
        if (!settle.data || settle.data.info?.error) {
            throw new Error(`OpenCode 1 settle turn failed: ${JSON.stringify(settle)}`);
        }

        const taggedBefore = contextRows<{ messageId: string; status: string }>(
            fixture.contextDbPath,
            `SELECT message_id AS messageId, status FROM tags
              WHERE session_id = ? AND type = 'tool' AND message_id IN (?, ?, ?)
              ORDER BY message_id`,
            sessionId,
            ...callIds,
        );
        expect(taggedBefore).toHaveLength(callIds.length);
        expect(taggedBefore.every((row) => row.status === "active")).toBe(true);
        const beforeTokens = Math.max(...mock.requests().map((request) => requestTokens(request.body)));
        expect(beforeTokens).toBeGreaterThan(CONTEXT_LIMIT);

        await v1.stop();
        v1 = undefined;
        fixture.env.MAGIC_CONTEXT_LOG_PATH = fixture.logPath("v2-overwindow");
        v2 = await spawnOpencode2({
            existingIsolation: fixture,
            existingMock: { mock, baseURL: provider.baseURL },
            magicContextConfig,
            modelContextLimit: CONTEXT_LIMIT,
            modelOutputLimit: OUTPUT_LIMIT,
            additionalModelIDs: [OVERFLOW_MODEL_ID],
        });
        const client2 = OpenCode.make({
            baseUrl: v2.url,
            headers: { authorization: `Basic ${btoa(`opencode:${v2.password}`)}` },
        });
        await waitForPluginActive(client2, fixture.cwd);

        await client2.session.switchModel({
            sessionID: sessionId,
            model: { providerID: SHARED_MOCK_PROVIDER_ID, id: OVERFLOW_MODEL_ID },
        });
        const requestStart = mock.requests().length;
        const marker = "first priced converted over-window pass";
        await client2.session.prompt({ sessionID: sessionId, text: marker });
        await client2.session.wait(
            { sessionID: sessionId },
            { signal: AbortSignal.timeout(120_000) },
        );

        expect(convertedToolArcCount(fixture.openCodeDbPath, sessionId, callIds)).toBe(
            callIds.length,
        );
        const served = mock
            .requests()
            .slice(requestStart)
            .filter((request) => JSON.stringify(request.body).includes(marker));
        expect(served).toHaveLength(1);
        const afterTokens = requestTokens(served[0]!.body);
        expect(afterTokens).toBeLessThan(CONTEXT_LIMIT);
        expect(afterTokens).toBeLessThan(beforeTokens);

        const taggedAfter = contextRows<{ messageId: string; status: string }>(
            fixture.contextDbPath,
            `SELECT message_id AS messageId, status FROM tags
              WHERE session_id = ? AND type = 'tool' AND message_id IN (?, ?, ?)
              ORDER BY message_id`,
            sessionId,
            ...callIds,
        );
        const dropped = taggedAfter.filter((row) => row.status === "dropped");
        expect(dropped.length).toBeGreaterThan(0);

        await v2.stopHost();
        v2 = undefined;
        const logPath = fixture.logPath("v2-overwindow");
        expect(existsSync(logPath)).toBe(true);
        const log = readFileSync(logPath, "utf8");
        expect(log).toContain("pressure=stale-model-ignored");
        expect(log).toContain("using wire estimate for priced pass");
        expect(log).toContain("emergency tiered drop:");
        expect(log).not.toContain("emergency tiered drop skipped: unknown-usage");

        console.log(
            `[converted-overwindow] before=${beforeTokens} after=${afterTokens} dropped=${dropped.length}/${callIds.length} provider_requests=${served.length}`,
        );
    } finally {
        if (v2) await v2.stopHost().catch(() => undefined);
        if (v1) await v1.stop().catch(() => undefined);
        await mock.stop().catch(() => undefined);
    }
}, 600_000);
