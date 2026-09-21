/**
 * The content of the `/ctx-status` view: one section/row model that every host
 * renders with its own drawing primitives.
 *
 * OpenCode 1 and OpenCode 2 paint it with the Solid/OpenTUI dialog component,
 * Pi paints it with its own line-based overlay renderer. Neither host decides
 * WHICH rows exist, what they are called, in which order they appear, or what
 * colour they carry — that is decided here, once, so a row cannot appear on one
 * host and be missing on another.
 *
 * Colours are semantic tones ("accent", "warning", …) rather than hex values,
 * because each host resolves them against its own theme. The one exception is
 * the token-breakdown palette: those colours identify a context category across
 * the status view AND the sidebar, so they are fixed hex values shared by both.
 */
import { formatCacheTtlDisplay } from "./cache-ttl-display";
import { type ConfigParseFailure, formatConfigParseStatusLine } from "./config-diagnostics";
import { formatThresholdPercent } from "./format-threshold";
import type { TailHygieneStatus } from "./rpc-types";
import { formatTailHygiene } from "./tail-hygiene-status";
import {
    renderUserFacingFailure,
    type UserFacingFailureKey,
    userFacingFailureCode,
} from "./user-facing-codes";
import { formatWindowDerivationLine, type WindowGeometryResult } from "./window-geometry";

/** Theme-independent colour role; each host maps these onto its own palette. */
export type StatusTone = "accent" | "text" | "muted" | "warning" | "error";

export interface StatusRow {
    readonly label: string;
    readonly value: string;
    readonly tone: StatusTone;
}

export interface StatusSection {
    readonly title: string;
    /**
     * Characters reserved for the label column of this section. Labels are
     * padded to it and values start after it, so a label can never be squeezed
     * into a mid-word wrap by a long value next to it.
     */
    readonly labelWidth: number;
    readonly rows: readonly StatusRow[];
}

/** One coloured slice of the breakdown bar, sized by its token count. */
export interface StatusBarSegment {
    readonly label: string;
    readonly tokens: number;
    readonly color: string;
}

export interface StatusBreakdownRow {
    readonly label: string;
    readonly value: string;
    readonly color: string;
}

export interface StatusWarning {
    readonly text: string;
    readonly tone: "warning" | "error";
}

export interface StatusHeadlineCell {
    readonly text: string;
    readonly tone: StatusTone;
}

export interface StatusView {
    readonly title: string;
    readonly version: string;
    /** Left cell is pressure against the threshold, right cell is the absolute count. */
    readonly headline: { readonly left: StatusHeadlineCell; readonly right: StatusHeadlineCell };
    readonly windowLine: string | null;
    readonly bar: readonly StatusBarSegment[];
    readonly breakdown: readonly StatusBreakdownRow[];
    readonly hygiene: StatusRow | null;
    readonly sections: readonly StatusSection[];
    readonly warnings: readonly StatusWarning[];
    readonly footer: string;
}

/**
 * The status fields the view reads. Field names follow the OpenCode RPC
 * `StatusDetail`, so that host passes its snapshot straight in; Pi builds the
 * same shape from its own detail (see `statusViewSourceFromPiDetail`).
 */
export interface StatusViewSource {
    readonly usagePercentage: number;
    readonly inputTokens: number;
    readonly contextLimit: number;
    readonly executeThreshold: number;
    readonly executeThresholdClamped?: boolean;
    readonly windowGeometry?: WindowGeometryResult;
    readonly tailHygiene?: TailHygieneStatus;
    readonly systemPromptTokens: number;
    readonly docsTokens: number;
    readonly compartmentTokens: number;
    readonly compartmentCount: number;
    readonly factTokens: number;
    readonly memoryTokens: number;
    readonly memoryBlockCount: number;
    readonly profileTokens: number;
    readonly conversationTokens: number;
    readonly toolCallTokens: number;
    readonly toolDefinitionTokens: number;
    readonly activeTags: number;
    readonly droppedTags: number;
    readonly totalTags: number;
    readonly activeBytes: number;
    /** False when only a module-side total is authoritative; active/dropped are then unknown. */
    readonly tagCountsAuthoritative?: boolean;
    readonly lastNudgeTokens: number;
    readonly pendingOpsCount: number;
    readonly protectedTagCount: number;
    readonly isSubagent: boolean;
    readonly cacheTtl: string;
    readonly cacheTtlSource?: "config" | "session" | "default";
    readonly cacheTtlModelKey?: string;
    readonly lastResponseTime: number;
    readonly cacheRemainingMs: number;
    readonly cacheExpired: boolean;
    readonly cacheNeverExpires?: boolean;
    readonly historyBlockTokens: number;
    readonly compressionBudget: number | null;
    readonly compressionUsage: string | null;
    readonly lastDreamerRunAt?: number | null;
    /**
     * Dreamer tasks the running host cannot execute, by name. Shown so the
     * unavailable maintenance is visible as a named list rather than as a
     * backlog that silently never falls.
     */
    readonly dreamerUnsupportedTasks?: readonly string[];
    readonly memoryCount: number;
    readonly sessionNoteCount?: number;
    readonly readySmartNoteCount?: number;
    readonly archivedCompartmentCount?: number;
    readonly configParseFailures?: readonly ConfigParseFailure[];
    /** OpenCode spells this `compaction_enabled`; both spellings are accepted. */
    readonly compaction_enabled?: boolean;
    readonly compactionEnabled?: boolean;
    /** Failure codes to print under the sections, already selected by the host. */
    readonly warnings?: readonly UserFacingFailureKey[];
}

