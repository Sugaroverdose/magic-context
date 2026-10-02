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
 * this design decides; the design document explains how each one differs from
 * what the plugin and the Rust module advertise today.
 *
 * Both modes also check what the payloads promise:
 *
 * - each example text equals the Rust module's shipped guidance asset for the
 *   same variant (`crates/mc-module/assets/`);
 * - every capability tag passes the tool-provider role's tag check;
 * - `ctx_reduce` keeps its frozen name and structural schema;
 * - this file's JCS and schema-digest code reproduces the digests in the
 *   commons and prefrontal test vectors, read with `git show` at pinned
 *   commits. The two repositories are looked up next to the main checkout of
 *   this one, or at `MC_CATALOG_COMMONS_REPO` and `MC_CATALOG_PREFRONTAL_REPO`.
 *   When one is missing the run says so and skips that cross-check.
 *
 * This is a documentation helper. Nothing in the plugin or the module imports it.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { buildMagicContextSection } from "../../../packages/plugin/src/agents/magic-context-prompt";
import { CTX_EXPAND_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-expand/constants";
import { CTX_MEMORY_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-memory/constants";
import { CTX_NOTE_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-note/constants";
import { CTX_REDUCE_DESCRIPTION } from "../../../packages/plugin/src/tools/ctx-reduce/constants";
import { resolvePromptSurface } from "../../../packages/plugin/src/shared/prompt-surface";
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

/**
 * The presets Magic Context defines. `primary` and `subagent` are sent only when
 * Magic Context is the session's compaction provider; `tools-only` is sent when
 * another provider compacts, so nothing in the session carries Magic Context's
 * tags and `ctx_reduce` would have nothing to stamp.
 */
const PRESETS = ["primary", "subagent", "tools-only"] as const;
type Preset = (typeof PRESETS)[number];

const TOOL_PARAMS = new Set(["scope", "tool_descs", "exclude", "behavior", "model"]);
const TEXT_PARAMS = new Set(["surface", "model"]);

/** Magic Context's daemon-registered module id (crates/mc-module/src/lib.rs, DEFAULT_MODULE_ID). */
const MODULE_ID = "magic-context";

/**
 * `ctx_reduce`'s name and structural schema are frozen for v1. The Claude Code
 * gateway grants stamping authority only to a tool with exactly this name and
 * schema, so changing either here without a matching gateway change would turn
 * stamping off on Claude Code. Any change to either must ship in the same
 * release as the gateway change that recognises it.
 */
const FROZEN_CTX_REDUCE_SCHEMA_DIGEST =
    "69c7dd3393dc8af19386eb80f849df7a1943126bfe1a14769bfff1182b88abf6";

/**
 * The unprefixed capability tags the tool-provider role defines
 * (`DEFINED_CAPABILITY_TAGS` in commons' cortexkit-role-tool-provider 0.4.2).
 * The cross-check below compares this list with the crate's.
 */
const DEFINED_CAPABILITY_TAGS = [
    "shell.exec/v1",
    "code.read/v1",
    "code.edit/v1",
    "code.search/v1",
    "code.files/v1",
    "code.outline/v1",
    "code.callgraph/v1",
    "code.diagnostics/v1",
];

/**
 * A port of `check_capability_tag` from cortexkit-role-tool-provider 0.4.2:
 * a tag is one of the defined unprefixed tags, or `<namespace>:<name>/v<N>`
 * with a namespace of lowercase letters and digits in `-`-separated words, a
 * name of `.`-separated words of lowercase letters, digits and `_`, and a
 * version with no leading zero. Returns the problem, or null for a good tag.
 */
export function capabilityTagProblem(tag: string): string | null {
    const colon = tag.indexOf(":");
    if (colon < 0) {
        return DEFINED_CAPABILITY_TAGS.includes(tag) ? null : "undefined unprefixed tag";
    }
    const namespace = tag.slice(0, colon);
    const rest = tag.slice(colon + 1);
    if (namespace === "") return "empty namespace";
    if (!namespace.split("-").every((word) => /^[a-z0-9]+$/.test(word))) {
        return "malformed namespace";
    }
    const versionAt = rest.lastIndexOf("/v");
    if (versionAt < 0) return "malformed name";
    const name = rest.slice(0, versionAt);
    const version = rest.slice(versionAt + 2);
    if (!/^[1-9][0-9]*$/.test(version)) return "malformed name";
    if (!name.split(".").every((word) => /^[a-z0-9_]+$/.test(word))) return "malformed name";
    return null;
}

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
    prompt_surface: { default: "full", models: { "anthropic/claude-haiku-4-5": "light" } },
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

/**
 * The surface from Magic Context's own config: the request's optional `model`
 * param (the starter fixes it when it builds the session's plan, so a later
 * model switch changes nothing until the next refresh) looked up in
 * `prompt_surface.models` through the plugin's model-key walk, then
 * `prompt_surface.default`.
 */
function resolvedSurface(params: JsonObject, config: ResolvedConfig): Surface {
    const model = typeof params.model === "string" ? params.model : undefined;
    return resolvePromptSurface(config.prompt_surface, model).preset;
}

/** The request's preset, refusing anything Magic Context does not define. */
function requestPreset(request: CatalogRequest): Preset {
    const preset = request.preset ?? "primary";
    if (!(PRESETS as readonly string[]).includes(preset)) {
        throw new Error(`invalid_request {field: "preset"}: ${preset}`);
    }
    if (request.system_text && request.system_text.preset !== preset) {
        throw new Error("the tool item and the text item must name the same preset");
    }
    return preset as Preset;
}

function checkParams(params: JsonObject, allowed: Set<string>, field: string): void {
    for (const key of Object.keys(params)) {
        if (!allowed.has(key)) throw new Error(`invalid_request {field: "${field}.${key}"}`);
    }
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
    for (const name of exclude) {
        if (!(TOOL_ORDER as readonly string[]).includes(name)) {
            throw new Error(`invalid_request {field: "params.exclude"}: ${name}`);
        }
    }
    const scope = (request.params.scope as string | undefined) ?? "all";
    const preset = requestPreset(request);
    return TOOL_ORDER.filter((tool) => {
        if (tool === "ctx_reduce" && !config.compaction_enabled) return false;
        if (tool === "ctx_reduce" && preset === "tools-only") return false;
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
        if (tool === "ctx_reduce" && schemaDigest(schema) !== FROZEN_CTX_REDUCE_SCHEMA_DIGEST) {
            throw new Error("ctx_reduce's schema is frozen for v1; change it only with the gateway");
        }
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
    const preset = requestPreset(request);
    const reduce = own.has("ctx_reduce");
    const memory = config.memory_enabled && own.has("ctx_memory");
    const surface = textSurface(item.params, config);
    if (preset === "tools-only") {
        // Another provider compacts the session, so Magic Context adds no §N§
        // tags to its messages and ctx_reduce would have nothing to drop. The
        // text is the one built for a session without ctx_reduce: it neither
        // explains dropping items by tag nor asks the model to start replies
        // with a tag, whatever the session's role. servedToolIds never serves
        // ctx_reduce here, and answer() refuses a composition that lists it.
        return buildMagicContextSection(
            null,
            0,
            false,
            config.dreamer_runnable,
            config.temporal_awareness,
            config.caveman_text_compression,
            false,
            config.language ?? undefined,
            memory,
            surface,
        );
    }
    if (preset === "subagent") {
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

/**
 * Refuse an example whose composition lists different Magic Context tools than
 * the request serves: the runner refuses such a fetch, and the text is chosen
 * from the composition, so the example would describe tools it doesn't have.
 */
function checkCompositionMatches(request: CatalogRequest, served: ToolId[]): void {
    if (!request.composition) return;
    const listed = [...ownToolNames(request, served)].sort();
    const expected = [...served].sort();
    if (jcs(listed) !== jcs(expected)) {
        throw new Error(`composition lists ${listed.join(",")} but the request serves ${expected.join(",")}`);
    }
}

/** Every capability tag in a value, wherever a `capabilities` array holds it. */
function capabilityTags(value: Json, found: string[] = []): string[] {
    if (Array.isArray(value)) {
        for (const item of value) capabilityTags(item, found);
    } else if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            if (key === "capabilities" && Array.isArray(item)) {
                for (const tag of item) if (typeof tag === "string") found.push(tag);
            } else {
                capabilityTags(item, found);
            }
        }
    }
    return found;
}

function answer(request: CatalogRequest, config: ResolvedConfig): JsonObject {
    checkParams(request.params, TOOL_PARAMS, "params");
    if (request.system_text) checkParams(request.system_text.params, TEXT_PARAMS, "system_text.params");
    checkCompositionMatches(request, servedToolIds(request, config));
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

/**
 * Prefrontal's forwarding tools. The role defines no unprefixed browser or
 * computer tag, so these carry a namespace to pass the tag check; the
 * namespace is illustrative, and only its shape matters to these examples.
 */
const PREFRONTAL_HEAD: JsonObject = {
    provider: "prefrontal-core",
    tools: [
        { name: "browser_use", capabilities: ["prefrontal-core:browser.use/v1"] },
        { name: "computer_use", capabilities: ["prefrontal-core:computer.use/v1"] },
    ],
};

const ALL_TOOLS: ToolId[] = [...TOOL_ORDER];
const WITHOUT_REDUCE: ToolId[] = TOOL_ORDER.filter((tool) => tool !== "ctx_reduce");

interface Example {
    name: string;
    request: CatalogRequest;
    /** The Rust module's shipped guidance asset this example's text must equal, if any. */
    rustAsset?: string;
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
        rustAsset: "guidance_primary.txt",
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
        rustAsset: "guidance_light_primary.txt",
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
        rustAsset: "guidance_no_reduce.txt",
    },
    {
        name: "tools-only",
        request: {
            preset: "tools-only",
            params: {},
            composition: { providers: [AFT_HEAD, mcEntry(WITHOUT_REDUCE), PREFRONTAL_HEAD] },
            system_text: { preset: "tools-only", params: {} },
        },
        rustAsset: "guidance_no_reduce.txt",
    },
    {
        // The surface comes from the frozen `model` param, looked up in the
        // example config's `prompt_surface.models`, not from explicit params.
        name: "tools-only-light",
        request: {
            preset: "tools-only",
            params: { model: "anthropic/claude-haiku-4-5" },
            composition: { providers: [AFT_HEAD, mcEntry(WITHOUT_REDUCE), PREFRONTAL_HEAD] },
            system_text: { preset: "tools-only", params: { model: "anthropic/claude-haiku-4-5" } },
        },
        rustAsset: "guidance_light_no_reduce.txt",
    },
];

// ── Output ───────────────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), "..", "..", "..");

function outputs(): Map<string, string> {
    const files = new Map<string, string>();
    for (const { name, request, rustAsset } of EXAMPLES) {
        const reply = answer(request, EXAMPLE_CONFIG);
        for (const tag of capabilityTags([request as unknown as Json, reply])) {
            const problem = capabilityTagProblem(tag);
            if (problem) throw new Error(`${name}: capability tag ${tag}: ${problem}`);
        }
        if (rustAsset) {
            const asset = readFileSync(join(REPO_ROOT, "crates/mc-module/assets", rustAsset), "utf8");
            const text = (reply.system_text as JsonObject | undefined)?.text;
            if (text !== asset) throw new Error(`${name}: text differs from ${rustAsset}`);
        }
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

// ── Cross-checks against the tool-provider and fetch-plan test vectors ────

/** commons at cortexkit-role-tool-provider 0.4.2, which defines the unprefixed tags. */
const COMMONS_REF = "57305c74426123067e7647bab628a00a1706a176";
/**
 * prefrontal at a commit whose fetch-plan vectors (compositions and plans, each
 * as pretty JSON, JCS bytes and SHA-256) the design document cites.
 */
const PREFRONTAL_REF = "26590b8d4e45a7bab38c1ab2ddef8294dc9d228a";

function git(repo: string, args: string[]): string | undefined {
    const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 << 20 });
    return run.status === 0 ? run.stdout : undefined;
}

/**
 * A sibling repository: the environment variable when set, otherwise the
 * directory next to this repository's main checkout. A worktree's
 * `--git-common-dir` is the main checkout's `.git`, so this also works from one.
 */
function siblingRepo(envName: string, dirName: string): string | undefined {
    const fromEnv = process.env[envName];
    if (fromEnv) return fromEnv;
    const common = git(REPO_ROOT, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common) return undefined;
    const candidate = join(dirname(dirname(common.trim())), dirName);
    return existsSync(candidate) ? candidate : undefined;
}

/** True when every number in the value is a safe integer, the only kind this file's JCS writes. */
function integersOnly(value: Json): boolean {
    if (typeof value === "number") return Number.isSafeInteger(value) && !Object.is(value, -0);
    if (Array.isArray(value)) return value.every(integersOnly);
    if (value !== null && typeof value === "object") return Object.values(value).every(integersOnly);
    return true;
}

interface CrossCheck {
    failures: string[];
    report: string[];
}

function crossCheckCommons(repo: string, out: CrossCheck): void {
    const show = (path: string) => git(repo, ["show", `${COMMONS_REF}:${path}`]);
    const compositions = show("test-vectors/tool-provider-v1/composition-digest.json");
    const schemas = show("test-vectors/tool-provider-v1/schema-digest.json");
    const lib = show("crates/cortexkit-role-tool-provider/src/lib.rs");
    if (!compositions || !schemas || !lib) {
        out.report.push(`commons: skipped, ${COMMONS_REF.slice(0, 8)} not readable in ${repo}`);
        return;
    }
    let checked = 0;
    let skipped = 0;
    for (const vector of JSON.parse(compositions).digests as JsonObject[]) {
        if (!integersOnly(vector.composition as Json)) {
            skipped++;
            continue;
        }
        checked++;
        const bytes = jcs(vector.composition as Json);
        if (bytes !== vector.jcs || sha256Hex(bytes) !== vector.composition_digest) {
            out.failures.push(`commons composition-digest: ${vector.name}`);
        }
    }
    const schemaFile = JSON.parse(schemas) as Record<string, JsonObject[]>;
    for (const vector of schemaFile.digests ?? []) {
        if (!integersOnly(vector.schema as Json)) {
            skipped++;
            continue;
        }
        checked++;
        if (schemaDigest(vector.schema as Json) !== vector.schema_digest) {
            out.failures.push(`commons schema-digest: ${vector.name}`);
        }
    }
    for (const [kind, same] of [
        ["same_digest", true],
        ["different_digest", false],
    ] as const) {
        for (const pair of schemaFile[kind] ?? []) {
            if (!integersOnly(pair.a as Json) || !integersOnly(pair.b as Json)) {
                skipped++;
                continue;
            }
            checked++;
            const equal = schemaDigest(pair.a as Json) === schemaDigest(pair.b as Json);
            if (equal !== same) out.failures.push(`commons schema-digest ${kind}: ${pair.name}`);
        }
    }
    const block = /DEFINED_CAPABILITY_TAGS: &\[&str\] = &\[([\s\S]*?)\];/.exec(lib)?.[1] ?? "";
    const crateTags = [...block.replaceAll(/\/\/.*$/gm, "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    if (jcs(crateTags) !== jcs(DEFINED_CAPABILITY_TAGS)) {
        out.failures.push(`commons DEFINED_CAPABILITY_TAGS is ${crateTags.join(", ")}`);
    }
    out.report.push(
        `commons ${COMMONS_REF.slice(0, 8)}: ${checked} digest vectors match (${skipped} with floats skipped); defined tags match`,
    );
}

function crossCheckPrefrontal(repo: string, out: CrossCheck): void {
    const dir = "test-vectors/fetch-plan-v1";
    const listing = git(repo, ["ls-tree", "-r", "--name-only", PREFRONTAL_REF, "--", dir]);
    if (!listing) {
        out.report.push(`prefrontal: skipped, ${PREFRONTAL_REF.slice(0, 8)} not readable in ${repo}`);
        return;
    }
    let checked = 0;
    let skipped = 0;
    for (const path of listing.split("\n").filter((line) => line.endsWith(".jcs"))) {
        const stem = path.slice(0, -".jcs".length);
        const show = (suffix: string) => git(repo, ["show", `${PREFRONTAL_REF}:${stem}${suffix}`]);
        const pretty = show(".json");
        const bytes = show(".jcs");
        const digest = show(".sha256");
        if (pretty === undefined || bytes === undefined || digest === undefined) continue;
        const value = JSON.parse(pretty) as Json;
        if (!integersOnly(value)) {
            skipped++;
            continue;
        }
        checked++;
        if (jcs(value) !== bytes || sha256Hex(bytes) !== digest.trim()) {
            out.failures.push(`prefrontal ${stem.slice(dir.length + 1)}`);
        }
    }
    if (checked === 0) out.failures.push("prefrontal: no fetch-plan vectors found");
    out.report.push(
        `prefrontal ${PREFRONTAL_REF.slice(0, 8)}: ${checked} fetch-plan vectors match (${skipped} with floats skipped)`,
    );
}

function crossCheck(): CrossCheck {
    const out: CrossCheck = { failures: [], report: [] };
    const commons = siblingRepo("MC_CATALOG_COMMONS_REPO", "commons");
    if (commons) crossCheckCommons(commons, out);
    else out.report.push("commons: skipped, repository not found");
    const prefrontal = siblingRepo("MC_CATALOG_PREFRONTAL_REPO", "prefrontal");
    if (prefrontal) crossCheckPrefrontal(prefrontal, out);
    else out.report.push("prefrontal: skipped, repository not found");
    return out;
}

function main(): void {
    const here = dirname(new URL(import.meta.url).pathname);
    const check = process.argv.includes("--check");
    const crossChecks = crossCheck();
    for (const line of crossChecks.report) console.log(`cross-check ${line}`);
    if (crossChecks.failures.length > 0) {
        console.error(`cross-check failed: ${crossChecks.failures.join("; ")}`);
        process.exit(1);
    }
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
