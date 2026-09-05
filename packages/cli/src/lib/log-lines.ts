import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMagicContextStorageDir } from "@magic-context/core/shared/data-path";

export type LogLevel = "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR";
export type LogGrammar = "fleet" | "legacy";
export type DetectedLogGrammar = LogGrammar | "mixed" | "unknown";
export type LogHarness = "opencode" | "pi" | "omp";

export interface LogLineRecord {
    ts: string;
    level: LogLevel | null;
    session: string | null;
    tags: string[];
    message: string;
    kv: Record<string, string>;
}

export interface ParsedLogLine extends LogLineRecord {
    grammar: LogGrammar;
}

export interface LogFileInspection {
    path: string;
    exists: boolean;
    sizeKb: number;
    lineCount: number;
    grammar: DetectedLogGrammar;
}

const FLEET_PREFIX =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (TRACE|DEBUG|INFO |WARN |ERROR) magic-context (.+)$/;
const LEGACY_LINE = /^\[([^\]]+)\] \[magic-context\]\[([^\]]*)\]\s+(.*)$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

interface Token {
    raw: string;
    start: number;
}

function tokenize(input: string): Token[] | null {
    const tokens: Token[] = [];
    let index = 0;
    while (index < input.length) {
        while (input[index] === " ") index += 1;
        if (index >= input.length) break;
        const start = index;
        let quoted = false;
        let escaped = false;
        while (index < input.length) {
            const char = input[index];
            if (escaped) {
                escaped = false;
            } else if (quoted && char === "\\") {
                escaped = true;
            } else if (char === '"') {
                quoted = !quoted;
            } else if (!quoted && char === " ") {
                break;
            }
            index += 1;
        }
        if (quoted || escaped) return null;
        tokens.push({ raw: input.slice(start, index), start });
    }
    return tokens;
}

function decodeEscapes(value: string): string | null {
    let decoded = "";
    for (let index = 0; index < value.length; index += 1) {
        const char = value[index];
        if (char !== "\\") {
            decoded += char;
            continue;
        }
        const next = value[index + 1];
        if (next === undefined) return null;
        if (next === "n") decoded += "\n";
        else if (next === '"') decoded += '"';
        else if (next === "\\") decoded += "\\";
        else return null;
        index += 1;
    }
    return decoded;
}

function parseField(token: string): [string, string] | null {
    const equals = token.indexOf("=");
    if (equals <= 0) return null;
    const key = token.slice(0, equals);
    if (!FIELD_NAME.test(key)) return null;
    const rawValue = token.slice(equals + 1);
    if (rawValue.startsWith('"')) {
        if (rawValue.length < 2 || !rawValue.endsWith('"')) return null;
        const value = decodeEscapes(rawValue.slice(1, -1));
        return value === null ? null : [key, value];
    }
    if (rawValue.length === 0 || rawValue.includes('"')) return null;
    return [key, rawValue];
}

function splitMessageAndFields(
    input: string,
    decodeMessage = true,
): { message: string; kv: Record<string, string> } | null {
    const tokens = tokenize(input);
    if (!tokens || tokens.length === 0) return null;

    let fieldStart = tokens.length;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (!parseField(tokens[index].raw)) break;
        fieldStart = index;
    }
    if (fieldStart === 0) return null;

    const messageEnd = fieldStart < tokens.length ? tokens[fieldStart].start : input.length;
    const rawMessage = input.slice(0, messageEnd).trimEnd();
    const message = decodeMessage ? decodeEscapes(rawMessage) : rawMessage;
    if (!message) return null;

    const kv: Record<string, string> = {};
    for (const token of tokens.slice(fieldStart)) {
        const field = parseField(token.raw);
        if (!field) return null;
        kv[field[0]] = field[1];
    }
    return { message, kv };
}

function rawSessionId(value: string): string | null {
    if (!value || value === "global") return null;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return null;
    return value.slice(colon + 1);
}

