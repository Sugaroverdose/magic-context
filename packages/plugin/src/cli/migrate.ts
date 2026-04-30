import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "../shared/sqlite";
import { Database } from "../shared/sqlite";

export interface MigrateOpenCodeSessionToPiOptions {
    db?: DatabaseLike;
    fs?: FileSystemLike;
    now?: Date;
    sessionId: string;
    maxMessages?: number;
    dryRun?: boolean;
    opencodeDbPath?: string;
    piSessionsRoot?: string;
    provider?: string;
    modelId?: string;
}

export interface MigrationResult {
    outputPath: string;
    messageCount: number;
    byteCount: number;
    sourceMessageCount: number;
    dryRun: boolean;
}

export interface MigrateCliOptions {
    from?: string;
    to?: string;
    session?: string;
    maxMessages?: number;
    dryRun?: boolean;
}

type DatabaseLike = Pick<DatabaseType, "prepare" | "close">;

type FileSystemLike = {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options?: { recursive?: boolean }): unknown;
    writeFileSync(path: string, data: string): unknown;
};

type StatementLike<T = unknown> = {
    get(...params: unknown[]): T | undefined;
    all(...params: unknown[]): T[];
};

type OpenCodeSessionRow = {
    id: string;
    title?: string;
    directory?: string;
    path?: string | null;
    time_created: number;
};

type OpenCodeMessageRow = {
    id: string;
    time_created: number;
    data: string;
};

type OpenCodePartRow = {
    id: string;
    message_id: string;
    time_created: number;
    data: string;
};

type PiJson = Record<string, unknown>;

type OpenCodeMessageData = {
    role?: string;
    time?: { created?: number };
    modelID?: string;
    providerID?: string;
    model?: { providerID?: string; modelID?: string };
};

type OpenCodePartData = {
    type?: string;
    text?: string;
    filename?: string;
    name?: string;
    tool?: string;
    tool_name?: string;
    callID?: string;
    call_id?: string;
    toolCallId?: string;
    tool_call_id?: string;
    input?: unknown;
    output?: unknown;
    state?: {
        input?: unknown;
        output?: unknown;
        title?: string;
        metadata?: { output?: unknown };
    };
    metadata?: { anthropic?: { signature?: string } };
};

const DEFAULT_PROVIDER = "openai-codex";
const DEFAULT_MODEL = "gpt-5.5";

function defaultOpenCodeDbPath(): string {
    return join(homedir(), ".local", "share", "opencode", "opencode.db");
}

function defaultPiSessionsRoot(): string {
    return join(homedir(), ".pi", "agent", "sessions");
}

function defaultFs(): FileSystemLike {
    return { existsSync, mkdirSync, writeFileSync };
}

function stmt<T>(db: DatabaseLike, sql: string): StatementLike<T> {
    return db.prepare(sql) as unknown as StatementLike<T>;
}

export function projectPathToPiDirSlug(projectPath: string): string {
    return `--${projectPath.replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}--`;
}

export function formatPiFilenameTimestamp(date: Date): string {
    return date.toISOString().replaceAll(":", "-").replace(".", "-");
}

