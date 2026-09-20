import { describe, expect, test } from "bun:test";
import type { StatusDetail } from "./rpc-types";
import { buildStatusView, type StatusViewSource } from "./status-view";

const NOW = 1_730_000_000_000;

/**
 * A snapshot with every optional block present, so a row that disappears from
 * the view shows up as a failure here rather than as an empty section.
 */
const SOURCE: StatusViewSource = {
    usagePercentage: 71.4,
    inputTokens: 623_000,
    contextLimit: 872_000,
    executeThreshold: 75,
    executeThresholdClamped: false,
    windowGeometry: {
        usableSoft: 872_000,
        usableHard: 900_000,
        geometry: "shared_upfront",
        derivation: {
            window: 904_000,
            reserve: 32_000,
            reserveSource: "output_catalog",
            geometry: "shared_upfront",
            windowSource: "catalog",
            absoluteWall: 904_000,
        },
    },
    tailHygiene: {
        u: 14_400,
        t: 48_000,
        severity: 0.3,
        evaluable: true,
        reclaimableToolOutputCount: 3,
    },
    systemPromptTokens: 12_000,
    docsTokens: 4_000,
    compartmentTokens: 80_000,
    compartmentCount: 12,
    factTokens: 0,
    memoryTokens: 6_000,
    memoryBlockCount: 3,
    profileTokens: 1_000,
    conversationTokens: 400_000,
    toolCallTokens: 100_000,
    toolDefinitionTokens: 20_000,
    activeTags: 4,
    droppedTags: 1,
    totalTags: 5,
    activeBytes: 48_000,
    lastNudgeTokens: 512_000,
    pendingOpsCount: 2,
    protectedTagCount: 3,
    isSubagent: false,
    cacheTtl: "1h",
    cacheTtlSource: "config",
    cacheTtlModelKey: "anthropic/claude-opus-5",
    lastResponseTime: NOW - 42_000,
    cacheRemainingMs: 252_000,
    cacheExpired: false,
    historyBlockTokens: 80_000,
    compressionBudget: 120_000,
    compressionUsage: "66%",
    lastDreamerRunAt: NOW - 3 * 3_600_000,
    memoryCount: 8,
    sessionNoteCount: 2,
    readySmartNoteCount: 1,
    configParseFailures: [],
    warnings: [],
};

function view(overrides: Partial<StatusViewSource> = {}) {
    return buildStatusView({ ...SOURCE, ...overrides }, { version: "1.2.3", now: NOW });
}

function rowLabels(sectionTitle: string, overrides: Partial<StatusViewSource> = {}): string[] {
    const section = view(overrides).sections.find((entry) => entry.title === sectionTitle);
    if (!section) throw new Error(`missing section: ${sectionTitle}`);
    return section.rows.map((row) => row.label);
}

