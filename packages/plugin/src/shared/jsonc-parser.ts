import { existsSync, readFileSync } from "node:fs";

import {
    type ParseError,
    parse as parseJsoncDocument,
    printParseErrorCode,
} from "jsonc-parser/lib/esm/main.js";
// ^ Deep ESM import on purpose, same as jsonc-edit.ts: the package's "main" is a
// UMD bundle whose runtime-relative requires (`./impl/format`) survive bundling
// verbatim and crash the plugin at boot. The build:dists load-probe gate exists
// to catch exactly this; do not import the bare package name.

export function stripJsonComments(content: string): string {
    let result = "";
    let inString = false;
    let escaped = false;
    let inLineComment = false;
    let inBlockComment = false;

    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];
        const next = content[index + 1];

        if (inLineComment) {
            if (char === "\n") {
                inLineComment = false;
                result += char;
            }
            continue;
        }

        if (inBlockComment) {
            if (char === "*" && next === "/") {
                inBlockComment = false;
                index += 1;
            }
            continue;
        }

        if (inString) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === "/" && next === "/") {
            inLineComment = true;
            index += 1;
            continue;
        }

        if (char === "/" && next === "*") {
            inBlockComment = true;
            index += 1;
            continue;
        }

        result += char;
    }

    return result;
}

function stripTrailingCommas(content: string): string {
    let result = "";
    let inString = false;
    let escaped = false;

    for (let index = 0; index < content.length; index += 1) {
        const char = content[index];

        if (inString) {
            result += char;
            if (escaped) {
                escaped = false;
            } else if (char === "\\") {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            result += char;
            continue;
        }

        if (char === ",") {
            let lookahead = index + 1;
            while (lookahead < content.length && /\s/.test(content[lookahead] ?? "")) {
                lookahead += 1;
            }
            const next = content[lookahead];
            if (next === "}" || next === "]") {
                continue;
            }
        }

        result += char;
    }

    return result;
}

const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function isPrototypePollutionKey(key: string): boolean {
    return PROTOTYPE_POLLUTION_KEYS.has(key);
}

export interface ParsedJsonSanitizerOptions {
    onRejectedKey?: (path: readonly (string | number)[]) => void;
}

/**
 * Copy parsed JSON into fresh own-property-only containers while rejecting keys
 * that can alter an object's prototype during a later merge. Rebuilding objects
 * also removes an already-polluted prototype produced by third-party parsers.
 */
export function sanitizeParsedJson<T>(
    value: T,
    options: ParsedJsonSanitizerOptions = {},
    path: readonly (string | number)[] = [],
): T {
    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            sanitizeParsedJson(entry, options, [...path, index]),
        ) as T;
    }
    if (value === null || typeof value !== "object") return value;

    const source = value as Record<string, unknown>;
    const sourcePrototype = Object.getPrototypeOf(source);
    if (sourcePrototype !== null && sourcePrototype !== Object.prototype) {
        options.onRejectedKey?.([...path, "__proto__"]);
    }

    const sanitized: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
        if (isPrototypePollutionKey(key)) {
            options.onRejectedKey?.([...path, key]);
            continue;
        }
        Object.defineProperty(sanitized, key, {
            value: sanitizeParsedJson(source[key], options, [...path, key]),
            enumerable: true,
            configurable: true,
            writable: true,
        });
    }
    return sanitized as T;
}

export interface JsoncParseIssue {
    line: number;
    column: number;
    offset: number;
    length: number;
    message: string;
}

export interface RecoveringJsoncParseResult<T> {
    value: T;
    issues: JsoncParseIssue[];
}

function lineAndColumnAt(content: string, offset: number): { line: number; column: number } {
    const before = content.slice(0, Math.max(0, offset));
    const lines = before.split(/\r?\n/);
    return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function parseIssue(content: string, error: ParseError): JsoncParseIssue {
    const location = lineAndColumnAt(content, error.offset);
    const code = printParseErrorCode(error.error);
    const message = code.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
    return {
        ...location,
        offset: error.offset,
        length: error.length,
        message,
    };
}

/**
 * Parse JSONC with the same recovery grammar used by the runtime config loaders.
 * Syntax diagnostics are never discarded: callers must surface every non-empty
 * `issues` result even when the parser recovered a usable object.
 */
function normalizeJsoncParserObjects(
    value: unknown,
    options: ParsedJsonSanitizerOptions,
    path: string[] = [],
): unknown {
    if (Array.isArray(value)) {
        return value.map((entry, index) =>
            normalizeJsoncParserObjects(entry, options, [...path, String(index)]),
        );
    }
    if (value === null || typeof value !== "object") return value;

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
        // jsonc-parser assigns an own "__proto__" property through normal JS
        // assignment, which changes only this parsed object's prototype. Treat
        // that prototype as the rejected key and copy only its own safe fields.
        options.onRejectedKey?.([...path, "__proto__"]);
    }
    const normalized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        Object.defineProperty(normalized, key, {
            configurable: true,
            enumerable: true,
            writable: true,
            value: normalizeJsoncParserObjects(entry, options, [...path, key]),
        });
    }
    return normalized;
}

export function parseJsoncRecovering<T = unknown>(
    content: string,
    options: ParsedJsonSanitizerOptions = {},
): RecoveringJsoncParseResult<T> {
    const errors: ParseError[] = [];
    const parsed = parseJsoncDocument(content, errors, {
        allowTrailingComma: true,
        disallowComments: false,
        allowEmptyContent: false,
    }) as T;
    return {
        value: sanitizeParsedJson(normalizeJsoncParserObjects(parsed, options) as T, options),
        issues: errors.map((error) => parseIssue(content, error)),
    };
}

export function parseJsonc<T = unknown>(
    content: string,
    options: ParsedJsonSanitizerOptions = {},
): T {
    const normalized = stripTrailingCommas(stripJsonComments(content));
    return sanitizeParsedJson(JSON.parse(normalized) as T, options);
}

export function readJsoncFile<T = unknown>(filePath: string): T | null {
    try {
        return parseJsonc<T>(readFileSync(filePath, "utf-8"));
    } catch (_error) {
        return null;
    }
}

export function detectConfigFile(basePath: string): {
    format: "json" | "jsonc" | "none";
    path: string;
} {
    const jsoncPath = `${basePath}.jsonc`;
    const jsonPath = `${basePath}.json`;

    if (existsSync(jsoncPath)) {
        return { format: "jsonc", path: jsoncPath };
    }

    if (existsSync(jsonPath)) {
        return { format: "json", path: jsonPath };
    }

    return { format: "none", path: jsoncPath };
}
