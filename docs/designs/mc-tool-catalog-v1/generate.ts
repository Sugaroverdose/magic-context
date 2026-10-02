/**
 * Builds the example `tool.catalog` payloads that accompany
 * `docs/designs/mc-tool-catalog-v1.md`.
 *
 * Run from the repository root:
 *
 *   bun docs/designs/mc-tool-catalog-v1/generate.ts          # write the files
 *   bun docs/designs/mc-tool-catalog-v1/generate.ts --check  # fail if any file differs
 *
 * Every model-facing string (tool descriptions, parameter descriptions and the
 * guidance text) is imported from the plugin's shipped sources, so a later
 * wording change shows up as a `--check` failure instead of drifting silently.
 * The argument-schema structures are written out here because they are what
 * this design proposes; the design document explains how each one differs from
 * what the plugin and the Rust module advertise today.
 *
 * This is a documentation helper. Nothing in the plugin or the module imports it.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildMagicContextSection } from "../../../packages/plugin/src/agents/magic-context-prompt";
import { CTX_EXPAND_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-expand/constants";
import { CTX_MEMORY_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-memory/constants";
import { CTX_NOTE_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-note/constants";
import { CTX_REDUCE_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-reduce/constants";
import { CTX_SEARCH_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-search/constants";
import {
    CTX_EXPAND_LIGHT_DESCRIPTION,
    CTX_MEMORY_LIGHT_DESCRIPTION,
    CTX_NOTE_LIGHT_DESCRIPTION,
    CTX_REDUCE_LIGHT_DESCRIPTION,
    CTX_SEARCH_LIGHT_DESCRIPTION,
} from "../../../packages/plugin/src/tools/light-descriptions";
import {
    FULL_PARAMETER_DESCRIPTIONS,
    LIGHT_PARAMETER_DESCRIPTIONS,
} from "../../../packages/plugin/src/tools/parameter-descriptions";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };
type Surface = "full" | "light";
type ToolId = "ctx_reduce" | "ctx_expand" | "ctx_note" | "ctx_memory" | "ctx_search";

/** Magic Context's daemon-registered module id (crates/mc-module/src/lib.rs, DEFAULT_MODULE_ID). */
const MODULE_ID = "magic-context";

/** Catalog order: the plugin's single list of ctx_* tools (ACTIVE_TOOL_IDS). */
const TOOL_ORDER: readonly ToolId[] = [
    "ctx_reduce",
    "ctx_expand",
    "ctx_note",
    "ctx_memory",
    "ctx_search",
];

/**
 * Tools served under `scope: read`: they write no project data (memories, notes).
 * Stamping with ctx_reduce only changes what this session's model sees.
 */
const READ_SCOPE_TOOLS: ReadonlySet<ToolId> = new Set(["ctx_reduce", "ctx_expand", "ctx_search"]);

const CAPABILITIES: Record<ToolId, string[]> = {
    ctx_reduce: ["magic-context:context.reduce/v1"],
    ctx_expand: ["magic-context:history.expand/v1"],
    ctx_note: ["magic-context:notes/v1"],
    ctx_memory: ["magic-context:memory.write/v1"],
    ctx_search: ["magic-context:archive.search/v1"],
};

/**
 * Hooks may add text before or after a Magic Context result but never replace
 * it: ctx_expand and ctx_search return archived conversation and memories, and
 * the guidance tells the model to trust that content as the exact record.
 */
const RESULT_OPS: string[] = ["prepend", "append"];

const SEMANTICS = 1;

const FULL_DESCRIPTIONS: Record<ToolId, string> = {
    ctx_reduce: CTX_REDUCE_DESCRIPTION,
    ctx_expand: CTX_EXPAND_DESCRIPTION,
    ctx_note: CTX_NOTE_DESCRIPTION,
    ctx_memory: CTX_MEMORY_DESCRIPTION,
    ctx_search: CTX_SEARCH_DESCRIPTION,
};

const LIGHT_DESCRIPTIONS: Record<ToolId, string> = {
    ctx_reduce: CTX_REDUCE_LIGHT_DESCRIPTION,
    ctx_expand: CTX_EXPAND_LIGHT_DESCRIPTION,
    ctx_note: CTX_NOTE_LIGHT_DESCRIPTION,
    ctx_memory: CTX_MEMORY_LIGHT_DESCRIPTION,
    ctx_search: CTX_SEARCH_LIGHT_DESCRIPTION,
};

