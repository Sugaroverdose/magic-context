import { getMeasuredToolDefinitionTokens } from "../../features/magic-context/tool-definition-tokens";
import { providerMass, resolveDecisionCalibration } from "./decision-calibration";
import { estimateImageTokensFromDataUrl } from "./image-token-estimate";
import { estimateTokens } from "./read-session-formatting";
import type { MessageLike } from "./tag-messages";

export interface MessageTokenEstimate {
    conversation: number;
    toolCall: number;
}

function compactWireLabel(value: unknown, fallback: string): string {
    if (typeof value !== "string" || value.length === 0) return fallback;
    return value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 32) || fallback;
}

function wirePartKind(part: unknown, role: string): string {
    const rawType =
        part !== null &&
        typeof part === "object" &&
        typeof (part as { type?: unknown }).type === "string"
            ? (part as { type: string }).type
            : "unknown";
    if (rawType === "tool_result" || rawType === "tool-result") return "toolresult";
    if (rawType === "tool_use" || rawType === "tool-use" || rawType === "tool-invocation") {
        return "tool";
    }
    // OpenCode's native `tool` part carries the result on user-role messages
    // and the call on assistant-role messages.
    if (role === "user" && rawType === "tool") return "toolresult";
    return compactWireLabel(rawType, "unknown");
}

/** Describe the final three post-transform messages without serializing content. */
export function describeFinalWireTail(messages: readonly MessageLike[]): string {
    return `[${messages
        .slice(-3)
        .map((message) => {
            const role = compactWireLabel(message.info.role, "unknown");
            const kinds = message.parts.map((part) => wirePartKind(part, role)).join("+") || "none";
            return `${role}:${kinds}`;
        })
        .join(", ")}]`;
}

function serializedTokens(value: unknown): number {
    if (value === undefined) return 0;
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    return serialized ? estimateTokens(serialized) : 0;
}

/** Count the token-bearing fields in the message representation sent to OpenCode. */
export function estimateMessageTokens(message: MessageLike): MessageTokenEstimate {
    let conversation = 0;
    let toolCall = 0;
    for (const part of message.parts) {
        if (!part || typeof part !== "object") continue;
        const p = part as {
            type?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            data?: string;
            ignored?: boolean;
            state?: { input?: unknown; output?: unknown; error?: unknown };
            args?: unknown;
            input?: unknown;
            content?: unknown;
            mime?: string;
            url?: unknown;
            metadata?: { anthropic?: { signature?: string } };
        };
        if (p.ignored) continue;
        switch (p.type) {
            case "text":
                if (typeof p.text === "string") conversation += estimateTokens(p.text);
                break;
            case "reasoning": {
                if (typeof p.text === "string") conversation += estimateTokens(p.text);
                const signature = p.metadata?.anthropic?.signature;
                if (typeof signature === "string") conversation += estimateTokens(signature);
                break;
            }
            case "thinking":
                if (typeof p.thinking === "string") conversation += estimateTokens(p.thinking);
                if (typeof p.signature === "string") conversation += estimateTokens(p.signature);
                break;
            case "redacted_thinking":
                if (typeof p.data === "string") conversation += estimateTokens(p.data);
                break;
            case "file":
                if (typeof p.mime === "string" && p.mime.startsWith("image/")) {
                    conversation +=
                        typeof p.url === "string" && p.url.startsWith("data:")
                            ? estimateImageTokensFromDataUrl(p.url)
                            : 1200;
                }
                break;
            case "tool":
                toolCall += serializedTokens(p.state?.input);
                toolCall += serializedTokens(p.state?.output);
                toolCall += serializedTokens(p.state?.error);
                break;
            case "tool-invocation":
                toolCall += serializedTokens(p.args);
                break;
            case "tool_use":
                toolCall += serializedTokens(p.input);
                break;
            case "tool_result":
                toolCall += serializedTokens(p.content);
                break;
        }
    }
    return { conversation, toolCall };
}

