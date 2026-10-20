import {
    type OrdinalMint,
    ordinalForRegistryKey,
    type ReduceInputOutcome,
} from "./reduce-resolver";

/**
 * The ctx_reduce response grammar (Rev 6 — structured JSON report, user ruling
 * 2026-10-20: arrays for ordinals, structured error objects, prose confined to
 * `note`; replaces the Rev 5.2/5.3 + D18 prose-line grammar). Harness-neutral:
 * every pointing surface answers with identical bytes.
 *
 * Wire form (one-line JSON, keys in this order, all omitted when empty):
 *   {"ctx_handles":[N|"a-b"|null,...],   // positional mirror: one slot PER
 *    //  ENTRY in exact input order (user ruling 2026-10-20); a range slot is
 *    //  its ordinal span; a failed entry's slot is null.
 *   "stamped":[N|"a-b",...],
 *    "noop":{"queued":[N],"released":[N],"compacted":[N],"inert":[N]},
 *    "held":[N|"a-b",...],
 *    "errors":[{"class":"not-found"|"ambiguous"|"range-endpoint"|"mint-unavailable",
 *               "entry":E,"candidates":[N,...],"note":T}],
 *    "note":T}
 * Every bare number is a message ordinal (the number ctx_expand(message=N)
 * eats). Teaching sentences ride `note` values in compact form: the S-1 form
 * clause (a phrase names a message; a tool call releases by its call id), the
 * S-3 window wording ("current context window"), and the S-4 closers
 * ("the rest of the batch was stamped" / "nothing was stamped; resend the
 * corrected batch") are contract text — migrate them with the surface rulings,
 * never ad hoc.
 */