describe("status view model", () => {
    test("names the sections in the order every host draws them", () => {
        expect(view().sections.map((section) => section.title)).toEqual([
            "Tags",
            "Reductions",
            "Pending Queue",
            "Context Details",
            "Cache TTL",
            "History Compression",
            "Memory",
        ]);
    });

    test("carries the section rows the status view is made of", () => {
        expect(rowLabels("Tags")).toEqual(["Active", "Dropped", "Total"]);
        expect(rowLabels("Reductions")).toEqual(["Execute threshold", "Last reduce anchor"]);
        expect(rowLabels("Pending Queue")).toEqual(["Drops"]);
        expect(rowLabels("Context Details")).toEqual(["Protected tags", "Subagent"]);
        expect(rowLabels("Cache TTL")).toEqual([
            "Configured",
            "Last response",
            "Remaining",
            "Auto-execute",
        ]);
        expect(rowLabels("History Compression")).toEqual(["History block", "Budget", "Dreamer"]);
        expect(rowLabels("Memory")).toEqual(["Active", "Injected"]);
    });

    test("drops the rows the single view no longer carries", () => {
        const rendered = JSON.stringify(view());
        // The Diagnostics split, the Logger block, the memory-importance
        // histogram and the breakdown footnote all left with it.
        for (const gone of [
            "Diagnostics",
            "Logger",
            "Swallowed writes",
            "Importance",
            "unclassified of",
            "Boundary",
            "Coverage ordinal",
            "includes reasoning",
        ]) {
            expect(rendered).not.toContain(gone);
        }
    });

    test("gives every row, breakdown row and warning an explicit colour", () => {
        const built = view({ warnings: ["transform_update_failed"] });
        for (const section of built.sections) {
            for (const row of section.rows) {
                expect(typeof row.tone).toBe("string");
                expect(row.tone.length).toBeGreaterThan(0);
            }
        }
        for (const row of built.breakdown) expect(row.color).toMatch(/^#[0-9a-f]{6}$/);
        for (const warning of built.warnings) {
            expect(["warning", "error"]).toContain(warning.tone);
        }
        expect(built.hygiene?.tone).toBe("accent");
        expect(built.headline.left.tone).toBe("warning");
    });

    test("reserves a label column wide enough for the section's longest label", () => {
        for (const section of view().sections) {
            const longest = Math.max(...section.rows.map((row) => row.label.length));
            expect(section.labelWidth).toBeGreaterThanOrEqual(longest);
        }
    });

    test("prints the remaining cache lifetime as one value, and omits it when there is none", () => {
        const remaining = view()
            .sections.find((section) => section.title === "Cache TTL")
            ?.rows.find((row) => row.label === "Remaining");
        expect(remaining?.value).toBe("4m 12s");

        // A cache that never expires has no countdown to print, so the row is
        // absent rather than carrying a sentence about its own absence.
        expect(rowLabels("Cache TTL", { cacheNeverExpires: true, cacheTtl: "never" })).toEqual([
            "Configured",
            "Last response",
            "Auto-execute",
        ]);
        expect(
            rowLabels("Cache TTL", { cacheRemainingMs: Number.POSITIVE_INFINITY }),
        ).not.toContain("Remaining");
    });

    test("marks an expired cache on the Remaining row", () => {
        const section = view({ cacheExpired: true, cacheRemainingMs: 0 }).sections.find(
            (entry) => entry.title === "Cache TTL",
        );
        const remaining = section?.rows.find((row) => row.label === "Remaining");
        expect({ value: remaining?.value, tone: remaining?.tone }).toEqual({
            value: "expired",
            tone: "warning",
        });
    });

    test("headlines pressure against the threshold and the absolute token count", () => {
        const built = view();
        expect(built.headline.left.text).toBe("71.4% / 75%");
        expect(built.headline.right.text).toBe("623K / 872K tokens");
        expect(built.windowLine).toContain("usable");
        expect(built.title).toBe("⚡ Magic Context Status");
        expect(built.version).toBe("v1.2.3");
        expect(built.footer).toBe("Esc to close");
    });

    test("breaks the context down by category, with counts and percentages", () => {
        expect(view().breakdown.map((row) => `${row.label} ${row.value}`)).toEqual([
            "System 12K (1.9%)",
            "Docs 4K (0.6%)",
            "Compartments (12) 80K (12.8%)",
            "Memories (3) 6K (1.0%)",
            "User Profile 1K (0.2%)",
            "Conversation 400K (64.2%)",
            "Tool Calls 100K (16.1%)",
            "Tool Defs 20K (3.2%)",
        ]);
    });

    test("prints config parse failures and failure codes as the warning block", () => {
        const built = view({
            configParseFailures: [
                { kind: "invalid-leaf", path: "/tmp/magic-context.jsonc", detail: "bad" },
            ] as StatusDetail["configParseFailures"],
            warnings: ["transform_update_failed"],
        });
        expect(built.warnings).toHaveLength(2);
        expect(built.warnings[0]?.tone).toBe("error");
        expect(built.warnings[1]?.text).toContain("MC-S02");
    });

    test("replaces the compaction machinery with knowledge counts when compaction is off", () => {
        const built = view({ compactionEnabled: false });
        expect(built.sections.map((section) => section.title)).toEqual(["Knowledge"]);
        expect(built.headline.left.text).toContain("native compaction");
        expect(built.sections[0]?.rows.map((row) => row.label)).toEqual([
            "Memories",
            "Notes",
            "Smart Notes",
            "Dreamer",
        ]);
    });
});