export interface StatusViewOptions {
    /** Plugin version shown next to the title. */
    readonly version: string;
    /** Clock used for the cache "last response"/"remaining" values. */
    readonly now?: number;
}

/**
 * Category palette, kept identical to the sidebar breakdown
 * (`src/tui/slots/sidebar-content.tsx`) so one colour means one category
 * wherever it is drawn.
 */
export const STATUS_CATEGORY_COLORS = {
    system: "#c084fc",
    docs: "#22d3ee",
    compartments: "#60a5fa",
    facts: "#fbbf24",
    memories: "#34d399",
    profile: "#a3e635",
    conversation: "#f87171",
    toolCalls: "#fb923c",
    toolDefs: "#f472b6",
} as const;

/**
 * Terminal columns below which the two-column section grid is not drawn.
 *
 * Two columns need, per column, the widest label column (19) plus a space plus
 * room for a value (about 14), and the dialog adds four columns of padding and
 * four of gap between the columns: 2 × 34 + 8 = 76. Narrower than that, the
 * sections are drawn in one column instead of squeezing labels into wraps.
 */
export const STATUS_TWO_COLUMN_MIN_COLUMNS = 76;

/** Compact token count, e.g. 623K. Shared so every host prints one spelling. */
export function formatStatusTokens(value: number): string {
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
    return String(value);
}

function formatStatusBytes(value: number): string {
    if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
    if (value >= 1_024) return `${Math.round(value / 1_024)} KB`;
    return `${value} B`;
}