const MEMORY_CATEGORIES = ["PROJECT_RULES", "ARCHITECTURE", "CONSTRAINTS", "CONFIG_VALUES", "NAMING"];

/**
 * The proposed argument structures, without descriptions. Property order is
 * the order the plugin declares them in; it never affects a digest.
 */
const STRUCTURES: Record<ToolId, JsonObject> = {
    ctx_reduce: {
        type: "object",
        properties: { drop: { type: "string" } },
        required: ["drop"],
        additionalProperties: false,
    },
    ctx_expand: {
        type: "object",
        properties: {
            tag: { anyOf: [{ type: "number" }, { type: "string" }] },
            start: { type: "integer", minimum: 0 },
            end: { type: "integer", minimum: 0 },
            verbose: { type: "boolean" },
            message: { type: "integer", minimum: 0 },
        },
        additionalProperties: false,
    },
    ctx_note: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["write", "read", "update", "dismiss"] },
            content: { type: "string", maxLength: 65536 },
            surface_condition: { type: "string", maxLength: 4096 },
            filter: { type: "string", enum: ["all", "active", "pending", "ready", "dismissed"] },
            limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
            offset: { type: "integer", minimum: 0, default: 0 },
            note_ids: {
                type: "array",
                minItems: 1,
                maxItems: 50,
                items: { type: "integer", minimum: 1, maximum: 9007199254740991 },
            },
        },
        additionalProperties: false,
    },
    ctx_memory: {
        type: "object",
        properties: {
            action: { type: "string", enum: ["write", "update", "archive", "merge", "get"] },
            content: { type: "string", maxLength: 65536 },
            category: { type: "string", enum: MEMORY_CATEGORIES },
            ids: { type: "array", maxItems: 100, items: { type: "integer", minimum: 1 } },
            reason: { type: "string", maxLength: 4096 },
        },
        additionalProperties: false,
    },
    ctx_search: {
        type: "object",
        properties: {
            query: { type: "string", maxLength: 1024 },
            limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
            from: { type: "string" },
            to: { type: "string" },
            sources: {
                type: "array",
                items: {
                    type: "string",
                    enum: ["memory", "message", "git_commit", "primer", "note"],
                },
            },
        },
        required: ["query"],
        additionalProperties: false,
    },
};

/** The user and project configuration every example resolves against. */
interface ResolvedConfig {
    compaction_enabled: boolean;
    memory_enabled: boolean;
    dreamer_runnable: boolean;
    temporal_awareness: boolean;
    caveman_text_compression: boolean;
    language: string | null;
    prompt_surface: { default: Surface; models: Record<string, Surface> };
    guidance_override_sha256: string | null;
    tool_descriptions: Record<string, string>;
    disabled_tools: string[];
}

const EXAMPLE_CONFIG: ResolvedConfig = {
    compaction_enabled: true,
    memory_enabled: true,
    dreamer_runnable: true,
    temporal_awareness: true,
    caveman_text_compression: false,
    language: null,
    prompt_surface: { default: "full", models: {} },
    guidance_override_sha256: null,
    tool_descriptions: {},
    disabled_tools: [],
};

// ── Canonical JSON and digests ────────────────────────────────────────────

/**
 * RFC 8785 (JCS) for the values these payloads hold: objects, arrays, strings,
 * booleans, null and safe integers. Key order is UTF-16 code-unit order, which
 * is what Array.prototype.sort gives for strings; strings and integers are
 * written exactly as JSON.stringify writes them, which is what RFC 8785 requires.
 */
export function jcs(value: Json): string {
    if (value === null || typeof value === "boolean" || typeof value === "string") {
        return JSON.stringify(value);
    }
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) {
            throw new Error(`generate.ts writes only safe integers, got ${value}`);
        }
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(jcs).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${jcs(value[key] as Json)}`).join(",")}}`;
}

export function sha256Hex(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
}

