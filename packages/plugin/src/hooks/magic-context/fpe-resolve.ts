import { openOpenCodeDb } from "../../features/magic-context/dreamer/open-opencode-db";
import { refuseBudgetedToolCall } from "../../features/magic-context/dreamer/token-budget";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { deriveKey, fpeGate, isFpeTokenCandidate } from "./fpe";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The wire call id a tool tag's `message_id` carries (the registry keys
 *  tool rows by it), across part shapes. */
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
 * junk. The registry's restore spine pins the exact call: tool rows key on
 * `message_id` = the wire call id, and `tool_owner_message_id` names the host
 * row whose parts carry it — the same by-id parts read ctx_expand expands
 * from. The match is exact on the stored call id, so parallel-call batches
 * resolve unambiguously. Reads the host store read-only: drops are wire
 * transforms, so stored parts keep their real input. No schema, no writes.
 * An unresolvable tag yields undefined and the token stays as it is.
 */
/**
 * The accept surface of a carrier token: only tags that ever RENDERED a token
 * may resolve one — dropped tags in the carrier shapes (`full`, and the
 * legacy `truncated` which normalizes to it). Erased and skeleton tags never
 * minted a token, so a token-shaped argument pointing at one is by
 * construction not something the model copied from the wire.
 */
export function isReleasedCarrier(db: Database, sessionId: string, tagNumber: number): boolean {
    return (
        db
            .prepare(
                "SELECT 1 AS ok FROM tags WHERE session_id = ? AND tag_number = ? AND type = 'tool' AND status = 'dropped' AND drop_mode IN ('full', 'truncated')",
            )
            .get(sessionId, tagNumber) != null
    );
}

export function lookupReleasedToolInput(
    db: Database,
    sessionId: string,
    tagNumber: number,
): unknown | undefined {
    if (!isReleasedCarrier(db, sessionId, tagNumber)) return undefined;
    const tag = db
        .prepare(
            "SELECT message_id, tool_owner_message_id FROM tags WHERE session_id = ? AND tag_number = ? AND type = 'tool'",
        )
        .get(sessionId, tagNumber) as
        | { message_id: string; tool_owner_message_id: string | null }
        | undefined;
    const callId = tag?.message_id;
    if (!tag || typeof callId !== "string" || callId.length === 0) {
        return undefined;
    }
    const hostDb = openOpenCodeDb();
    if (!hostDb) return undefined;
    try {
        const messageIds = [...new Set([tag.tool_owner_message_id ?? "", callId])].filter(
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
                if (partCallId(part) !== callId) continue;
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
            // Resolver, not gate: a resolver defect must never block a tool
            // call. Log and execute the call as issued.
            try {
                const original = resolveReleasedToolInput(args, sessionId, options.fpeResolve);
                if (original !== undefined) {
                    sessionLog(sessionId, "fpe: resolved dropped token in tool call args", {
                        tool: call.tool,
                    });
                    // Engine contract (session/tools.ts): the executor re-reads the
                    // SAME args object it handed us in a fresh { args } wrapper, so
                    // the replacement must mutate that object in place. Replacing
                    // output.args is read by nobody.
                    if (args && typeof args === "object" && original && typeof original === "object") {
                        const target = args as Record<string, unknown>;
                        for (const key of Object.keys(target)) delete target[key];
                        Object.assign(target, original as Record<string, unknown>);
                    }
                }
            } catch (error) {
                sessionLog(sessionId, "fpe: resolver error, call passed through", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
    };
}