export function generateUuidV7(date = new Date()): string {
    const bytes = randomBytes(16);
    let ms = BigInt(date.getTime());
    for (let i = 5; i >= 0; i--) {
        bytes[i] = Number(ms & 0xffn);
        ms >>= 8n;
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function shortId(): string {
    return randomBytes(4).toString("hex");
}

function parseJsonObject<T>(text: string): T {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Expected JSON object");
    }
    return parsed as T;
}

function isoFromMs(ms: number | undefined, fallback: Date): string {
    return new Date(
        typeof ms === "number" && Number.isFinite(ms) ? ms : fallback.getTime(),
    ).toISOString();
}

function textFromUnknown(value: unknown): string {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
}

function roleFromMessage(row: OpenCodeMessageRow): "user" | "assistant" | undefined {
    const data = parseJsonObject<OpenCodeMessageData>(row.data);
    return data.role === "user" || data.role === "assistant" ? data.role : undefined;
}

function extractModel(rows: OpenCodeMessageRow[]): { provider: string; modelId: string } {
    for (const row of rows) {
        try {
            const data = parseJsonObject<OpenCodeMessageData>(row.data);
            const provider = data.providerID ?? data.model?.providerID;
            const modelId = data.modelID ?? data.model?.modelID;
            if (provider && modelId) return { provider, modelId };
        } catch {
            // Ignore malformed rows; conversion below will surface concrete row errors.
        }
    }
    return { provider: DEFAULT_PROVIDER, modelId: DEFAULT_MODEL };
}

function normalizeOpenCodeTool(part: OpenCodePartData): {
    callId: string;
    name: string;
    input: unknown;
    output: unknown;
} {
    const callId =
        part.callID ??
        part.call_id ??
        part.toolCallId ??
        part.tool_call_id ??
        `migrated_${shortId()}`;
    const name = part.tool ?? part.tool_name ?? part.name ?? part.state?.title ?? "unknown_tool";
    const input = part.input ?? part.state?.input ?? {};
    const output = part.output ?? part.state?.output ?? part.state?.metadata?.output ?? "";
    return { callId, name, input, output };
}

function makeMessageEntry(
    role: "user" | "assistant",
    text: string,
    timestamp: string,
    parentId: string | null,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role,
            content: [{ type: "text", text }],
            timestamp: Date.parse(timestamp),
        },
    };
}

function makeThinkingEntry(text: string, timestamp: string, parentId: string | null): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "assistant",
            content: [{ type: "thinking", thinking: text, thinkingSignature: null }],
            timestamp: Date.parse(timestamp),
        },
    };
}

function makeToolCallEntry(
    tool: { callId: string; name: string; input: unknown },
    timestamp: string,
    parentId: string | null,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "assistant",
            content: [
                { type: "toolCall", id: tool.callId, name: tool.name, arguments: tool.input ?? {} },
            ],
            timestamp: Date.parse(timestamp),
        },
    };
}

function makeToolResultEntry(
    tool: { callId: string; name: string; output: unknown },
    timestamp: string,
    parentId: string | null,
): PiJson {
    return {
        type: "message",
        id: shortId(),
        parentId,
        timestamp,
        message: {
            role: "toolResult",
            toolCallId: tool.callId,
            toolName: tool.name,
            content: [{ type: "text", text: textFromUnknown(tool.output) }],
            isError: false,
            timestamp: Date.parse(timestamp),
        },
    };
}

function convertPartToEntries(
    role: "user" | "assistant",
    row: OpenCodePartRow,
    timestamp: string,
    parentId: string | null,
): PiJson[] {
    const part = parseJsonObject<OpenCodePartData>(row.data);
    switch (part.type) {
        case "step-start":
        case "step-finish":
        case "patch":
            return [];
        case "text":
            return part.text ? [makeMessageEntry(role, part.text, timestamp, parentId)] : [];
        case "reasoning":
            return part.text ? [makeThinkingEntry(part.text, timestamp, parentId)] : [];
        case "tool": {
            const tool = normalizeOpenCodeTool(part);
            const call = makeToolCallEntry(tool, timestamp, parentId);
            const result = makeToolResultEntry(tool, timestamp, call.id as string);
            return [call, result];
        }
        case "file": {
            const name = part.filename ?? part.name ?? "attachment";
            return [makeMessageEntry(role, `<file omitted: ${name}>`, timestamp, parentId)];
        }
        default:
            return [];
    }
}