const SUBSCHEMA_KEYWORDS = new Set([
    "items",
    "additionalItems",
    "additionalProperties",
    "unevaluatedItems",
    "unevaluatedProperties",
    "not",
    "if",
    "then",
    "else",
    "contains",
    "propertyNames",
]);
const SUBSCHEMA_ARRAY_KEYWORDS = new Set(["prefixItems", "anyOf", "oneOf", "allOf"]);
const SUBSCHEMA_MAP_KEYWORDS = new Set([
    "properties",
    "patternProperties",
    "dependentSchemas",
    "$defs",
    "definitions",
]);

/** The tool-provider/v1 structural schema: `description` removed from every schema object. */
export function structuralSchema(schema: Json): Json {
    if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema;
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === "description") continue;
        if (SUBSCHEMA_KEYWORDS.has(key)) {
            out[key] = structuralSchema(value);
        } else if (SUBSCHEMA_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
            out[key] = value.map(structuralSchema);
        } else if (
            SUBSCHEMA_MAP_KEYWORDS.has(key) &&
            value !== null &&
            typeof value === "object" &&
            !Array.isArray(value)
        ) {
            out[key] = Object.fromEntries(
                Object.entries(value).map(([name, sub]) => [name, structuralSchema(sub)]),
            );
        } else {
            out[key] = value;
        }
    }
    return out;
}

export function schemaDigest(schema: Json): string {
    return sha256Hex(jcs(structuralSchema(schema)));
}

// ── Resolution ───────────────────────────────────────────────────────────

interface CatalogRequest {
    preset?: string;
    params: JsonObject;
    composition?: JsonObject;
    system_text?: { preset: string; params: JsonObject };
    digest_only?: boolean;
}

function resolvedSurface(params: JsonObject, config: ResolvedConfig): Surface {
    const model = typeof params.model === "string" ? params.model : undefined;
    return (model && config.prompt_surface.models[model]) || config.prompt_surface.default;
}

function toolSurface(params: JsonObject, config: ResolvedConfig): Surface {
    if (params.tool_descs === "concise") return "light";
    if (params.tool_descs === "full") return "full";
    return resolvedSurface(params, config);
}

function textSurface(params: JsonObject, config: ResolvedConfig): Surface {
    if (params.surface === "light" || params.surface === "full") return params.surface;
    return resolvedSurface(params, config);
}

function inputSchema(tool: ToolId, surface: Surface): JsonObject {
    const table = surface === "light" ? LIGHT_PARAMETER_DESCRIPTIONS : FULL_PARAMETER_DESCRIPTIONS;
    const descriptions = table[tool] as Record<string, string>;
    const structure = STRUCTURES[tool];
    const properties = structure.properties as JsonObject;
    const described: JsonObject = {};
    for (const [name, sub] of Object.entries(properties)) {
        const text = descriptions[name];
        if (text === undefined) throw new Error(`no ${surface} description for ${tool}.${name}`);
        described[name] = { ...(sub as JsonObject), description: text };
    }
    return { ...structure, properties: described };
}

function servedToolIds(request: CatalogRequest, config: ResolvedConfig): ToolId[] {
    const exclude = new Set((request.params.exclude as string[] | undefined) ?? []);
    const scope = (request.params.scope as string | undefined) ?? "all";
    return TOOL_ORDER.filter((tool) => {
        if (tool === "ctx_reduce" && !config.compaction_enabled) return false;
        if (tool === "ctx_memory" && !config.memory_enabled) return false;
        if (config.disabled_tools.includes(tool)) return false;
        if (exclude.has(tool)) return false;
        if (scope === "read" && !READ_SCOPE_TOOLS.has(tool)) return false;
        return true;
    });
}

function catalogTools(request: CatalogRequest, config: ResolvedConfig): JsonObject[] {
    const surface = toolSurface(request.params, config);
    return servedToolIds(request, config).map((tool) => {
        const schema = inputSchema(tool, surface);
        const description =
            config.tool_descriptions[tool] ??
            (surface === "light" ? LIGHT_DESCRIPTIONS[tool] : FULL_DESCRIPTIONS[tool]);
        return {
            name: tool,
            schema_digest: schemaDigest(schema),
            semantics: SEMANTICS,
            result_ops: RESULT_OPS,
            capabilities: CAPABILITIES[tool],
            description,
            input_schema: schema,
        };
    });
}