export interface FinalWireTokenEstimateInput {
    messages: readonly MessageLike[];
    systemPromptTokens: number;
    providerID: string | undefined;
    modelID: string | undefined;
    agentName: string | undefined;
}

export interface FinalWireTokenEstimate {
    tokens: number;
    trusted: boolean;
    messageTokens: MessageTokenEstimate;
    systemTokens: number;
    toolDefinitionTokens: number | undefined;
    /** Unscaled transform-array/system/tool measurement; provider framing is unmeasured. */
    rawTokens?: number;
    rawComponents?: { system: number; tools: number; prose: number };
    completeness?: "complete" | "partial";
    componentsComplete?: boolean;
}

/**
 * Estimate the returned transform array plus observed system and tool definitions.
 * This is not exact provider tokenization: provider framing remains unmeasured.
 * Fit callers must require trusted, not merely compare a numeric partial estimate.
 */
export function estimateFinalWireInputTokens(
    input: FinalWireTokenEstimateInput,
): FinalWireTokenEstimate {
    const messageTokens = input.messages.reduce<MessageTokenEstimate>(
        (total, message) => {
            const next = estimateMessageTokens(message);
            total.conversation += next.conversation;
            total.toolCall += next.toolCall;
            return total;
        },
        { conversation: 0, toolCall: 0 },
    );
    const measuredToolDefinitions =
        input.providerID && input.modelID
            ? getMeasuredToolDefinitionTokens(input.providerID, input.modelID, input.agentName)
            : undefined;
    const calibration = resolveDecisionCalibration(input.providerID, input.modelID);
    const rawComponents = {
        system: input.systemPromptTokens,
        tools: (measuredToolDefinitions ?? 0) + messageTokens.toolCall,
        prose: messageTokens.conversation,
    };
    const tokens = providerMass(rawComponents, calibration, true);
    const complete =
        Number.isFinite(tokens) &&
        tokens > 0 &&
        Number.isFinite(input.systemPromptTokens) &&
        input.systemPromptTokens > 0 &&
        measuredToolDefinitions !== undefined &&
        input.messages.every(hasCountableParts);
    const systemTokens = Math.round(
        Math.max(0, input.systemPromptTokens) * calibration.systemRatio,
    );
    const toolDefinitionTokens =
        measuredToolDefinitions === undefined
            ? undefined
            : Math.round(measuredToolDefinitions * calibration.toolsRatio);
    return {
        tokens,
        trusted: complete,
        rawTokens: rawComponents.system + rawComponents.tools + rawComponents.prose,
        rawComponents,
        completeness: complete ? "complete" : "partial",
        componentsComplete:
            measuredToolDefinitions !== undefined && input.messages.every(hasCountableParts),
        messageTokens,
        systemTokens,
        toolDefinitionTokens,
    };
}

function hasCountableParts(message: MessageLike): boolean {
    return message.parts.every((part) => {
        if (!part || typeof part !== "object") return false;
        const p = part as unknown as Record<string, unknown>;
        if (p.ignored === true) return true;
        switch (p.type) {
            case "text":
            case "reasoning":
                return typeof p.text === "string";
            case "thinking":
                return typeof p.thinking === "string";
            case "redacted_thinking":
                return typeof p.data === "string";
            case "tool": {
                if (p.state === null || typeof p.state !== "object") return false;
                const state = p.state as Record<string, unknown>;
                return (
                    state.input !== undefined &&
                    (state.output !== undefined || state.error !== undefined)
                );
            }
            case "tool-invocation":
                return p.args !== undefined;
            case "tool_use":
                return p.input !== undefined;
            case "tool_result":
                return (
                    typeof p.content === "string" ||
                    (Array.isArray(p.content) &&
                        p.content.every(
                            (c: unknown) =>
                                typeof c === "string" ||
                                (c !== null &&
                                    typeof c === "object" &&
                                    (c as { type?: unknown }).type === "text"),
                        ))
                );
            case "step-start":
            case "step-finish":
                return true;
            default:
                return false;
        }
    });
}
