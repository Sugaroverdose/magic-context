import type { Database } from "../../../shared/sqlite";
import { insertMemory } from "../memory/storage-memory";
import type { MemoryCategory } from "../memory/types";
import { insertUserMemoryCandidates } from "../user-memory/storage-user-memory";
import { FRUSTRATION_MARKER_REGEX } from "./friction-signals";

export type RetrospectiveLearningRoute = "memory" | "observation";

export interface ParsedRetrospectiveLearning {
    route: RetrospectiveLearningRoute;
    content: string;
    category?: MemoryCategory;
}

export interface RetrospectiveApplyResult {
    memoryWritten: number;
    observationsInserted: number;
    observationsDropped: number;
    rejected: Array<{ content: string; reason: string }>;
}

const LEARNINGS_BLOCK_REGEX = /<learnings\b[^>]*>(.*?)<\/learnings>/is;
const LEARNING_REGEX = /<learning\b([^>]*)>(.*?)<\/learning>/gis;
const ATTR_REGEX = /([a-zA-Z_:-]+)\s*=\s*"([^"]*)"/g;
const VALID_MEMORY_CATEGORIES = new Set<MemoryCategory>([
    "PROJECT_RULES",
    "ARCHITECTURE",
    "CONSTRAINTS",
    "CONFIG_VALUES",
    "NAMING",
]);
const RAW_QUOTE_REGEX = /["“”][^"“”]{4,}["“”]|'[^']{4,}'/;
const DATE_REGEX =
    /\b(?:20\d{2}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}\/20\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+20\d{2})\b/i;

export function parseRetrospectiveLearnings(text: string): ParsedRetrospectiveLearning[] {
    const block = text.match(LEARNINGS_BLOCK_REGEX)?.[1];
    if (!block) return [];

    const learnings: ParsedRetrospectiveLearning[] = [];
    for (const match of block.matchAll(LEARNING_REGEX)) {
        const attrs = parseAttributes(match[1] ?? "");
        const route = attrs.route;
        if (route !== "memory" && route !== "observation") continue;
        const content = unescapeXml((match[2] ?? "").trim())
            .replace(/\s+/g, " ")
            .trim();
        if (!content) continue;

        if (route === "memory") {
            const category = attrs.category;
            if (!VALID_MEMORY_CATEGORIES.has(category as MemoryCategory)) continue;
            learnings.push({ route, category: category as MemoryCategory, content });
        } else {
            learnings.push({ route, content });
        }
    }
    return learnings;
}

export function validateRetrospectiveLearningText(content: string): string | null {
    if (RAW_QUOTE_REGEX.test(content)) return "raw_quote";
    if (DATE_REGEX.test(content)) return "date";
    if (FRUSTRATION_MARKER_REGEX.test(content)) return "frustration_marker";
    return null;
}

export function applyRetrospectiveLearnings(args: {
    db: Database;
    projectIdentity: string;
    sourceSessionId: string;
    learnings: ParsedRetrospectiveLearning[];
    userMemoryCollectionEnabled: boolean;
}): RetrospectiveApplyResult {
    const result: RetrospectiveApplyResult = {
        memoryWritten: 0,
        observationsInserted: 0,
        observationsDropped: 0,
        rejected: [],
    };
    const observations: Array<{ content: string; sessionId: string }> = [];

    for (const learning of args.learnings) {
        const rejectReason = validateRetrospectiveLearningText(learning.content);
        if (rejectReason) {
            result.rejected.push({ content: learning.content, reason: rejectReason });
            continue;
        }

        if (learning.route === "memory") {
            if (!learning.category) continue;
            insertMemory(args.db, {
                projectPath: args.projectIdentity,
                category: learning.category,
                content: learning.content,
                sourceSessionId: args.sourceSessionId,
                sourceType: "dreamer",
                metadataJson: JSON.stringify({ source: "retrospective" }),
            });
            result.memoryWritten += 1;
            continue;
        }

        if (args.userMemoryCollectionEnabled) {
            observations.push({ content: learning.content, sessionId: args.sourceSessionId });
        } else {
            result.observationsDropped += 1;
        }
    }

    if (observations.length > 0) {
        insertUserMemoryCandidates(args.db, observations);
        result.observationsInserted = observations.length;
    }

    return result;
}

function parseAttributes(raw: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const match of raw.matchAll(ATTR_REGEX)) {
        attrs[match[1]] = unescapeXml(match[2] ?? "");
    }
    return attrs;
}

function unescapeXml(value: string): string {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
