import { refuseBudgetedToolCall } from "../../features/magic-context/dreamer/token-budget";
import { sessionLog } from "../../shared/logger";
import { deriveKey, fpeGate, isFpeTokenCandidate } from "./fpe";
import { openOpenCodeDb } from "../../features/magic-context/dreamer/open-opencode-db";
import type { Database } from "../../shared/sqlite";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The call id a tool tag's content_id stores, across part shapes. */
function partCallId(part: Record<string, unknown>): string | undefined {
    if (typeof part.callID === "string") return part.callID;
    if (typeof part.callId === "string") return part.callId;
    if (typeof part.tool_use_id === "string") return part.tool_use_id;
    return undefined;
}

function partToolInput(part: Record<string, unknown>): unknown | undefined {
    if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
        return part.state.input;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) return part.args;
    if (part.type === "tool_use" && isRecord(part.input)) return part.input;
    return undefined;
}

/**
 * Resolve an FPE drop token's tag number to the ORIGINAL tool call input —
 * the `.before` contract: a re-emitted carrier runs the call it names, never
 * junk. The tags row pins the exact call (content_id = the wire call id), so
 * parallel-call batches resolve unambiguously. Reads the host store
 * read-only: drops are wire transforms, so stored parts keep their real
 * input (the same property ctx_expand expands from). No schema, no writes.
 * An unresolvable tag yields undefined and the token stays as it is.
 */
export function lookupReleasedToolInput(
    db: Database,
    sessionId: string,
    tagNumber: number,
): unknown | undefined {
    const tag = db
        .prepare(
            "SELECT content_id, message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND tag_number = ? AND type = 'tool'",
        )
        .get(sessionId, tagNumber) as
        | { content_id: string | null; message_id: string; tool_owner_message_id: string | null }
        | undefined;
    if (!tag || typeof tag.content_id !== "string" || tag.content_id.length === 0) {
        return undefined;
    }
    const hostDb = openOpenCodeDb();
    if (!hostDb) return undefined;
    try {
        const messageIds = [...new Set([tag.message_id, tag.tool_owner_message_id ?? ""])].filter(
            (id) => id.length > 0,
        );
        for (const messageId of messageIds) {
            const rows = hostDb
                .prepare("SELECT data FROM part WHERE +session_id = ? AND message_id = ?")
                .all(sessionId, messageId) as { data: string }[];
            for (const row of rows) {
                if (typeof row.data !== "string") continue;
                let part: unknown;
                try {
                    part = JSON.parse(row.data);
                } catch {
                    continue;
                }
                if (!isRecord(part)) continue;
                if (partCallId(part) !== tag.content_id) continue;
                const input = partToolInput(part);
                if (input !== undefined) return input;
            }
        }
        return undefined;
    } catch {
        return undefined;
    } finally {
        try {
            hostDb.close();
        } catch {
            // closed best-effort
        }
    }
}

/**
 * FPE resolution deps: given a decrypted tag id, return the ORIGINAL tool
 * call input that the re-emitted carrier must run. The `.before` contract is
 * whole-args replacement: the token names a released call, so the call the
 * model just issued IS that call, executed with its original arguments.
 */
export interface FpeResolveDeps {
    lookupOriginal: (sessionId: string, tagId: number) => unknown | undefined;
}

function findFpeTagId(value: unknown, key: bigint, currentL: number): number | undefined {
    if (typeof value === "string") {
        if (!isFpeTokenCandidate(value)) return undefined;
        const result = fpeGate(value, key, currentL);
        return result.matched ? result.tagId : undefined;
    }
    if (Array.isArray(value)) {
        for (const item of value) {
            const tagId = findFpeTagId(item, key, currentL);
            if (tagId !== undefined) return tagId;
        }
        return undefined;
    }
    if (isRecord(value)) {
        for (const item of Object.values(value)) {
            const tagId = findFpeTagId(item, key, currentL);
            if (tagId !== undefined) return tagId;
        }
        return undefined;
    }
    return undefined;
}

/**
 * The shared `.before` FPE resolution used by every harness that has a
 * pre-execute hook: detect a released-call token in the args and return the
 * ORIGINAL input that must run in its place, or undefined when the args
 * carry no resolvable token. Harness adapters log and assign; the
 * detection/replacement contract lives only here.
 */
export function resolveReleasedToolInput(
    args: unknown,
    sessionId: string,
    fpeResolve: FpeResolveDeps,
): unknown | undefined {
    const tagId = findFpeTagId(args, deriveKey(sessionId), 8);
    if (tagId === undefined) return undefined;
    return fpeResolve.lookupOriginal(sessionId, tagId);
}

export interface FpeResolveDepsOption {
    fpeResolve?: FpeResolveDeps;
}

/**
 * OpenCode `tool.execute.before`: dreamer token-budget gate + FPE resolution.
 * The dropped-input refusal regex is NOT wired on this branch — no drop path
 * renders the marker bytes it matched, so the scan would only cost per-call
 * time. Resolution restores the original input before the call executes.
 */
export function createToolExecuteBeforeHook(options: FpeResolveDepsOption = {}) {
    return async (input: unknown, output: unknown): Promise<void> => {
        const call = isRecord(input) ? (input as { tool?: unknown; sessionID?: unknown }) : {};
        const args = isRecord(output) ? (output as { args?: unknown }).args : undefined;
        const sessionId = typeof call.sessionID === "string" ? call.sessionID : undefined;
        if (sessionId) {
            const refusal = refuseBudgetedToolCall(sessionId);
            if (refusal) {
                sessionLog(sessionId, "dreamer token budget: tool call refused", {
                    tool: call.tool,
                    hardStopped: refusal.hardStopped,
                });
                throw new Error(refusal.message);
            }
        }
        if (sessionId && args && options.fpeResolve) {
            const original = resolveReleasedToolInput(args, sessionId, options.fpeResolve);
            if (original !== undefined) {
                sessionLog(sessionId, "fpe: resolved dropped token in tool call args", {
                    tool: call.tool,
                });
                (output as { args: unknown }).args = original;
            }
        }
    };
}