export function parseLogLine(line: string): ParsedLogLine | null {
    if (line.includes("\u001b")) return null;

    const fleet = FLEET_PREFIX.exec(line);
    if (fleet) {
        const ts = fleet[1];
        if (Number.isNaN(Date.parse(ts)) || new Date(ts).toISOString() !== ts) return null;
        const level = fleet[2].trim() as LogLevel;
        const tokens = tokenize(fleet[3]);
        if (!tokens) return null;

        let index = 0;
        let session: string | null = null;
        const tags: string[] = [];
        if (tokens[index]?.raw.startsWith("session=")) {
            const sessionField = parseField(tokens[index].raw);
            if (!sessionField) return null;
            session = rawSessionId(sessionField[1]);
            if (!session) return null;
            index += 1;
        }
        while (tokens[index]?.raw.startsWith("tag=")) {
            const tagField = parseField(tokens[index].raw);
            if (!tagField?.[1]) return null;
            tags.push(tagField[1]);
            index += 1;
        }
        if (index >= tokens.length) return null;
        const body = splitMessageAndFields(fleet[3].slice(tokens[index].start));
        if (!body) return null;
        return { ts, level, session, tags, ...body, grammar: "fleet" };
    }

    const legacy = LEGACY_LINE.exec(line);
    if (!legacy || Number.isNaN(Date.parse(legacy[1]))) return null;
    const body = splitMessageAndFields(legacy[3], false);
    if (!body) return null;
    const legacySession = legacy[2].trim();
    return {
        ts: legacy[1],
        level: null,
        session: legacySession && legacySession !== "global" ? legacySession : null,
        tags: [],
        ...body,
        grammar: "legacy",
    };
}

export interface LogPathOptions {
    tempDir?: string;
    storageDir?: string;
    override?: string | null;
}

export function getMagicContextLogPaths(
    harness: LogHarness,
    options: LogPathOptions = {},
): string[] {
    const override =
        options.override === undefined
            ? process.env.MAGIC_CONTEXT_LOG_PATH?.trim()
            : options.override?.trim();
    const storageLogs = join(options.storageDir ?? getMagicContextStorageDir(), "logs");
    return [
        ...(override ? [override] : []),
        join(options.tempDir ?? tmpdir(), harness, "magic-context", "magic-context.log"),
        join(storageLogs, `magic-context.${harness}.log`),
        join(storageLogs, "magic-context.log"),
    ].filter((path, index, paths) => paths.indexOf(path) === index);
}

export function inspectLogFile(path: string): LogFileInspection {
    if (!existsSync(path)) {
        return { path, exists: false, sizeKb: 0, lineCount: 0, grammar: "unknown" };
    }
    try {
        const content = readFileSync(path, "utf8");
        const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
        const grammars = new Set(
            lines.flatMap((line) => {
                const parsed = parseLogLine(line);
                return parsed ? [parsed.grammar] : [];
            }),
        );
        const grammar: DetectedLogGrammar =
            grammars.size > 1 ? "mixed" : (grammars.values().next().value ?? "unknown");
        return {
            path,
            exists: true,
            sizeKb: Math.round(statSync(path).size / 1024),
            lineCount: lines.length,
            grammar,
        };
    } catch {
        return { path, exists: true, sizeKb: 0, lineCount: 0, grammar: "unknown" };
    }
}

export function inspectMagicContextLogs(
    harness: LogHarness,
    options: LogPathOptions = {},
): LogFileInspection[] {
    return getMagicContextLogPaths(harness, options).map(inspectLogFile);
}

export function readLogLines(
    files: readonly Pick<LogFileInspection, "path" | "exists">[],
): string[] {
    const lines = files.flatMap((file, fileIndex) => {
        if (!file.exists) return [];
        try {
            let precedingTimestamp = "";
            return readFileSync(file.path, "utf8")
                .split(/\r?\n/)
                .filter((line) => line.length > 0)
                .map((line, lineIndex) => {
                    precedingTimestamp = parseLogLine(line)?.ts ?? precedingTimestamp;
                    return { line, timestamp: precedingTimestamp, fileIndex, lineIndex };
                });
        } catch {
            return [];
        }
    });
    lines.sort(
        (left, right) =>
            left.timestamp.localeCompare(right.timestamp) ||
            left.fileIndex - right.fileIndex ||
            left.lineIndex - right.lineIndex,
    );
    return lines.map(({ line }) => line);
}

export function formatLogFileInspection(file: LogFileInspection): string {
    return `${file.path} (grammar=${file.grammar}, lines=${file.lineCount}, ${file.sizeKb} KB)`;
}
