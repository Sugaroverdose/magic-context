import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
    __resetToolDefinitionMeasurements,
    getCurrentToolSetHash,
    getMeasuredToolDefinitionTokens,
} from "../../features/magic-context/tool-definition-tokens";
import { estimateTokens } from "../../hooks/magic-context/read-session-formatting";
import { __resetHostLimitations, activeHostLimitations } from "../../shared/host-limitations";
import type { StatusDetail } from "../../shared/rpc-types";
import { statusSummaryFromDetail } from "../../shared/status-summary";
import { recordV2ToolDefinitions, resolveV2TransformMode } from "./context";
import type { SessionContext } from "./types";

function draft(overrides: Partial<SessionContext> = {}): SessionContext {
    return {
        sessionID: "ses-v2-limitations",
        model: { providerID: "openai", id: "gpt-mock" },
        agent: "build",
        messages: [],
        system: [],
        tools: {
            read: { description: "Read a file", input: { type: "object", properties: {} } },
            ctx_note: { description: "Save a note", input: { type: "object", properties: {} } },
        },
        options: {},
        ...overrides,
    };
}

describe("v2 transform-mode resolution", () => {
    beforeEach(() => {
        __resetHostLimitations();
    });
    afterEach(() => {
        __resetHostLimitations();
    });

    it("leaves the default TypeScript mode alone and declares nothing", () => {
        const config = { enabled: true, transform_mode: "ts" as const };
        expect(resolveV2TransformMode(config)).toBe(config);
        expect(activeHostLimitations()).toEqual([]);
    });

    it("runs TypeScript mode and names the limitation when Rust mode is configured", () => {
        const warnings: string[] = [];
        const original = console.warn;
        console.warn = (...args: unknown[]) => {
            warnings.push(args.map(String).join(" "));
        };
        try {
            const configured = { enabled: true, transform_mode: "rust" as const };
            expect(resolveV2TransformMode(configured).transform_mode).toBe("ts");
            // The caller's object is left untouched; only the resolved copy is downgraded.
            expect(configured.transform_mode).toBe("rust");
            expect(activeHostLimitations()).toEqual(["rust_mode_unsupported"]);
            // A second setup in the same process must not add a second warning line.
            expect(resolveV2TransformMode({ transform_mode: "rust" as const }).transform_mode).toBe(
                "ts",
            );
            expect(warnings).toHaveLength(1);
            expect(warnings[0]).toContain("MC-S06");
        } finally {
            console.warn = original;
        }
    });

    it("shows a declared limitation as a status warning", () => {
        resolveV2TransformMode({ transform_mode: "rust" as const });
        const detail = {
            inputTokens: 0,
            contextLimit: 0,
            usagePercentage: 0,
            cacheTtl: "5m",
            compartmentCount: 0,
            memoryCount: 0,
            executeThreshold: 65,
            hostLimitations: activeHostLimitations(),
        } as unknown as StatusDetail;
        expect(statusSummaryFromDetail(detail).warnings).toEqual(["rust_mode_unsupported"]);
    });
});

describe("v2 tool-definition measurement", () => {
    beforeEach(() => {
        __resetToolDefinitionMeasurements();
    });
    afterEach(() => {
        __resetToolDefinitionMeasurements();
    });

    it("measures the draft's tool set under the same key the status surfaces read", () => {
        const request = draft();
        recordV2ToolDefinitions(request);
        const expected =
            estimateTokens("Read a file") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} })) +
            estimateTokens("Save a note") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(expected);
        expect(getCurrentToolSetHash("openai", "gpt-mock", "build")).not.toBe("");
    });

    it("measures the edited descriptions, not the host's originals", () => {
        const request = draft();
        request.tools.ctx_note!.description = "short";
        recordV2ToolDefinitions(request);
        const shortened =
            estimateTokens("Read a file") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} })) +
            estimateTokens("short") +
            estimateTokens(JSON.stringify({ type: "object", properties: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(shortened);
    });

    it("keys each agent and model separately and re-measuring one pass changes nothing", () => {
        recordV2ToolDefinitions(draft());
        const first = getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build");
        recordV2ToolDefinitions(draft());
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBe(first);
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "plan")).toBeUndefined();
        recordV2ToolDefinitions(draft({ agent: "plan" }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "plan")).toBe(first);
    });

    it("reports no measurement for a draft the host sent no tools with", () => {
        recordV2ToolDefinitions(draft({ tools: {} }));
        expect(getMeasuredToolDefinitionTokens("openai", "gpt-mock", "build")).toBeUndefined();
        expect(getCurrentToolSetHash("openai", "gpt-mock", "build")).toBe("");
    });
});
