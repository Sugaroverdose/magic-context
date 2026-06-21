export type RetrospectiveMessageRole = "user" | "assistant" | "tool";

export interface RetrospectiveMessage {
    sessionId?: string;
    ordinal: number;
    role: RetrospectiveMessageRole | string;
    text?: string;
    toolName?: string;
    isError?: boolean;
    ts: number;
}

export type FrictionSignalKind =
    | "repeated_user_message"
    | "repeated_tool_call"
    | "tool_error_burst"
    | "frustration_marker";

export interface FrictionSignal {
    kind: FrictionSignalKind;
    ordinals: number[];
    message: string;
    score: number;
}

export const REPEATED_USER_MIN_CHARS = 24;
export const REPEATED_USER_SIMILARITY_THRESHOLD = 0.72;
export const REPEATED_USER_MAX_GAP_MS = 30 * 60 * 1000;

export const REPEATED_TOOL_CALL_MIN_COUNT = 3;
export const REPEATED_TOOL_CALL_WINDOW_MS = 10 * 60 * 1000;

export const TOOL_ERROR_BURST_MIN_RESULTS = 3;
export const TOOL_ERROR_BURST_MIN_ERRORS = 2;
export const TOOL_ERROR_BURST_RATE = 0.5;
export const TOOL_ERROR_BURST_WINDOW_MS = 15 * 60 * 1000;

export const FRUSTRATION_MIN_MARKER_SCORE = 2;
export const FRUSTRATION_CAPS_BURST_MIN_CHARS = 8;

