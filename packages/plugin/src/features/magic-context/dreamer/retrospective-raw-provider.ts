import { resolve } from "node:path";

import { cleanUserText } from "../../../hooks/magic-context/read-session-chunk";
import { hasMeaningfulUserText } from "../../../hooks/magic-context/read-session-formatting";
import type { Database } from "../../../shared/sqlite";
import { closeQuietly } from "../../../shared/sqlite-helpers";
import type { RetrospectiveMessage } from "./friction-signals";
import { openOpenCodeDb } from "./open-opencode-db";

export const RETROSPECTIVE_MAX_MESSAGES_PER_SESSION = 80;
export const RETROSPECTIVE_MAX_MESSAGES_PER_RUN = 240;

export interface RetrospectiveProjectSession {
    sessionId: string;
    path?: string;
    updatedAt?: number;
}

export interface RetrospectiveRawMessage extends RetrospectiveMessage {
    sessionId: string;
    role: "user" | "assistant" | "tool";
    text: string;
    ts: number;
}

export interface RetrospectiveRawProvider {
    listProjectSessions(
        projectIdentity: string,
    ): RetrospectiveProjectSession[] | Promise<RetrospectiveProjectSession[]>;
    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveRawMessage[] | Promise<RetrospectiveRawMessage[]>;
}

interface OpenCodeRetrospectiveRawProviderDeps {
    contextDb: Database;
    openOpenCodeDb?: () => Database | null;
    /** Test-only shortcut: when provided, this connection is not closed by the provider. */
    opencodeDb?: Database;
}

interface SessionProjectRow {
    session_id: string;
    updated_at?: number | null;
}

interface OpenCodeMessageRow {
    id: string;
    data: string;
    time_created: number;
}

interface OpenCodePartRow {
    message_id: string;
    data: string;
}

export class OpenCodeRetrospectiveRawProvider implements RetrospectiveRawProvider {
    private readonly openDb: () => Database | null;

    constructor(private readonly deps: OpenCodeRetrospectiveRawProviderDeps) {
        this.openDb = deps.openOpenCodeDb ?? openOpenCodeDb;
    }

    listProjectSessions(projectIdentity: string): RetrospectiveProjectSession[] {
        const rows = this.deps.contextDb
            .prepare<[string], SessionProjectRow>(
                `SELECT session_id, updated_at
                   FROM session_projects
                  WHERE project_path = ? AND harness = 'opencode'
                  ORDER BY updated_at DESC, session_id DESC`,
            )
            .all(projectIdentity);
        return rows.map((row) => ({
            sessionId: row.session_id,
            updatedAt: typeof row.updated_at === "number" ? row.updated_at : undefined,
        }));
    }

    readUserMessagesSince(
        sessionId: string,
        sinceMs: number,
        capPerSession: number,
    ): RetrospectiveRawMessage[] {
        const db = this.deps.opencodeDb ?? this.openDb();
        if (!db) return [];
        try {
            return readOpenCodeMessagesSince(db, sessionId, sinceMs, capPerSession);
        } catch {
            return [];
        } finally {
            if (!this.deps.opencodeDb) closeQuietly(db);
        }
    }
}

export async function readProjectRetrospectiveMessages(
    provider: RetrospectiveRawProvider,
    projectIdentity: string,
    sinceMs: number,
    options?: {
        maxMessagesPerRun?: number;
        capPerSession?: number;
    },
): Promise<RetrospectiveRawMessage[]> {
    const maxMessages = options?.maxMessagesPerRun ?? RETROSPECTIVE_MAX_MESSAGES_PER_RUN;
    const capPerSession = options?.capPerSession ?? RETROSPECTIVE_MAX_MESSAGES_PER_SESSION;
    const sessions = await provider.listProjectSessions(projectIdentity);
    const batches = await Promise.all(
        sessions.map((session) =>
            provider.readUserMessagesSince(session.sessionId, sinceMs, capPerSession),
        ),
    );
    return batches
        .flat()
        .sort((a, b) => b.ts - a.ts || b.ordinal - a.ordinal)
        .slice(0, maxMessages)
        .sort((a, b) => a.ts - b.ts || a.ordinal - b.ordinal);
}

