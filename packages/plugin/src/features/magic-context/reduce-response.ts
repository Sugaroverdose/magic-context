import {
    ordinalForRegistryKey,
    type OrdinalMint,
    type ReduceInputOutcome,
} from "./reduce-resolver";

/**
 * The ctx_reduce v1 response grammar (Rev 5.2/5.3 + D18) — harness-neutral so
 * every pointing surface answers with identical bytes. The settled success
 * shape: optional leading upstream sentence (all-noop case), then ONE array
 * line — the positional mirror: one SLOT PER ENTRY in exact input order; a
 * slot holds the MESSAGE ORDINAL of the item (the same number
 * ctx_expand(message=N) eats), a range entry's slot holds its ordinal span
 * `first-last`. Then noop fact lines, then the protected promise lines echoing
 * the model's own input bytes. Every bare number anywhere is a message
 * ordinal.
 */

/** Echo a model input in its own format, readable-length truncated. */
export function echoInput(input: string, maxChars = 80): string {
    const collapsed = input.replace(/\s+/g, " ").trim();
    return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

export const NOTHING_RELEASED_CLOSER = "Nothing was released; resend the corrected batch.";

export const MINT_UNAVAILABLE =
    "Error: Message positions could not be resolved in this session; nothing was changed. Retry in a moment.";

export function renderPointingError(
    outcome: Extract<ReduceInputOutcome, { kind: "error" }>,
    mint: OrdinalMint,
): string {
    const rangeHint = outcome.range
        ? ` It is the ${outcome.range.which} of the range "${echoInput(outcome.range.entry)}".`
        : "";
    if (outcome.reason === "ambiguous") {
        const candidates = (outcome.candidates ?? [])
            .map((candidate) => {
                const ordinal = ordinalForRegistryKey(mint, candidate.messageId);
                const position = typeof ordinal === "number" ? `${ordinal}: ` : "";
                return `${position}"${echoInput(candidate.excerpt, 60)}"`;
            })
            .join("; ");
        return [
            `error: "${echoInput(outcome.input)}" provided in ctx_handles was found twice: the text matches more than one item in your context.`,
            rangeHint.trim().length > 0 ? rangeHint.trim() : "",
            candidates.length > 0 ? `Candidates (context positions): ${candidates}.` : "",
            `Copy a longer run that contains the one you mean. ${NOTHING_RELEASED_CLOSER}`,
        ]
            .filter(Boolean)
            .join(" ");
    }
    return `error: "${echoInput(outcome.input)}" provided in ctx_handles was not found: no tool call id and no message text matches it in this session.${rangeHint} Copy a call id or a verbatim run of text exactly from what you can see, or drop this entry and resend the rest. ${NOTHING_RELEASED_CLOSER}`;
}

export function renderPointingSuccess(
    entries: readonly string[],
    outcomes: readonly ReduceInputOutcome[],
    mint: OrdinalMint,
): string {
    const ordinalOf = (messageId: string): number | undefined =>
        ordinalForRegistryKey(mint, messageId);

    const flat = outcomes.flatMap((outcome) =>
        outcome.kind === "range" ? outcome.items : [outcome],
    );
    const fresh = flat.filter(
        (outcome) => outcome.kind === "released" || outcome.kind === "deferred",
    ).length;

    const lines: string[] = [];
    if (fresh === 0) {
        lines.push("All requested tags were already queued or processed. No new action is needed.");
    }

    const slots = outcomes.map((outcome) => {
        if (outcome.kind === "range")
            return outcome.fromOrdinal !== undefined && outcome.toOrdinal !== undefined
                ? `${outcome.fromOrdinal}-${outcome.toOrdinal}`
                : echoInput(entries[outcomes.indexOf(outcome)] ?? "");
        if (outcome.kind === "error") return "?";
        return String(ordinalOf(outcome.messageId) ?? "?");
    });
    lines.push(`ctx_handles: ${slots.join(", ")}.`);

    const noopLine = (reason: "released" | "compacted" | "queued" | "inert", label: string) => {
        const ordinals = [
            ...new Set(
                flat.flatMap((outcome) =>
                    outcome.kind === "noop" && outcome.reason === reason
                        ? [ordinalOf(outcome.messageId)]
                        : [],
                ),
            ),
        ].filter((ordinal): ordinal is number => typeof ordinal === "number");
        if (ordinals.length > 0) {
            lines.push(`${label}: ${ordinals.join(", ")}.`);
        }
    };
    noopLine("released", "already released");
    noopLine("compacted", "already compacted");
    noopLine("queued", "queued for release");
    noopLine("inert", "nothing to reclaim");

    const protectedEntries = outcomes.flatMap((outcome, index) =>
        outcome.kind === "deferred" ? [echoInput(entries[index] ?? "")] : [],
    );
    if (protectedEntries.length > 0) {
        const list =
            protectedEntries.length === 1
                ? `${protectedEntries[0]} provided in ctx_handles is inside the protected working set; it applies once newer work displaces it.`
                : `${protectedEntries.join(", ")} provided in ctx_handles are inside the protected working set; they apply once newer work displaces them.`;
        lines.push(list);
    }
    const protectedRanges = outcomes.filter(
        (outcome) =>
            outcome.kind === "range" && outcome.items.some((item) => item.kind === "deferred"),
    );
    for (const outcome of protectedRanges) {
        const entryIndex = outcomes.indexOf(outcome);
        lines.push(
            `${echoInput(entries[entryIndex] ?? "")} covers items inside the protected working set; they apply once newer work displaces them.`,
        );
    }
    return lines.join("\n");
}
