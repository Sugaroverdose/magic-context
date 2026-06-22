/**
 * Minimal JSONC parse/format shared by the config editors.
 *
 * Ported from `packages/plugin/src/shared/jsonc-parser.ts`: strips line/block
 * comments AND trailing commas (both valid JSONC — the style doctor/setup write
 * by default), respecting string literals, then JSON.parse. Used to read config
 * files for structured editing; output is re-serialized as plain 2-space JSON.
 */

function stripJsonComments(content: string): string {
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
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
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
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
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
      if (next === "}" || next === "]") continue;
    }
    result += char;
  }
  return result;
}

/** Parse JSONC into an object, or `{}` on any failure. */
export function parseJsonc(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(text)));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Pretty-print as plain JSON (2-space indent). Comments are not preserved. */
export function formatJsonc(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