/** Echo a model input in its own format, readable-length truncated. */
export function echoInput(input: string, maxChars = 80): string {
    const collapsed = input.replace(/\s+/g, " ").trim();
    return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

export const NOTHING_RELEASED_CLOSER = "Nothing was stamped; resend the corrected batch.";

const REST_STAMPED_CLOSER = "the rest of the batch was stamped";

export const MINT_UNAVAILABLE = JSON.stringify({
    errors: [
        {
            class: "mint-unavailable",
            note: "Message positions could not be resolved in this session; nothing was changed. Retry in a moment.",
        },
    ],
});

interface ReportError {
    class: "not-found" | "ambiguous" | "range-endpoint" | "mint-unavailable";
    entry: string;
    candidates?: number[];
    note: string;
}

interface Report {
    ctx_handles?: (number | string | null)[];
    stamped?: (number | string)[];
    noop?: Record<string, number[]>;
    held?: (number | string)[];
    errors?: ReportError[];
    note?: string;
}

function serialize(report: Report): string {
    return JSON.stringify(report);
}

/** The teaching clause for a plain not-found (S-1 form law + S-3 window wording). */
function notFoundNote(rangeHint: string | undefined, closer: string): string {
    return [
        "No tool call id and no message text matches it in your current context window.",
        rangeHint,
        "A phrase names a message — prose you wrote or were given; a tool call releases by its call id, not by its output text.",
        closer,
    ]
        .filter((part) => part && part.length > 0)
        .join(" ");
}

function rangeEndpointHint(range: { entry: string; which: "start" | "end" | "both" }): string {
    const which = range.which === "both" ? "start and end" : range.which;
    return `It is the ${which} of the range "${echoInput(range.entry)}". Endpoints inside tool output are call ids.`;
}

function reportErrorFor(
    outcome: Extract<ReduceInputOutcome, { kind: "error" }>,
    mint: OrdinalMint,
    closer: string,
): ReportError {
    if (outcome.reason === "ambiguous") {
        const candidates = (outcome.candidates ?? [])
            .map((candidate) => ordinalForRegistryKey(mint, candidate.messageId))
            .filter((ordinal): ordinal is number => typeof ordinal === "number");
        return {
            class: "ambiguous",
            entry: echoInput(outcome.input),
            ...(candidates.length > 0 ? { candidates } : {}),
            note: [
                `Found twice: the text matches more than one item in your context${
                    candidates.length > 0 ? ` (candidates: ${candidates.join(", ")})` : ""
                }.`,
                outcome.range ? rangeEndpointHint(outcome.range) : undefined,
                `Copy a longer run that contains the one you mean. ${closer}`,
            ]
                .filter((part) => part && part.length > 0)
                .join(" "),
        };
    }
    return {
        class: outcome.range ? "range-endpoint" : "not-found",
        entry: echoInput(outcome.input),
        note: notFoundNote(outcome.range ? rangeEndpointHint(outcome.range) : undefined, closer),
    };
}

export function renderPointingError(
    outcome: Extract<ReduceInputOutcome, { kind: "error" }>,
    mint: OrdinalMint,
): string {
    return serialize({
        errors: [reportErrorFor(outcome, mint, NOTHING_RELEASED_CLOSER)],
    });
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

    const rangeSlot = (outcome: Extract<ReduceInputOutcome, { kind: "range" }>) =>
        outcome.fromOrdinal !== undefined && outcome.toOrdinal !== undefined
            ? `${outcome.fromOrdinal}-${outcome.toOrdinal}`
            : echoInput(entries[outcomes.indexOf(outcome)] ?? "");

    const stamped: (number | string)[] = [];
    const held: (number | string)[] = [];
    const noop: Record<string, number[]> = {};
    const errors: ReportError[] = [];

    const pushUnique = (list: (number | string)[], value: number | string) => {
        if (!list.includes(value)) list.push(value);
    };
    const pushNoop = (reason: string, ordinal: number) => {
        const list = (noop[reason] ??= []);
        if (!list.includes(ordinal)) list.push(ordinal);
    };

    for (const outcome of outcomes) {
        switch (outcome.kind) {
            case "released": {
                const ordinal = ordinalOf(outcome.messageId);
                if (typeof ordinal === "number") pushUnique(stamped, ordinal);
                break;
            }
            case "deferred": {
                const ordinal = ordinalOf(outcome.messageId);
                if (typeof ordinal === "number") pushUnique(held, ordinal);
                break;
            }
            case "noop": {
                const ordinal = ordinalOf(outcome.messageId);
                if (typeof ordinal === "number") pushNoop(outcome.reason, ordinal);
                break;
            }
            case "range": {
                const hasDeferred = outcome.items.some((item) => item.kind === "deferred");
                pushUnique(hasDeferred ? held : stamped, rangeSlot(outcome));
                // Noop facts nested inside a stretch report as class entries.
                for (const item of outcome.items) {
                    if (item.kind === "noop") {
                        const ordinal = ordinalOf(item.messageId);
                        if (typeof ordinal === "number") pushNoop(item.reason, ordinal);
                    }
                }
                break;
            }
            case "error":
                errors.push(reportErrorFor(outcome, mint, REST_STAMPED_CLOSER));
                break;
        }
    }

    // Positional mirror: one slot per entry, exact input order.
    const mirror: (number | string | null)[] = outcomes.map((outcome, index) => {
        if (outcome.kind === "range")
            return outcome.fromOrdinal !== undefined && outcome.toOrdinal !== undefined
                ? `${outcome.fromOrdinal}-${outcome.toOrdinal}`
                : echoInput(entries[index] ?? "");
        if (outcome.kind === "error") return null;
        return ordinalOf(outcome.messageId) ?? echoInput(entries[index] ?? "");
    });

    const report: Report = { ctx_handles: mirror };
    if (stamped.length > 0) report.stamped = stamped;
    if (Object.keys(noop).length > 0) report.noop = noop;
    if (held.length > 0) report.held = held;
    if (errors.length > 0) report.errors = errors;
    if (fresh === 0) {
        report.note =
            "All requested tags were already queued or processed. No new action is needed.";
    }
    return serialize(report);
}

/** The no-arg bulk path answer (both harnesses, one assembly). */
export function renderBulkSuccess(
    deduped: boolean,
    releasedItems: readonly { messageId: string }[],
    inertItems: readonly { messageId: string }[],
    protectedCount: number,
    mint: OrdinalMint,
): string {
    const distinct = (items: readonly { messageId: string }[]): number[] => [
        ...new Set(
            items.flatMap((item) => {
                const ordinal = ordinalForRegistryKey(mint, item.messageId);
                return typeof ordinal === "number" ? [ordinal] : [];
            }),
        ),
    ];
    const report: Report = {};
    const stamped = distinct(releasedItems);
    if (!deduped && stamped.length > 0) report.stamped = stamped;
    const inert = distinct(inertItems);
    if (inert.length > 0) report.noop = { inert };
    if (deduped) {
        report.note =
            "All requested tags were already queued or processed. No new action is needed.";
    } else if (protectedCount > 0) {
        report.note =
            "Newer items are inside the protected working set; they apply once your work displaces them.";
    }
    return serialize(report);
}