function buildPiEntries(params: {
    session: OpenCodeSessionRow;
    messages: OpenCodeMessageRow[];
    parts: OpenCodePartRow[];
    now: Date;
    provider: string;
    modelId: string;
}): PiJson[] {
    const sessionUuid = generateUuidV7(params.now);
    const nowIso = params.now.toISOString();
    const entries: PiJson[] = [
        {
            type: "session",
            version: 3,
            id: sessionUuid,
            timestamp: nowIso,
            cwd: params.session.directory ?? params.session.path ?? process.cwd(),
        },
        {
            type: "model_change",
            id: shortId(),
            parentId: null,
            timestamp: nowIso,
            provider: params.provider,
            modelId: params.modelId,
        },
    ];

    const boundary = makeMessageEntry(
        "user",
        `<!-- migrated from OpenCode session ${params.session.id} at ${nowIso} -->\n\nThe following conversation was migrated from a different harness. Reasoning context from prior turns may be incomplete; tool calls reference tools that may not exist in this environment.`,
        nowIso,
        null,
    );
    entries.push(boundary);

    const partsByMessage = new Map<string, OpenCodePartRow[]>();
    for (const part of params.parts) {
        const list = partsByMessage.get(part.message_id) ?? [];
        list.push(part);
        partsByMessage.set(part.message_id, list);
    }

    let parentId = boundary.id as string;
    for (const message of params.messages) {
        const role = roleFromMessage(message);
        if (!role) continue;
        const timestamp = isoFromMs(message.time_created, params.now);
        for (const part of partsByMessage.get(message.id) ?? []) {
            const newEntries = convertPartToEntries(role, part, timestamp, parentId);
            for (const entry of newEntries) {
                if (entry.parentId === undefined || entry.parentId === parentId)
                    entry.parentId = parentId;
                entries.push(entry);
                parentId = entry.id as string;
            }
        }
    }

    return entries;
}

function fetchRows(db: DatabaseLike, sessionId: string, maxMessages: number | undefined) {
    const session = stmt<OpenCodeSessionRow>(
        db,
        "SELECT id, title, directory, path, time_created FROM session WHERE id = ?",
    ).get(sessionId);
    if (!session) throw new Error(`OpenCode session not found: ${sessionId}`);

    const sourceMessageCount =
        stmt<{ count: number }>(
            db,
            "SELECT COUNT(*) AS count FROM message WHERE session_id = ?",
        ).get(sessionId)?.count ?? 0;

    const limitClause = maxMessages ? "LIMIT ?" : "";
    const params = maxMessages ? [sessionId, maxMessages] : [sessionId];
    const newestFirst = stmt<OpenCodeMessageRow>(
        db,
        `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created DESC, id DESC ${limitClause}`,
    ).all(...params);
    const messages = newestFirst.reverse();
    const ids = messages.map((row) => row.id);
    const parts = ids.length
        ? stmt<OpenCodePartRow>(
              db,
              `SELECT id, message_id, time_created, data FROM part WHERE message_id IN (${ids.map(() => "?").join(",")}) ORDER BY time_created, id`,
          ).all(...ids)
        : [];

    return { session, sourceMessageCount, messages, parts };
}

function ensureValidOptions(
    opts: MigrateCliOptions,
): asserts opts is Required<Pick<MigrateCliOptions, "from" | "to" | "session">> &
    MigrateCliOptions {
    if (!opts.from) throw new Error("Missing required flag: --from <opencode>");
    if (!opts.to) throw new Error("Missing required flag: --to <pi>");
    if (opts.from !== "opencode" || opts.to !== "pi") {
        if (opts.from === "pi" && opts.to === "opencode") {
            throw new Error(
                "Migration pi → opencode is not yet supported (V1 supports only opencode → pi)",
            );
        }
        throw new Error(
            `Unsupported migration: ${opts.from} → ${opts.to} (V1 supports only opencode → pi)`,
        );
    }
    if (!opts.session) throw new Error("Missing required flag: --session <id>");
    if (
        opts.maxMessages !== undefined &&
        (!Number.isInteger(opts.maxMessages) || opts.maxMessages <= 0)
    ) {
        throw new Error("--max-messages must be a positive integer");
    }
}

