type ParsedEmbeddingModel = {
    base: string;
    tag?: string;
};

function parseEmbeddingModel(model: string): ParsedEmbeddingModel {
    const lastColon = model.lastIndexOf(":");
    // Colons in host-like prefixes (for example `host:port/model`) are not
    // model tags because they occur before the final slash.
    if (lastColon > model.lastIndexOf("/")) {
        return { base: model.slice(0, lastColon), tag: model.slice(lastColon + 1) };
    }
    return { base: model };
}

/** Lowercase, trim, and remove an OpenRouter/Ollama-style trailing model tag. */
export function normalizeEmbeddingModelId(model: string): string {
    return parseEmbeddingModel(model.trim().toLowerCase()).base;
}

function matchNormalizedEmbeddingModels(a: string, b: string): boolean {
    if (a.length === 0 || b.length === 0) return true; // can't compare → don't reject
    if (a === b) return true;
    const longer = a.length >= b.length ? a : b;
    const shorter = a.length >= b.length ? b : a;
    const isBoundary = (ch: string) => ch === "-" || ch === "/";
    // Version-expansion: longer = shorter + boundary + suffix (e.g. `…-small` → `…-small-v1`).
    if (longer.startsWith(shorter) && isBoundary(longer.charAt(shorter.length))) return true;
    // Vendor-prefix trim: longer = prefix + boundary + shorter (e.g. `openai/X` ↔ `X`).
    if (longer.endsWith(shorter) && isBoundary(longer.charAt(longer.length - shorter.length - 1)))
        return true;
    return false;
}

/**
 * Whether the model an endpoint served is the model we asked for.
 *
 * Exact match after trim+lowercase, with TOKEN-BOUNDARY prefix/suffix tolerance
 * so a server that version-expands a name (`text-embedding-3-small` →
 * `…-small-v1`) or trims a vendor prefix (`openai/text-embedding-3-small` →
 * `text-embedding-3-small`) still counts as a match. OpenRouter routing tags
 * such as `:free` are ignored when only one side has a tag, while tags on both
 * sides must be equal so Ollama model-size tags remain distinct.
 *
 * Crucially this is NOT a plain substring test. A loose `a.includes(b)` would
 * MATCH a broadly-configured name against an unrelated served model that merely
 * contains it as a middle token — e.g. configured `qwen3-embedding`, served
 * `text-embedding-qwen3-embedding-0.6b` → store 0.6b vectors under the broad
 * identity (wrong-dim corruption, the exact failure this guard exists to stop).
 * So the shorter name must align on a `-`/`/` boundary as a genuine PREFIX or
 * SUFFIX of the longer, never as an interior fragment.
 */
export function embeddingModelsMatch(served: string, requested: string): boolean {
    const servedNormalized = served.trim().toLowerCase();
    const requestedNormalized = requested.trim().toLowerCase();
    const servedModel = parseEmbeddingModel(servedNormalized);
    const requestedModel = parseEmbeddingModel(requestedNormalized);

    // Matching tags identify the same provider-specific model variant. Different
    // tags can identify different weights or sizes, so they must never be ignored.
    if (
        servedModel.tag !== undefined &&
        requestedModel.tag !== undefined &&
        servedModel.tag !== requestedModel.tag
    ) {
        return false;
    }

    // With zero or one tag, compare the untagged names using every existing rule.
    return matchNormalizedEmbeddingModels(servedModel.base, requestedModel.base);
}

export interface EmbeddingTextPrefixes {
    queryPrefix: string;
    documentPrefix: string;
}

/**
 * Canonical Qwen3 retrieval recipe. Keep these bytes aligned across embedding
 * clients. The Qwen model card uses this web-search task and reports that an
 * instruction typically improves downstream results by about 1–5%:
 * https://huggingface.co/Qwen/Qwen3-Embedding-8B
 */
export const QWEN3_QUERY_INSTRUCTION =
    "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

const INSTRUCT_WEB_SEARCH_QUERY_PREFIX = QWEN3_QUERY_INSTRUCTION;

export interface EmbeddingModelPrefixFamily {
    family: "qwen3-embedding" | "gte-qwen-instruct" | "e5-instruct" | "nomic-embed-text";
    basenamePattern: RegExp;
    prefixes: EmbeddingTextPrefixes;
}

/** Built-in recipes from each model family's published model card. */
export const EMBEDDING_MODEL_PREFIX_FAMILIES: readonly EmbeddingModelPrefixFamily[] = [
    {
        family: "qwen3-embedding",
        basenamePattern: /^qwen3-embedding(?:-|$)/,
        prefixes: { queryPrefix: QWEN3_QUERY_INSTRUCTION, documentPrefix: "" },
    },
    {
        // https://huggingface.co/Alibaba-NLP/gte-Qwen2-7B-instruct
        family: "gte-qwen-instruct",
        basenamePattern: /^gte-qwen.*-instruct(?:-|$)/,
        prefixes: { queryPrefix: INSTRUCT_WEB_SEARCH_QUERY_PREFIX, documentPrefix: "" },
    },
    {
        // https://huggingface.co/intfloat/multilingual-e5-large-instruct
        family: "e5-instruct",
        basenamePattern: /^(?:multilingual-)?e5-.*-instruct(?:-|$)/,
        prefixes: { queryPrefix: INSTRUCT_WEB_SEARCH_QUERY_PREFIX, documentPrefix: "" },
    },
    {
        // https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
        family: "nomic-embed-text",
        basenamePattern: /^nomic-embed-text(?:-|$)/,
        prefixes: { queryPrefix: "search_query: ", documentPrefix: "search_document: " },
    },
];

function modelBasename(model: string): string {
    const normalized = normalizeEmbeddingModelId(model);
    return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function resolveEmbeddingTextPrefixes(
    model: string,
    queryInstruction?: string | false,
    documentPrefix?: string,
): EmbeddingTextPrefixes {
    const family = EMBEDDING_MODEL_PREFIX_FAMILIES.find(({ basenamePattern }) =>
        basenamePattern.test(modelBasename(model)),
    );
    return {
        queryPrefix:
            queryInstruction === false
                ? ""
                : queryInstruction !== undefined
                  ? queryInstruction
                  : (family?.prefixes.queryPrefix ?? ""),
        documentPrefix: documentPrefix ?? family?.prefixes.documentPrefix ?? "",
    };
}
