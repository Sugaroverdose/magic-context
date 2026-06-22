import { DREAMER_AGENT } from "../../../agents/dreamer";
import type { PluginContext } from "../../../plugin/types";
import * as shared from "../../../shared";
import { extractLatestAssistantText } from "../../../shared/assistant-message-extractor";
import { describeError, getErrorMessage } from "../../../shared/error-message";
import { shouldKeepSubagents } from "../../../shared/keep-subagents";
import { log } from "../../../shared/logger";
import { modelBodyField } from "../../../shared/resolve-fallbacks";
import type { Database } from "../../../shared/sqlite";
import { getMemoriesByProject } from "../memory/storage-memory";
import { getActivePrimers, type Primer, updatePrimerAnswer } from "../storage-primers";
import { recordChildInvocation } from "../subagent-token-capture";
import { peekLeaseHolderAndExpiry, renewLease } from "./lease";
import { DREAMER_SYSTEM_PROMPT } from "./task-prompts";

const REFRESH_PRIMERS_PER_RUN = 5;

export interface RefreshPrimersArgs {
    db: Database;
    client: PluginContext["client"];
    projectIdentity: string;
    parentSessionId: string | undefined;
    sessionDirectory: string;
    holderId: string;
    leaseKey: string;
    deadline: number;
    model?: string;
    fallbackModels?: readonly string[];
}

export interface RefreshPrimersResult {
    refreshed: number;
    skipped: number;
}

interface RecentCompartmentRow {
    title: string;
    content: string;
    created_at: number;
}

function loadRecentCompartmentContext(db: Database, projectIdentity: string): string {
    const rows = db
        .prepare(
            `SELECT c.title, COALESCE(c.p2, c.content) AS content, c.created_at
             FROM compartments c
             JOIN session_projects sp
               ON sp.session_id = c.session_id AND sp.harness = c.harness
             WHERE sp.project_path = ?
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT 24`,
        )
        .all(projectIdentity) as RecentCompartmentRow[];
    if (rows.length === 0) return "(none)";
    return rows.map((row) => `- ${row.title}: ${row.content.slice(0, 800)}`).join("\n");
}

function loadMemoryContext(db: Database, projectIdentity: string): string {
    const memories = getMemoriesByProject(db, projectIdentity, ["active", "permanent"]);
    if (memories.length === 0) return "(none)";
    return memories.map((memory) => `- [${memory.category}] ${memory.content}`).join("\n");
}

function primersNeedingRefresh(primers: Primer[]): Primer[] {
    return primers
        .filter(
            (primer) =>
                !primer.answer.trim() ||
                primer.answerRefreshedAt == null ||
                (primer.lastObservedAt ?? 0) > primer.answerRefreshedAt,
        )
        .sort(
            (a, b) =>
                (b.lastObservedAt ?? b.createdAt) - (a.lastObservedAt ?? a.createdAt) ||
                a.id - b.id,
        )
        .slice(0, REFRESH_PRIMERS_PER_RUN);
}

function buildRefreshPrompt(
    primer: Primer,
    memoryContext: string,
    compartmentContext: string,
): string {
    return `## Task: Refresh a Magic Context Primer

You maintain a concise durable answer for a standing project question.

### Question
${primer.question}

### Current Answer
${primer.answer.trim() || "(empty)"}

### Project Memories
${memoryContext}

### Recent Session Compartments
${compartmentContext}

### Instructions
- Write a direct answer to the question using only the supplied context.
- Prefer stable architecture/invariant information over transient task status.
- Keep the answer concise (roughly 3-8 bullets or short paragraphs).
- If the supplied context does not answer the question, return the current answer unchanged if it is non-empty; otherwise return an empty string.

Return valid JSON only, no markdown fencing:
{ "answer": "..." }`;
}

function parseAnswer(messages: unknown[], fallback: string): string {
    const text = extractLatestAssistantText(messages);
    if (!text) throw new Error("refresh-primers returned no output");
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? text.match(/(\{[\s\S]*\})/);
    if (!jsonMatch) throw new Error("refresh-primers returned no JSON");
    const parsed = JSON.parse(jsonMatch[1]) as { answer?: unknown };
    const answer = typeof parsed.answer === "string" ? parsed.answer.trim() : "";
    if (!answer && fallback.trim()) return fallback.trim();
    if (answer.length > 20_000) throw new Error("refresh-primers answer too large");
    return answer;
}