/**
 * Magic Context's own tool names as the request's composition lists them. A
 * preflight request carries no composition, so the served tool names stand in.
 */
function ownToolNames(request: CatalogRequest, served: ToolId[]): Set<string> {
    const providers = request.composition?.providers as JsonObject[] | undefined;
    if (!providers) return new Set(served);
    const own = providers.find((entry) => entry.provider === MODULE_ID);
    const tools = (own?.tools as JsonObject[] | undefined) ?? [];
    return new Set(tools.map((tool) => tool.name as string));
}

function guidanceText(request: CatalogRequest, config: ResolvedConfig): string {
    const item = request.system_text;
    if (!item) throw new Error("guidanceText needs a system_text item");
    const own = ownToolNames(request, servedToolIds(request, config));
    for (const required of ["ctx_expand", "ctx_search", "ctx_note"]) {
        if (!own.has(required)) {
            throw new Error(`no shipped text names the session without ${required} (open question 3)`);
        }
    }
    const reduce = own.has("ctx_reduce");
    const memory = config.memory_enabled && own.has("ctx_memory");
    const surface = textSurface(item.params, config);
    if (item.preset === "subagent") {
        // A subagent without ctx_reduce has no tagged messages and no archive use,
        // so it gets no guidance (the OpenCode plugin behaves the same way).
        if (!reduce) return "";
        return buildMagicContextSection(
            null,
            0,
            true,
            false,
            false,
            false,
            true,
            undefined,
            false,
            surface,
        );
    }
    if (item.preset !== "primary") throw new Error(`unknown preset ${item.preset}`);
    return buildMagicContextSection(
        null,
        0,
        reduce,
        config.dreamer_runnable,
        config.temporal_awareness,
        config.caveman_text_compression,
        false,
        config.language ?? undefined,
        memory,
        surface,
    );
}

/** A hash over every model-facing string this build ships, so a wording change moves the digest. */
function textRevision(): string {
    const guidance: string[] = [];
    for (const surface of ["full", "light"] as Surface[]) {
        for (const reduce of [true, false]) {
            guidance.push(
                buildMagicContextSection(null, 0, reduce, true, true, false, false, undefined, true, surface),
            );
        }
        guidance.push(
            buildMagicContextSection(null, 0, true, false, false, false, true, undefined, false, surface),
        );
    }
    return sha256Hex(
        jcs({
            guidance,
            descriptions: { full: FULL_DESCRIPTIONS, light: LIGHT_DESCRIPTIONS },
            parameters: {
                full: FULL_PARAMETER_DESCRIPTIONS as unknown as JsonObject,
                light: LIGHT_PARAMETER_DESCRIPTIONS as unknown as JsonObject,
            },
        } as JsonObject),
    );
}

function preflightDigest(
    item: { preset: string; params: JsonObject },
    config: ResolvedConfig,
): string {
    return sha256Hex(
        jcs({
            format: "magic-context/preflight/1",
            preset: item.preset,
            params: item.params,
            config: config as unknown as JsonObject,
            text_revision: textRevision(),
        }),
    );
}

function answer(request: CatalogRequest, config: ResolvedConfig): JsonObject {
    const content: JsonObject = {};
    const compositionDigest = request.composition ? sha256Hex(jcs(request.composition)) : undefined;
    if (compositionDigest) content.composition_digest = compositionDigest;
    content.tools = catalogTools(request, config);
    if (request.system_text) {
        const text = guidanceText(request, config);
        const systemText: JsonObject = {
            text,
            item_digest: sha256Hex(text),
            preflight_digest: preflightDigest(request.system_text, config),
        };
        if (compositionDigest) systemText.composition_digest = compositionDigest;
        content.system_text = systemText;
    }
    const catalogDigest = sha256Hex(jcs(content));
    if (request.digest_only) return { generation: catalogDigest, catalog_digest: catalogDigest };
    return { generation: catalogDigest, catalog_digest: catalogDigest, ...content };
}

// ── Example compositions ─────────────────────────────────────────────────