function readOpenCodeMessagesSince(
    db: Database,
    sessionId: string,
    sinceMs: number,
    capPerSession: number,
): RetrospectiveRawMessage[] {
    const limit = Math.max(1, Math.floor(capPerSession));
    const rows = db
        .prepare<[string, number, number], OpenCodeMessageRow>(
            `SELECT id, data, time_created
               FROM message
              WHERE session_id = ? AND time_created > ?
              ORDER BY time_created DESC, id DESC
              LIMIT ?`,
        )
        .all(sessionId, sinceMs, limit)
        .reverse();

    if (rows.length === 0) return [];

    const partRows = db
        .prepare<[string], OpenCodePartRow>(
            `SELECT message_id, data
               FROM part
              WHERE session_id = ?
              ORDER BY time_created ASC, id ASC`,
        )
        .all(sessionId);
    const partsByMessageId = new Map<string, unknown[]>();
    for (const row of partRows) {
        const parts = partsByMessageId.get(row.message_id) ?? [];
        const parsed = parseJson(row.data);
        if (parsed !== null) parts.push(parsed);
        partsByMessageId.set(row.message_id, parts);
    }

    return rows.flatMap((row, index) => {
        const messageData = parseJsonRecord(row.data);
        if (!messageData) return [];
        if (messageData.summary === true && messageData.finish === "stop") return [];
        const role = typeof messageData.role === "string" ? messageData.role : "unknown";
        const parts = partsByMessageId.get(row.id) ?? [];
        const ordinal = index + 1;
        return normalizeOpenCodeMessage({
            sessionId,
            ordinal,
            role,
            parts,
            ts: row.time_created,
        });
    });
}

function normalizeOpenCodeMessage(args: {
    sessionId: string;
    ordinal: number;
    role: string;
    parts: unknown[];
    ts: number;
}): RetrospectiveRawMessage[] {
    const rows: RetrospectiveRawMessage[] = [];
    if (args.role === "user") {
        const text = extractGenuineUserText(args.parts);
        if (text) {
            rows.push({
                sessionId: args.sessionId,
                ordinal: args.ordinal,
                role: "user",
                text,
                ts: args.ts,
            });
        }
    } else if (args.role === "assistant") {
        const text = extractPlainText(args.parts).join("\n").trim();
        if (text) {
            rows.push({
                sessionId: args.sessionId,
                ordinal: args.ordinal,
                role: "assistant",
                text,
                ts: args.ts,
            });
        }
    }

    for (const tool of extractToolRows(args.parts)) {
        rows.push({
            sessionId: args.sessionId,
            ordinal: args.ordinal,
            role: "tool",
            text: tool.text,
            toolName: tool.toolName,
            isError: tool.isError,
            ts: args.ts,
        });
    }

    return rows;
}

function extractGenuineUserText(parts: unknown[]): string {
    const nonSyntheticParts = parts.filter((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return true;
        const record = part as Record<string, unknown>;
        return record.synthetic !== true;
    });
    if (!hasMeaningfulUserText(nonSyntheticParts)) return "";
    return extractPlainText(nonSyntheticParts)
        .map((text) => cleanUserText(text))
        .filter((text) => text.length > 0)
        .join("\n")
        .trim();
}

function extractPlainText(parts: unknown[]): string[] {
    const texts: string[] = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "text") continue;
        if (record.ignored === true || record.synthetic === true) continue;
        if (typeof record.text === "string" && record.text.trim().length > 0) {
            texts.push(record.text.trim());
        }
    }
    return texts;
}

function extractToolRows(parts: unknown[]): Array<{
    toolName: string;
    text: string;
    isError: boolean;
}> {
    const rows: Array<{ toolName: string; text: string; isError: boolean }> = [];
    for (const part of parts) {
        if (part === null || typeof part !== "object" || Array.isArray(part)) continue;
        const record = part as Record<string, unknown>;
        if (record.type !== "tool" || typeof record.tool !== "string") continue;
        const state = record.state;
        const stateRecord =
            state && typeof state === "object" ? (state as Record<string, unknown>) : {};
        const output = stringifyToolOutput(stateRecord.output);
        const errorText = stringifyToolOutput(stateRecord.error);
        const status = typeof stateRecord.status === "string" ? stateRecord.status : "";
        const isError =
            stateRecord.isError === true ||
            status.toLowerCase() === "error" ||
            errorText.length > 0 ||
            /\b(error|failed|exception|traceback)\b/i.test(output);
        rows.push({
            toolName: record.tool,
            text: output || errorText || `tool ${record.tool}`,
            isError,
        });
    }
    return rows;
}

function stringifyToolOutput(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (value === null || value === undefined) return "";
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function parseJson(value: string): unknown | null {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
    const parsed = parseJson(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
}

export function sameResolvedPath(a: string, b: string): boolean {
    return resolve(a) === resolve(b);
}
