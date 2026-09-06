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
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (TRACE|DEBUG|INFO |WARN |ERROR) magic-context (.*)$/;
const LEGACY_LINE = /^\[([^\]]+)\] \[magic-context\]\[([^\]]*)\]\s+(.*)$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

interface Token {
    raw: string;
    start: number;
}

function tokenize(input: string, limit: number): Token[] | null {
    const tokens: Token[] = [];
    let index = 0;
    while (index < input.length && tokens.length < limit) {
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

function trailingToken(input: string, end: number): Token | null {
    let index = end;
    let quoted = false;
    while (index > 0) {
        const char = input[index - 1];
        if (char === '"') {
            let slashStart = index - 1;
            while (input[slashStart - 1] === "\\") slashStart -= 1;
            if ((index - 1 - slashStart) % 2 === 0) quoted = !quoted;
            index = slashStart;
        } else if (char === " " && !quoted) {
            break;
        } else {
            index -= 1;
        }
    }
    return quoted ? null : { raw: input.slice(index, end), start: index };
}

function splitMessageAndFields(
    input: string,
    decodeMessage = true,
): { message: string; kv: Record<string, string> } {
    // Message prose is opaque: only consume a well-formed field suffix from the right.
    // An unmatched quote earlier in the message must not hide the entire record.
    let messageEnd = input.trimEnd().length;
    const fields: [string, string][] = [];
    while (messageEnd > 0) {
        const token = trailingToken(input, messageEnd);
        const field = token && parseField(token.raw);
        if (!token || !field || token.start === 0) break;
        fields.push(field);
        messageEnd = token.start;
        while (messageEnd > 0 && input[messageEnd - 1] === " ") messageEnd -= 1;
    }
    const rawMessage = fields.length > 0 ? input.slice(0, messageEnd) : input;
    const message = decodeMessage ? (decodeEscapes(rawMessage) ?? rawMessage) : rawMessage;
    const kv: Record<string, string> = {};
    for (const [key, value] of fields.reverse()) kv[key] = value;
    return { message, kv };
}

function rawSessionId(value: string): string | null {
    if (!value || value === "global") return null;
    const colon = value.indexOf(":");
    if (colon <= 0 || colon === value.length - 1) return null;
    return value.slice(colon + 1);
}

export function parseLogLine(line: string): ParsedLogLine | null {
    const fleet = FLEET_PREFIX.exec(line);
    if (fleet) {
        const ts = fleet[1];
        if (Number.isNaN(Date.parse(ts)) || new Date(ts).toISOString() !== ts) return null;
        const level = fleet[2].trim() as LogLevel;
        let remaining = fleet[3].trimStart();
        let session: string | null = null;
        const tags: string[] = [];
        if (remaining.startsWith("session=")) {
            const token = tokenize(remaining, 1)?.[0];
            if (!token || token.raw.includes("\u001b")) return null;
            const sessionField = parseField(token.raw);
            if (!sessionField) return null;
            session = rawSessionId(sessionField[1]);
            if (!session) return null;
            remaining = remaining.slice(token.raw.length).trimStart();
        }
        while (remaining.startsWith("tag=")) {
            const token = tokenize(remaining, 1)?.[0];
            if (!token || token.raw.includes("\u001b")) return null;
            const tagField = parseField(token.raw);
            if (!tagField?.[1]) return null;
            tags.push(tagField[1]);
            remaining = remaining.slice(token.raw.length).trimStart();
        }
        const body = splitMessageAndFields(remaining);
        return { ts, level, session, tags, ...body, grammar: "fleet" };
    }

    const legacy = LEGACY_LINE.exec(line);
    if (!legacy || legacy[2].includes("\u001b") || Number.isNaN(Date.parse(legacy[1]))) return null;
    const body = splitMessageAndFields(legacy[3], false);
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