const CORRECTION_MARKER_REGEX =
    /\b(?:again|already|asked|actually|broken|correction|didn'?t|doesn'?t|don'?t|error|fail(?:ed|ing)?|ignored|incorrect|no|not|stop|still|wrong)\b/gi;
const STRONG_CORRECTION_PHRASE_REGEX =
    /\b(?:not what i asked|i already (?:said|told you|explained)|you (?:ignored|missed)|that'?s wrong|this is wrong|stop (?:doing|claiming|using))\b/i;
const PUNCTUATION_RUN_REGEX = /[!?]{3,}/;
const CAPS_BURST_REGEX = new RegExp(`\\b[A-Z]{${FRUSTRATION_CAPS_BURST_MIN_CHARS},}\\b`);

/**
 * Shared with retrospective host-apply validation: durable learnings must not
 * preserve session-local anger/friction language verbatim.
 */
export const FRUSTRATION_MARKER_REGEX =
    /\b(?:not what i asked|i already (?:said|told you|explained)|you (?:ignored|missed)|that'?s wrong|this is wrong|stop (?:doing|claiming|using)|(?:no|wrong|again|stop)(?:\W+\b(?:no|wrong|again|stop)\b)+)\b|[!?]{3,}/i;

function sortedByOrdinal<T extends { ordinal: number; ts?: number }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.ordinal - b.ordinal || (a.ts ?? 0) - (b.ts ?? 0));
}

function textOf(message: RetrospectiveMessage): string {
    return message.text?.trim() ?? "";
}

function isRole(message: RetrospectiveMessage, role: RetrospectiveMessageRole): boolean {
    return message.role === role;
}

function isToolMessage(message: RetrospectiveMessage): boolean {
    return (
        message.role === "tool" || message.role === "tool_result" || message.role === "toolResult"
    );
}

function normalizeForSimilarity(text: string): string {
    return text
        .toLowerCase()
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`]+`/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function tokenSet(text: string): Set<string> {
    return new Set(
        normalizeForSimilarity(text)
            .split(" ")
            .filter((token) => token.length > 2),
    );
}

function diceSimilarity(a: string, b: string): number {
    const aTokens = tokenSet(a);
    const bTokens = tokenSet(b);
    if (aTokens.size === 0 || bTokens.size === 0) return 0;
    let intersection = 0;
    for (const token of aTokens) {
        if (bTokens.has(token)) intersection += 1;
    }
    return (2 * intersection) / (aTokens.size + bTokens.size);
}

function uniqueOrdinals(messages: RetrospectiveMessage[]): number[] {
    return [...new Set(messages.map((message) => message.ordinal))].sort((a, b) => a - b);
}

function withinGap(
    previous: RetrospectiveMessage,
    next: RetrospectiveMessage,
    maxGapMs: number,
): boolean {
    if (!Number.isFinite(previous.ts) || !Number.isFinite(next.ts)) return true;
    return Math.abs(next.ts - previous.ts) <= maxGapMs;
}

export function detectRepeatedUserMessages(messages: RetrospectiveMessage[]): FrictionSignal[] {
    const users = sortedByOrdinal(messages.filter((message) => isRole(message, "user")));
    const signals: FrictionSignal[] = [];

    for (let index = 1; index < users.length; index += 1) {
        const previous = users[index - 1];
        const current = users[index];
        if (!previous || !current) continue;

        const previousText = textOf(previous);
        const currentText = textOf(current);
        if (
            previousText.length < REPEATED_USER_MIN_CHARS ||
            currentText.length < REPEATED_USER_MIN_CHARS ||
            !withinGap(previous, current, REPEATED_USER_MAX_GAP_MS)
        ) {
            continue;
        }

        const similarity = diceSimilarity(previousText, currentText);
        if (similarity >= REPEATED_USER_SIMILARITY_THRESHOLD) {
            signals.push({
                kind: "repeated_user_message",
                ordinals: uniqueOrdinals([previous, current]),
                message: "near-identical consecutive user messages",
                score: similarity,
            });
        }
    }

    return signals;
}

export function detectRepeatedToolCalls(messages: RetrospectiveMessage[]): FrictionSignal[] {
    const byTool = new Map<string, RetrospectiveMessage[]>();
    for (const message of messages) {
        if (!isToolMessage(message) || !message.toolName) continue;
        const existing = byTool.get(message.toolName) ?? [];
        existing.push(message);
        byTool.set(message.toolName, existing);
    }

    const signals: FrictionSignal[] = [];
    for (const [toolName, toolMessages] of byTool) {
        const sorted = sortedByOrdinal(toolMessages);
        for (let start = 0; start < sorted.length; start += 1) {
            const anchor = sorted[start];
            if (!anchor) continue;
            const window = sorted.filter(
                (candidate) =>
                    candidate.ordinal >= anchor.ordinal &&
                    Math.abs(candidate.ts - anchor.ts) <= REPEATED_TOOL_CALL_WINDOW_MS,
            );
            if (window.length >= REPEATED_TOOL_CALL_MIN_COUNT) {
                signals.push({
                    kind: "repeated_tool_call",
                    ordinals: uniqueOrdinals(window.slice(0, REPEATED_TOOL_CALL_MIN_COUNT)),
                    message: `tool ${toolName} repeated ${window.length} times in a short window`,
                    score: window.length,
                });
                break;
            }
        }
    }

    return signals;
}

export function detectToolErrorBurst(messages: RetrospectiveMessage[]): FrictionSignal[] {
    const tools = sortedByOrdinal(messages.filter(isToolMessage));
    const signals: FrictionSignal[] = [];

    for (let start = 0; start < tools.length; start += 1) {
        const anchor = tools[start];
        if (!anchor) continue;
        const window = tools.filter(
            (candidate) =>
                candidate.ordinal >= anchor.ordinal &&
                Math.abs(candidate.ts - anchor.ts) <= TOOL_ERROR_BURST_WINDOW_MS,
        );
        if (window.length < TOOL_ERROR_BURST_MIN_RESULTS) continue;

        const errors = window.filter((message) => message.isError === true);
        const errorRate = errors.length / window.length;
        if (errors.length >= TOOL_ERROR_BURST_MIN_ERRORS && errorRate >= TOOL_ERROR_BURST_RATE) {
            signals.push({
                kind: "tool_error_burst",
                ordinals: uniqueOrdinals(errors),
                message: `tool results had ${(errorRate * 100).toFixed(0)}% error rate`,
                score: errorRate,
            });
            break;
        }
    }

    return signals;
}

export function frustrationMarkerScore(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;

    let score = 0;
    if (PUNCTUATION_RUN_REGEX.test(trimmed)) score += 1;
    if (CAPS_BURST_REGEX.test(trimmed)) score += 1;
    if (STRONG_CORRECTION_PHRASE_REGEX.test(trimmed)) score += 2;

    const correctionMarkers = trimmed.match(CORRECTION_MARKER_REGEX) ?? [];
    const repeatedNoWrongAgainStop = correctionMarkers.filter((marker) =>
        /^(?:again|no|stop|wrong)$/i.test(marker),
    );
    score += Math.min(correctionMarkers.length, FRUSTRATION_MIN_MARKER_SCORE);
    if (repeatedNoWrongAgainStop.length >= FRUSTRATION_MIN_MARKER_SCORE) score += 1;

    return score;
}

export function containsFrustrationMarker(text: string): boolean {
    return FRUSTRATION_MARKER_REGEX.test(text);
}

export function detectFrustrationMarkers(messages: RetrospectiveMessage[]): FrictionSignal[] {
    return sortedByOrdinal(messages.filter((message) => isRole(message, "user"))).flatMap(
        (message) => {
            const score = frustrationMarkerScore(textOf(message));
            if (score < FRUSTRATION_MIN_MARKER_SCORE) return [];
            return [
                {
                    kind: "frustration_marker" as const,
                    ordinals: [message.ordinal],
                    message: "user correction/frustration markers",
                    score,
                },
            ];
        },
    );
}

export function detectFrictionSignals(messages: RetrospectiveMessage[]): FrictionSignal[] {
    return [
        ...detectRepeatedUserMessages(messages),
        ...detectRepeatedToolCalls(messages),
        ...detectToolErrorBurst(messages),
        ...detectFrustrationMarkers(messages),
    ].sort((a, b) => (a.ordinals[0] ?? 0) - (b.ordinals[0] ?? 0) || a.kind.localeCompare(b.kind));
}