function formatRelativeTime(timestamp: number, now: number): string {
    const elapsed = now - timestamp;
    if (elapsed < 60_000) return "just now";
    if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
    if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
    return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

/** Remaining cache lifetime as one value, never a sentence: `4m 12s`, `38s`. */
function formatRemaining(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    if (minutes < 60) return `${minutes}m ${seconds}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pressureTone(usagePercentage: number): StatusTone {
    if (usagePercentage >= 80) return "error";
    if (usagePercentage >= 65) return "warning";
    return "accent";
}

function compactionEnabled(source: StatusViewSource): boolean {
    if (source.compaction_enabled === false) return false;
    if (source.compactionEnabled === false) return false;
    return true;
}

/**
 * Pressure headline when Magic Context compaction is off: the percentage is of
 * the model window, because native compaction — not the Magic Context execute
 * threshold — is what acts on it.
 */
function nativeCompactionLabel(source: StatusViewSource): string {
    if (source.contextLimit <= 0) return "Context: unknown · native compaction";
    const percentage = (source.inputTokens / source.contextLimit) * 100;
    return `Context: ${percentage.toFixed(1)}% · native compaction`;
}

function barSegments(source: StatusViewSource): StatusBarSegment[] {
    const segments: Array<StatusBarSegment & { readonly detail?: string }> = [];
    const push = (label: string, tokens: number, color: string, detail?: string) => {
        if (tokens > 0) segments.push({ label, tokens, color, detail });
    };
    push("System", source.systemPromptTokens, STATUS_CATEGORY_COLORS.system);
    push("Docs", source.docsTokens, STATUS_CATEGORY_COLORS.docs);
    if (compactionEnabled(source)) {
        push(
            `Compartments (${source.compartmentCount})`,
            source.compartmentTokens,
            STATUS_CATEGORY_COLORS.compartments,
        );
    }
    push("Facts", source.factTokens, STATUS_CATEGORY_COLORS.facts);
    push(
        `Memories (${source.memoryBlockCount})`,
        source.memoryTokens,
        STATUS_CATEGORY_COLORS.memories,
    );
    push("User Profile", source.profileTokens, STATUS_CATEGORY_COLORS.profile);
    push("Conversation", source.conversationTokens, STATUS_CATEGORY_COLORS.conversation);
    push("Tool Calls", source.toolCallTokens, STATUS_CATEGORY_COLORS.toolCalls);
    push("Tool Defs", source.toolDefinitionTokens, STATUS_CATEGORY_COLORS.toolDefs);
    return segments;
}

function tagRows(source: StatusViewSource): StatusRow[] {
    // A module-side total is the only authoritative count in Rust mode; the
    // host's active/dropped mirror is not presented as truth there.
    const authoritative = source.tagCountsAuthoritative !== false;
    return [
        {
            label: "Active",
            value: authoritative
                ? `${source.activeTags} (~${formatStatusBytes(source.activeBytes)})`
                : "n/a (module total only)",
            tone: "text",
        },
        {
            label: "Dropped",
            value: authoritative ? String(source.droppedTags) : "n/a (module total only)",
            tone: "text",
        },
        { label: "Total", value: String(source.totalTags), tone: "muted" },
    ];
}

function cacheRows(source: StatusViewSource, now: number): StatusRow[] {
    const configured = formatCacheTtlDisplay({
        value: source.cacheTtl,
        source: source.cacheTtlSource ?? "session",
        modelKey: source.cacheTtlModelKey,
    }).replace(/^Cache TTL: /, "");
    const neverExpires =
        source.cacheNeverExpires === true ||
        source.cacheRemainingMs === Number.POSITIVE_INFINITY ||
        source.cacheRemainingMs < 0;
    const threshold = `${formatThresholdPercent(source.executeThreshold)}%`;
    const rows: StatusRow[] = [
        { label: "Configured", value: configured, tone: "text" },
        {
            label: "Last response",
            value:
                source.lastResponseTime > 0
                    ? `${Math.round((now - source.lastResponseTime) / 1000)}s ago`
                    : "never",
            tone: "text",
        },
    ];
    // With no expiry there is no countdown to print, so the row is absent
    // rather than carrying a sentence explaining its own absence.
    if (!neverExpires) {
        rows.push({
            label: "Remaining",
            value: source.cacheExpired ? "expired" : formatRemaining(source.cacheRemainingMs),
            tone: source.cacheExpired ? "warning" : "muted",
        });
    }
    rows.push({
        label: "Auto-execute",
        value: source.cacheExpired
            ? "yes (expired)"
            : neverExpires
              ? `at ≥${threshold}`
              : `at TTL or ≥${threshold}`,
        tone: "muted",
    });
    return rows;
}

function historyRows(source: StatusViewSource, now: number): StatusRow[] {
    const rows: StatusRow[] = [
        {
            label: "History block",
            value: `~${formatStatusTokens(source.historyBlockTokens)} tok`,
            tone: "text",
        },
    ];
    if (source.compressionBudget != null) {
        rows.push({
            label: "Budget",
            value: `~${formatStatusTokens(source.compressionBudget)} tok (${source.compressionUsage} used)`,
            tone: "text",
        });
    }
    if (source.lastDreamerRunAt) {
        rows.push({
            label: "Dreamer",
            value: `last ${formatRelativeTime(source.lastDreamerRunAt, now)}`,
            tone: "muted",
        });
    }
    rows.push(...dreamerUnsupportedRows(source));
    return rows;
}

/** One row naming every Dreamer task this host cannot run, or nothing when it runs them all. */
function dreamerUnsupportedRows(source: StatusViewSource): StatusRow[] {
    const unsupported = source.dreamerUnsupportedTasks ?? [];
    if (unsupported.length === 0) return [];
    return [
        {
            label: "Dreamer unavailable",
            value: `${unsupported.join(", ")} (${userFacingFailureCode("dream_task_needs_tool_loop")})`,
            tone: "warning",
        },
    ];
}

/**
 * Sections when Magic Context compaction is off: its tags, thresholds and
 * history budgets describe machinery that is not running, so the view shows
 * only what still holds — the knowledge the plugin keeps injecting.
 */
function knowledgeSections(source: StatusViewSource, now: number): StatusSection[] {
    const rows: StatusRow[] = [
        { label: "Memories", value: String(source.memoryCount), tone: "accent" },
        { label: "Notes", value: String(source.sessionNoteCount ?? 0), tone: "muted" },
    ];
    if ((source.archivedCompartmentCount ?? 0) > 0) {
        rows.push({
            label: "Archived compartments",
            value: String(source.archivedCompartmentCount),
            tone: "muted",
        });
    }
    if ((source.readySmartNoteCount ?? 0) > 0) {
        rows.push({
            label: "Smart Notes",
            value: `${source.readySmartNoteCount} ready`,
            tone: "accent",
        });
    }
    if (source.lastDreamerRunAt) {
        rows.push({
            label: "Dreamer",
            value: `last ${formatRelativeTime(source.lastDreamerRunAt, now)}`,
            tone: "muted",
        });
    }
    rows.push(...dreamerUnsupportedRows(source));
    return [{ title: "Knowledge", labelWidth: 23, rows }];
}

/**
 * Section order is also the reading order: hosts with room draw them in two
 * columns (even indices left, odd indices right, which is how they have always
 * been arranged), and a narrow host draws the same list in one column.
 */
function statusSections(source: StatusViewSource, now: number): StatusSection[] {
    if (!compactionEnabled(source)) return knowledgeSections(source, now);
    return [
        { title: "Tags", labelWidth: 8, rows: tagRows(source) },
        {
            title: "Reductions",
            labelWidth: 19,
            rows: [
                {
                    label: "Execute threshold",
                    value: `${formatThresholdPercent(source.executeThreshold)}%${
                        source.executeThresholdClamped ? "*" : ""
                    }`,
                    tone: "text",
                },
                {
                    label: "Last reduce anchor",
                    value: `${formatStatusTokens(source.lastNudgeTokens)} tok`,
                    tone: "text",
                },
            ],
        },
        {
            title: "Pending Queue",
            labelWidth: 8,
            rows: [
                {
                    label: "Drops",
                    value: String(source.pendingOpsCount),
                    tone: source.pendingOpsCount > 0 ? "warning" : "muted",
                },
            ],
        },
        {
            title: "Context Details",
            labelWidth: 15,
            rows: [
                {
                    label: "Protected tags",
                    value: String(source.protectedTagCount),
                    tone: "muted",
                },
                { label: "Subagent", value: source.isSubagent ? "yes" : "no", tone: "muted" },
            ],
        },
        { title: "Cache TTL", labelWidth: 14, rows: cacheRows(source, now) },
        { title: "History Compression", labelWidth: 14, rows: historyRows(source, now) },
        {
            title: "Memory",
            labelWidth: 9,
            rows: [
                { label: "Active", value: String(source.memoryCount), tone: "accent" },
                { label: "Injected", value: String(source.memoryBlockCount), tone: "muted" },
            ],
        },
    ];
}

function warningBlock(source: StatusViewSource): StatusWarning[] {
    return [
        ...(source.configParseFailures ?? []).map((failure) => ({
            text: formatConfigParseStatusLine(failure),
            tone: "error" as const,
        })),
        ...(source.warnings ?? []).map((code) => ({
            text: renderUserFacingFailure(code),
            tone: "warning" as const,
        })),
    ];
}

/** Builds the full status view from one snapshot. */
export function buildStatusView(source: StatusViewSource, options: StatusViewOptions): StatusView {
    const now = options.now ?? Date.now();
    const off = !compactionEnabled(source);
    const tone = off ? "accent" : pressureTone(source.usagePercentage);
    const segments = barSegments(source);
    const total = source.inputTokens || 1;
    return {
        title: "⚡ Magic Context Status",
        version: `v${options.version}`,
        headline: {
            left: {
                text: off
                    ? nativeCompactionLabel(source)
                    : `${source.usagePercentage.toFixed(1)}% / ${formatThresholdPercent(
                          source.executeThreshold,
                      )}%${source.executeThresholdClamped ? "*" : ""}`,
                tone,
            },
            right: {
                text: `${formatStatusTokens(source.inputTokens)} / ${
                    source.contextLimit > 0 ? formatStatusTokens(source.contextLimit) : "?"
                } tokens`,
                tone,
            },
        },
        windowLine: source.windowGeometry
            ? formatWindowDerivationLine(source.inputTokens, source.windowGeometry)
            : null,
        bar: segments,
        breakdown: segments.map((segment) => ({
            label: segment.label,
            value: `${formatStatusTokens(segment.tokens)} (${((segment.tokens / total) * 100).toFixed(1)}%)`,
            color: segment.color,
        })),
        hygiene: source.tailHygiene
            ? {
                  label: "Hygiene",
                  value: formatTailHygiene(source.tailHygiene),
                  tone: source.tailHygiene.evaluable ? "accent" : "warning",
              }
            : null,
        sections: statusSections(source, now),
        warnings: warningBlock(source),
        footer: "Esc to close",
    };
}

/** Pads one row to its section's label column; values print flush right. */
export function formatStatusRowText(row: StatusRow, labelWidth: number, width: number): string {
    const label = row.label.padEnd(labelWidth);
    const room = Math.max(1, width - label.length);
    return `${label}${row.value.padStart(room)}`.trimEnd();
}
