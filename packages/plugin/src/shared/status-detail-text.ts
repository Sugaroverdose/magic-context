import { formatDreamTaskFailures } from "../features/magic-context/dreamer/task-registry";
import { formatCacheTtlDisplay } from "./cache-ttl-display";
import { formatConfigParseStatusLine } from "./config-diagnostics";
import {
    formatOpenCodeDbMissingStatusLine,
    formatOpenCodeDbReadFailureStatusLine,
    getOpenCodeDbReadFailure,
    openCodeDbPathExists,
    resolveOpenCodeDbPath,
} from "./opencode-db-path";
import type { MemoryImportanceHistogram, StatusDetail } from "./rpc-types";
import { RUST_MODE_HOST_PATHS_LINE } from "./rust-mode-status";
import { renderUserStatusSummary, statusSummaryFromDetail } from "./status-summary";
import { renderUserFacingFailure } from "./user-facing-codes";

function formatCount(value: number): string {
    return Math.round(value).toLocaleString();
}

export function formatMemoryImportanceHistogram(histogram: MemoryImportanceHistogram): string {
    const bands = histogram.bands;
    return [
        `0–19 ${formatCount(bands["0-19"])}`,
        `20–39 ${formatCount(bands["20-39"])}`,
        `40–59 ${formatCount(bands["40-59"])}`,
        `60–79 ${formatCount(bands["60-79"])}`,
        `80–100 ${formatCount(bands["80-100"])}`,
        `${formatCount(histogram.unclassified)} unclassified of ${formatCount(histogram.total)}`,
    ].join(" · ");
}

function formatCacheLane(detail: StatusDetail): string {
    if (detail.cacheNeverExpires) return `never expires; TTL ${detail.cacheTtl}`;
    if (detail.lastResponseTime <= 0) return `waiting for first response; TTL ${detail.cacheTtl}`;
    if (detail.cacheExpired) return `expired; TTL ${detail.cacheTtl}`;
    return `live (${Math.round(detail.cacheRemainingMs / 1000)}s remaining); TTL ${detail.cacheTtl}`;
}

/** Render the default user summary for chat-only OpenCode clients. */
export function formatStatusDetailMarkdown(detail: StatusDetail): string {
    return renderUserStatusSummary(statusSummaryFromDetail(detail), "markdown");
}

/** Render the opt-in operator detail that the status dialog exposes behind Diagnostics. */
export function formatStatusDiagnosticsMarkdown(detail: StatusDetail): string {
    const usableLimit =
        detail.contextLimit > 0
            ? `${formatCount(detail.contextLimit)} usable tokens`
            : "? usable tokens";
    const historianState = detail.historianRunning ? "running" : "idle";
    const historianDetails = [
        detail.boundaryPresent === undefined
            ? undefined
            : `boundary ${detail.boundaryPresent ? "present" : "absent"}`,
        detail.coverageOrdinal === undefined
            ? undefined
            : `coverage ${detail.coverageOrdinal === null ? "none" : detail.coverageOrdinal}`,
    ].filter((value): value is string => value !== undefined);
    const openCodeDbResolution = resolveOpenCodeDbPath();
    const openCodeDbReadFailure = getOpenCodeDbReadFailure();
    const openCodeDbStatusLine = !openCodeDbPathExists(openCodeDbResolution)
        ? formatOpenCodeDbMissingStatusLine(openCodeDbResolution)
        : openCodeDbReadFailure?.path === openCodeDbResolution.path
          ? formatOpenCodeDbReadFailureStatusLine(openCodeDbReadFailure)
          : null;
    const mode =
        detail.compaction_enabled === false
            ? "native compaction (Magic Context history compaction disabled)"
            : "Magic Context compaction";

    const lines = [
        ...(openCodeDbStatusLine ? [openCodeDbStatusLine, ""] : []),
        ...(detail.configParseFailures ?? []).map(formatConfigParseStatusLine),
        ...((detail.configParseFailures?.length ?? 0) > 0 ? [""] : []),
        "## Magic Context Status",
        "",
        `- **Mode:** ${mode}`,
        `- **Active profile:** ${detail.activeProfile ?? "none"}`,
        `- **Usage:** ${detail.usagePercentage.toFixed(1)}% (${formatCount(detail.inputTokens)} / ${usableLimit})`,
        `- **${formatCacheTtlDisplay({ value: detail.cacheTtl, source: detail.cacheTtlSource ?? "session", modelKey: detail.cacheTtlModelKey })}**; ${formatCacheLane(detail)}`,
        `- **Historian:** ${[historianState, ...historianDetails].join("; ")}`,
        ...(detail.hostBackendsModuleSide ? [`- ${RUST_MODE_HOST_PATHS_LINE}`] : []),
        ...(detail.memoryMirror
            ? [
                  `- **Memory mirror:** cursor ${formatCount(detail.memoryMirror.cursor)} / ${detail.memoryMirror.feedHead === null ? "unknown" : formatCount(detail.memoryMirror.feedHead)}; ${formatCount(detail.memoryMirror.liveRows)} live rows; ${detail.memoryMirror.stalled ? `stalled (${detail.memoryMirror.code})` : "advancing or caught up"}`,
              ]
            : []),
        `- **Memory:** ${formatCount(detail.memoryCount)} active; ${formatCount(detail.memoryBlockCount)} injected`,
        `- **Memory importance:** ${formatMemoryImportanceHistogram(detail.memoryImportanceHistogram)}`,
        `- **Tags:** ${formatCount(detail.activeTags)} active, ${formatCount(detail.droppedTags)} dropped; ${formatCount(detail.pendingOpsCount)} pending drops`,
        `- **Execute threshold:** ${detail.executeThreshold.toFixed(1)}%${detail.executeThresholdClamped ? " (clamped)" : ""}`,
    ];

    if (detail.recompProgress?.phase === "recomp") {
        lines.push(
            `- **${detail.recompProgress.kind === "embed" ? "Embed" : "Historian"} progress:** ${formatCount(detail.recompProgress.processedMessages)} / ${formatCount(detail.recompProgress.totalMessages)}`,
        );
    }
    if (detail.lastTransformError) {
        lines.push(`- **Warning:** ${renderUserFacingFailure("transform_update_failed")}`);
    }
    if (detail.memoryMirror?.stalled) {
        lines.push(`- **Warning:** ${renderUserFacingFailure("memory_mirror_stalled")}`);
    }
    if (detail.memoryAuthorityMismatch) {
        lines.push(`- **Warning:** ${renderUserFacingFailure("memory_authority_mismatch")}`);
    }
    // The scheduler's own failure text. Its absence is why a task could fail on every
    // slot for a week with no signal but a backlog that never fell.
    if ((detail.dreamerFailures?.length ?? 0) > 0) {
        lines.push(
            "- **Dreamer:** scheduled tasks failing",
            ...formatDreamTaskFailures(detail.dreamerFailures ?? [])
                .split("\n")
                .map((line) => `  ${line}`),
        );
    }

    return lines.join("\n");
}