export async function refreshPrimers(args: RefreshPrimersArgs): Promise<RefreshPrimersResult> {
    const result: RefreshPrimersResult = { refreshed: 0, skipped: 0 };
    const primers = primersNeedingRefresh(getActivePrimers(args.db, args.projectIdentity));
    if (primers.length === 0) return result;

    const memoryContext = loadMemoryContext(args.db, args.projectIdentity);
    const compartmentContext = loadRecentCompartmentContext(args.db, args.projectIdentity);
    let agentSessionId: string | null = null;
    let phaseFailed = false;
    const startedAt = Date.now();
    let invocationRecorded = false;
    const recordInvocation = (params: {
        status: "completed" | "failed";
        messages?: unknown[];
        error?: unknown;
    }) => {
        if (!args.parentSessionId || invocationRecorded) return;
        invocationRecorded = true;
        recordChildInvocation({
            db: args.db,
            parentSessionId: args.parentSessionId,
            harness: "opencode",
            subagent: "dreamer",
            task: "refresh-primers",
            startedAt,
            status: params.status,
            messages: params.messages,
            error: params.error,
        });
    };

    const abortController = new AbortController();
    const leaseInterval = setInterval(() => {
        try {
            if (!renewLease(args.db, args.holderId, args.leaseKey)) abortController.abort();
        } catch {
            abortController.abort();
        }
    }, 60_000);

    try {
        const createResponse = await args.client.session.create({
            body: {
                ...(args.parentSessionId ? { parentID: args.parentSessionId } : {}),
                title: "magic-context-dream-refresh-primers",
            },
            query: { directory: args.sessionDirectory },
        });
        const created = shared.normalizeSDKResponse(
            createResponse,
            null as { id?: string } | null,
            {
                preferResponseOnMissingData: true,
            },
        );
        agentSessionId = typeof created?.id === "string" ? created.id : null;
        if (!agentSessionId) throw new Error("Could not create primer refresh session.");

        for (const primer of primers) {
            const remainingMs = Math.max(0, args.deadline - Date.now());
            if (remainingMs <= 0) throw new Error("refresh-primers deadline expired");
            const prompt = buildRefreshPrompt(primer, memoryContext, compartmentContext);
            const run = await shared.promptSyncWithValidatedOutputRetry(
                args.client,
                {
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                    body: {
                        agent: DREAMER_AGENT,
                        system: DREAMER_SYSTEM_PROMPT,
                        ...modelBodyField(args.model),
                        parts: [{ type: "text", text: prompt, synthetic: true }],
                    },
                },
                {
                    timeoutMs: remainingMs,
                    signal: abortController.signal,
                    fallbackModels: args.fallbackModels,
                    callContext: "dreamer:refresh-primers",
                    fetchOutput: async () => {
                        const messagesResponse = await args.client.session.messages({
                            path: { id: agentSessionId as string },
                            query: { directory: args.sessionDirectory, limit: 50 },
                        });
                        return shared.normalizeSDKResponse(messagesResponse, [] as unknown[], {
                            preferResponseOnMissingData: true,
                        });
                    },
                    validateOutput: (messages) => parseAnswer(messages, primer.answer),
                },
            );
            recordInvocation({ status: "completed", messages: run.output });
            const answer = run.validated.trim();
            if (!answer) {
                result.skipped += 1;
                continue;
            }
            let leaseLost = false;
            args.db.transaction(() => {
                if (!peekLeaseHolderAndExpiry(args.db, args.holderId, args.leaseKey)) {
                    leaseLost = true;
                    return;
                }
                updatePrimerAnswer(args.db, primer.id, answer);
            })();
            if (leaseLost) throw new Error("Dream lease lost during refresh-primers commit");
            result.refreshed += 1;
        }
        log(`[dreamer] refresh-primers: refreshed=${result.refreshed} skipped=${result.skipped}`);
        return result;
    } catch (error) {
        phaseFailed = true;
        const desc = describeError(error);
        log(
            `[dreamer] refresh-primers failed: ${desc.brief}`,
            desc.stackHead ? { stackHead: desc.stackHead } : undefined,
        );
        recordInvocation({ status: "failed", error });
        throw error;
    } finally {
        clearInterval(leaseInterval);
        if (agentSessionId && !phaseFailed && !shouldKeepSubagents()) {
            await args.client.session
                .delete({
                    path: { id: agentSessionId },
                    query: { directory: args.sessionDirectory },
                })
                .catch((e: unknown) => {
                    log(`[dreamer] refresh-primers session cleanup failed: ${getErrorMessage(e)}`);
                });
        }
    }
}