export function migrateOpenCodeSessionToPi(
    opts: MigrateOpenCodeSessionToPiOptions,
): MigrationResult {
    const fs = opts.fs ?? defaultFs();
    const now = opts.now ?? new Date();
    const opencodeDbPath = opts.opencodeDbPath ?? defaultOpenCodeDbPath();
    const piSessionsRoot = opts.piSessionsRoot ?? defaultPiSessionsRoot();
    const ownsDb = !opts.db;
    const db = opts.db ?? new Database(opencodeDbPath, { readonly: true });

    try {
        const { session, sourceMessageCount, messages, parts } = fetchRows(
            db,
            opts.sessionId,
            opts.maxMessages,
        );
        const model = extractModel(messages);
        const provider = opts.provider ?? model.provider;
        const modelId = opts.modelId ?? model.modelId;
        const cwd = session.directory ?? session.path ?? process.cwd();
        const outputDir = join(piSessionsRoot, projectPathToPiDirSlug(cwd));
        const outputPath = join(
            outputDir,
            `${formatPiFilenameTimestamp(now)}_${generateUuidV7(now)}.jsonl`,
        );
        const entries = buildPiEntries({ session, messages, parts, now, provider, modelId });
        const jsonl = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

        if (!opts.dryRun) {
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            fs.writeFileSync(outputPath, jsonl);
        }

        return {
            outputPath,
            messageCount: entries.length - 2,
            byteCount: Buffer.byteLength(jsonl, "utf8"),
            sourceMessageCount,
            dryRun: Boolean(opts.dryRun),
        };
    } finally {
        if (ownsDb) db.close();
    }
}

export function parseMigrateArgs(args: string[]): MigrateCliOptions {
    const opts: MigrateCliOptions = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        const readValue = (flag: string): string => {
            const value = args[++i];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
            return value;
        };
        if (arg === "--from") opts.from = readValue(arg);
        else if (arg === "--to") opts.to = readValue(arg);
        else if (arg === "--session") opts.session = readValue(arg);
        else if (arg === "--max-messages") opts.maxMessages = Number(readValue(arg));
        else if (arg === "--dry-run") opts.dryRun = true;
        else if (arg === "--help" || arg === "-h") throw new Error("HELP");
        else throw new Error(`Unknown migrate flag: ${arg}`);
    }
    return opts;
}

export function printMigrateHelp(): void {
    console.log(`
  Magic Context doctor migrate
  ─────────────────────────────

  Copy OpenCode session message content into a new Pi JSONL session.

  Supported pairs (V1):
    --from opencode --to pi

  Usage:
    bunx --bun @cortexkit/opencode-magic-context@latest doctor migrate \\
      --from opencode --to pi --session ses_xxx [--max-messages N] [--dry-run]

  Fidelity: text, reasoning text, tool calls, and tool results are preserved;
  reasoning signatures are stripped; step-start/step-finish are skipped; file
  bytes are replaced with <file omitted: name> markers. Magic Context durable
  state is not migrated, so Pi re-tags from a clean slate.
`);
}

export async function runMigrateCli(args: string[]): Promise<number> {
    try {
        const parsed = parseMigrateArgs(args);
        ensureValidOptions(parsed);
        const result = migrateOpenCodeSessionToPi({
            sessionId: parsed.session,
            maxMessages: parsed.maxMessages,
            dryRun: parsed.dryRun,
        });
        const action = result.dryRun ? "Would write" : "Wrote";
        console.log(`${action} Pi session JSONL:`);
        console.log(`  path: ${result.outputPath}`);
        console.log(`  source messages: ${result.sourceMessageCount}`);
        console.log(`  migrated entries: ${result.messageCount}`);
        console.log(`  bytes: ${result.byteCount}`);
        if (!result.dryRun) {
            console.log("Pi may need to be restarted to pick up the new session file.");
        }
        return 0;
    } catch (error) {
        if (error instanceof Error && error.message === "HELP") {
            printMigrateHelp();
            return 0;
        }
        console.error(error instanceof Error ? error.message : String(error));
        console.error("Run `doctor migrate --help` for usage.");
        return 1;
    }
}