function mcEntry(tools: ToolId[]): JsonObject {
    return {
        provider: MODULE_ID,
        tools: [...tools].sort().map((name) => ({ name, capabilities: CAPABILITIES[name] })),
    };
}

/**
 * Part of the AFT file-tools module's catalog for a head session run by Broca,
 * with the capability tags AFT's own catalog fixture declares for those tools.
 */
const AFT_HEAD: JsonObject = {
    provider: "aft",
    tools: [
        { name: "bash", capabilities: ["shell.exec/v1"] },
        { name: "bash_status", capabilities: ["shell.exec/v1"] },
        { name: "edit", capabilities: ["code.edit/v1"] },
        { name: "outline", capabilities: ["code.outline/v1"] },
        { name: "read", capabilities: ["code.read/v1"] },
        { name: "search", capabilities: ["code.search/v1"] },
        { name: "zoom", capabilities: ["code.outline/v1"] },
    ],
};

const PREFRONTAL_HEAD: JsonObject = {
    provider: "prefrontal-core",
    tools: [
        { name: "browser_use", capabilities: ["browser.use/v1"] },
        { name: "computer_use", capabilities: ["computer.use/v1"] },
    ],
};

const ALL_TOOLS: ToolId[] = [...TOOL_ORDER];
const WITHOUT_REDUCE: ToolId[] = TOOL_ORDER.filter((tool) => tool !== "ctx_reduce");

interface Example {
    name: string;
    request: CatalogRequest;
}

const EXAMPLES: Example[] = [
    {
        name: "preflight",
        request: { preset: "primary", params: {} },
    },
    {
        name: "primary-full",
        request: {
            preset: "primary",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS), PREFRONTAL_HEAD] },
            system_text: { preset: "primary", params: {} },
        },
    },
    {
        name: "primary-full.digest-only",
        request: {
            preset: "primary",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS), PREFRONTAL_HEAD] },
            system_text: { preset: "primary", params: {} },
            digest_only: true,
        },
    },
    {
        name: "primary-light",
        request: {
            preset: "primary",
            params: { tool_descs: "concise" },
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS), PREFRONTAL_HEAD] },
            system_text: { preset: "primary", params: { surface: "light" } },
        },
    },
    {
        name: "subagent",
        request: {
            preset: "subagent",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(ALL_TOOLS)] },
            system_text: { preset: "subagent", params: {} },
        },
    },
    {
        name: "no-reduce",
        request: {
            preset: "primary",
            params: { exclude: ["ctx_reduce"] },
            composition: { providers: [AFT_HEAD, mcEntry(WITHOUT_REDUCE), PREFRONTAL_HEAD] },
            system_text: { preset: "primary", params: {} },
        },
    },
];

// ── Output ───────────────────────────────────────────────────────────────

function outputs(): Map<string, string> {
    const files = new Map<string, string>();
    for (const { name, request } of EXAMPLES) {
        const reply = answer(request, EXAMPLE_CONFIG);
        files.set(`${name}.request.json`, `${JSON.stringify(request, null, 2)}\n`);
        files.set(`${name}.answer.json`, `${JSON.stringify(reply, null, 2)}\n`);
        files.set(`${name}.answer.jcs`, jcs(reply));
        const systemText = reply.system_text as JsonObject | undefined;
        if (systemText) files.set(`text/${name}.txt`, systemText.text as string);
    }
    files.set(
        "config.json",
        `${JSON.stringify({ config: EXAMPLE_CONFIG, text_revision: textRevision() }, null, 2)}\n`,
    );
    return files;
}

function main(): void {
    const here = dirname(new URL(import.meta.url).pathname);
    const check = process.argv.includes("--check");
    const differing: string[] = [];
    for (const [relative, content] of outputs()) {
        const path = join(here, relative);
        if (check) {
            let current: string | undefined;
            try {
                current = readFileSync(path, "utf8");
            } catch {
                current = undefined;
            }
            if (current !== content) differing.push(relative);
        } else {
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(path, content);
        }
    }
    if (check && differing.length > 0) {
        console.error(`out of date: ${differing.join(", ")}`);
        process.exit(1);
    }
    console.log(check ? "all example files are current" : "wrote example files");
}

if (import.meta.main) main();
