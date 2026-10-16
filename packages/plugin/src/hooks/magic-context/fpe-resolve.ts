import { openOpenCodeDb } from "../../features/magic-context/dreamer/open-opencode-db";
import { getTagById } from "../../features/magic-context/storage";
import type { Database } from "../../shared/sqlite";

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inputFromPartRow(raw: string): Record<string, unknown> | undefined {
    let part: unknown;
    try {
        part = JSON.parse(raw);
    } catch {
        return undefined;
    }
    if (!isRecord(part)) return undefined;
    if (part.type === "tool" && isRecord(part.state) && isRecord(part.state.input)) {
        return part.state.input;
    }
    if (part.type === "tool-invocation" && isRecord(part.args)) return part.args;
    if (part.type === "tool_use" && isRecord(part.input)) return part.input;
    return undefined;
}

function carrierValue(input: Record<string, unknown>): string | undefined {
    for (const value of Object.values(input)) {
        if (typeof value === "string") return value;
    }
    return undefined;
}

/**
 * Resolve an FPE drop token's tag number to the value that sat in the
 * carrier's seat: the original tool input's FIRST string value — the mirror
 * of the `full`-mode carrier render, so the hook's value substitution
 * restores the original bytes in place. Reads the host store read-only:
 * drops are wire transforms, so the stored part keeps its real input (the
 * same property ctx_expand expands from). No schema, no writes.
 *
 * Resolution is refused when the owner message carries more than one tool
 * part (the tags row keys the call by message, so a parallel-call batch is
 * ambiguous here) or when the host store is unavailable (Pi harness). An
 * unresolved token stays an unresolved token.
 */
export function lookupReleasedToolInput(
    db: Database,
    sessionId: string,
    tagNumber: number,
): unknown | undefined {
    const tag = getTagById(db, sessionId, tagNumber);
    if (tag?.type !== "tool" || !tag.messageId) return undefined;
    const hostDb = openOpenCodeDb();
    if (!hostDb) return undefined;
    try {
        const rows = hostDb
            .prepare("SELECT data FROM part WHERE +session_id = ? AND message_id = ?")
            .all(sessionId, tag.messageId) as { data: string }[];
        let found: Record<string, unknown> | undefined;
        let count = 0;
        for (const row of rows) {
            if (typeof row.data !== "string") continue;
            const input = inputFromPartRow(row.data);
            if (input === undefined) continue;
            count += 1;
            found = input;
        }
        if (count !== 1 || !found) return undefined;
        return carrierValue(found);
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
