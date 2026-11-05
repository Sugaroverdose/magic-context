import {
    type OrdinalMint,
    ordinalForRegistryKey,
    type ReduceInputOutcome,
} from "./reduce-resolver";

/**
 * The ctx_reduce response grammar (Rev 6.1 — structured JSON report, Rev 6
 * user ruling 2026-10-20: arrays for ordinals, structured error objects, prose
 * confined to `note`; Rev 6.1 user ruling 2026-10-22: errors grouped by
 * class+identical note with an `entries` array, candidate ordinals no longer
 * published — bare numbers are ctx_expand bait, the opposite of reducing).
 * Harness-neutral: every pointing surface answers with identical bytes.
 *
 * Wire form (one-line JSON, keys in this order, all omitted when empty):
 *   {"ctx_handles":[N|"a-b"|null,...],   // positional mirror: one slot PER
 *    //  ENTRY in exact input order (user ruling 2026-10-20); a range slot is
 *    //  its ordinal span; a failed entry's slot is null.
 *   "stamped":[N|"a-b",...],
 *    "noop":{"queued":[N],"released":[N],"compacted":[N],"inert":[N]},
 *    "held":[N|"a-b",...],
 *    "errors":[{"class":"not-found"|"ambiguous"|"range-endpoint"|"mint-unavailable"|"shape-not-addressable",
 *               "entries":[E,...],"note":T}],
 *    //  Rev 6.1: errors are grouped by (class + byte-identical note), in
 *    //  first-appearance order; the teaching note rides exactly once per
 *    //  group. A duplicate echo appears once inside `entries` — the mirror
 *    //  keeps the per-entry positions, so nothing is lost.
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
    class:
        | "not-found"
        | "ambiguous"
        | "range-endpoint"
        | "mint-unavailable"
        | "shape-not-addressable";
    entries: string[];
    note: string;
}

interface Report {
    ctx_handles?: (number | string | null)[];
    stamped?: (number | string)[];
    noop?: Record<string, number[]>;
    held?: (number | string)[];
    /** Stamps refused because they targeted ctx_reduce's own reports. */
    refused?: { self_stamps: (number | string)[] };
    errors?: ReportError[];
    note?: string;
}

/** Upstream law: ctx_reduce's own outputs are housekeeping, cleaned automatically. */
export function selfStampSentence(count: number): string {
    return count === 1
        ? "1 was a ctx_reduce call; leave those alone, they are cleaned up automatically."
        : `${count} were ctx_reduce calls; leave those alone, they are cleaned up automatically.`;
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
    closer: string,
): ReportError {
    if (outcome.reason === "ambiguous") {
        if (outcome.fromCallId) {
            // Call-id lane: the entry is atomic — "copy a longer run" is a
            // correction that cannot exist. Teach the lane that can work.
            return {
                class: "ambiguous",
                entries: [echoInput(outcome.input)],
                note: [
                    "This call id appears twice: it was re-used and both calls are still in your context.",
                    `Name the one you mean with a phrase from it instead of the id. ${closer}`,
                ].join(" "),
            };
        }
        return {
            class: "ambiguous",
            entries: [echoInput(outcome.input)],
            note: [
                // Rev 6.1: candidate ordinals are not published — a bare
                // number is ctx_expand bait, the opposite of reducing.
                "Found twice: the text matches more than one item in your context.",
                outcome.range ? rangeEndpointHint(outcome.range) : undefined,
                `Copy a longer run that contains the one you mean. ${closer}`,
            ]
                .filter((part) => part && part.length > 0)
                .join(" "),
        };
    }
    if (outcome.reason === "shape-not-addressable") {
        return {
            class: "shape-not-addressable",
            entries: [echoInput(outcome.input)],
            note: [
                "That text names a message carried as more than one call: no phrase pins a single one.",
                `Point with the call id of the call you mean. ${closer}`,
            ].join(" "),
        };
    }
    return {
        class: outcome.range ? "range-endpoint" : "not-found",
        entries: [echoInput(outcome.input)],
        note: [
            // S-2 zero-token report clause: name the shape, teach the lane.
            outcome.zeroToken
                ? "Entry has no searchable text — point by prose words or the call id."
                : undefined,
            notFoundNote(outcome.range ? rangeEndpointHint(outcome.range) : undefined, closer),
        ]
            .filter((part) => part !== undefined)
            .join(" "),
    };
}

/**
 * Rev 6.1: collapse per-entry errors into one object per (class + byte-
 * identical note), first-appearance order. Duplicate echoes merge into a single
 * `entries` group entry; the positional mirror keeps per-entry positions.
 * Each input error carries exactly one entry (reportErrorFor builds it).
 */
function groupErrors(errors: readonly ReportError[]): ReportError[] {
    const groups: ReportError[] = [];
    const index = new Map<string, ReportError>();
    for (const error of errors) {
        for (const entry of error.entries) {
            const key = `${error.class}\u0000${error.note}`;
            const existing = index.get(key);
            if (existing) {
                if (!existing.entries.includes(entry)) existing.entries.push(entry);
            } else {
                const group: ReportError = {
                    class: error.class,
                    entries: [entry],
                    note: error.note,
                };
                index.set(key, group);
                groups.push(group);
            }
        }
    }
    return groups;
}

export function renderPointingError(
    outcomes: readonly Extract<ReduceInputOutcome, { kind: "error" }>[],
): string {
    return serialize({
        errors: groupErrors(
            outcomes.map((outcome) => reportErrorFor(outcome, NOTHING_RELEASED_CLOSER)),
        ),
    });
}

export function renderPointingSuccess(
    entries: readonly string[],
    outcomes: readonly ReduceInputOutcome[],
    mint: OrdinalMint,
    selfStampedTagNumbers?: ReadonlySet<number>,
): string {
    const ordinalOf = (messageId: string): number | undefined =>
        ordinalForRegistryKey(mint, messageId);

    const flat = outcomes.flatMap((outcome) =>
        outcome.kind === "range" ? outcome.items : [outcome],
    );
    const isSelfStamp = (tagNumber: number): boolean =>
        selfStampedTagNumbers?.has(tagNumber) ?? false;
    const fresh = flat.filter(
        (outcome) =>
            (outcome.kind === "released" || outcome.kind === "deferred") &&
            !isSelfStamp(outcome.tagNumber),
    ).length;

    const rangeSlot = (outcome: Extract<ReduceInputOutcome, { kind: "range" }>) =>
        outcome.fromOrdinal !== undefined && outcome.toOrdinal !== undefined
            ? `${outcome.fromOrdinal}-${outcome.toOrdinal}`
            : echoInput(entries[outcomes.indexOf(outcome)] ?? "");

    const stamped: (number | string)[] = [];
    const held: (number | string)[] = [];
    const refusedSelf: (number | string)[] = [];
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
                if (typeof ordinal === "number")
                    pushUnique(isSelfStamp(outcome.tagNumber) ? refusedSelf : stamped, ordinal);
                break;
            }
            case "deferred": {
                const ordinal = ordinalOf(outcome.messageId);
                if (typeof ordinal === "number")
                    pushUnique(isSelfStamp(outcome.tagNumber) ? refusedSelf : held, ordinal);
                break;
            }
            case "noop": {
                const ordinal = ordinalOf(outcome.messageId);
                if (typeof ordinal === "number") pushNoop(outcome.reason, ordinal);
                break;
            }
            case "range": {
                const actionable = outcome.items.filter(
                    (item) =>
                        (item.kind === "released" || item.kind === "deferred") &&
                        !isSelfStamp(item.tagNumber),
                );
                const selfOnly =
                    outcome.items.every(
                        (item) =>
                            item.kind === "noop" ||
                            ("tagNumber" in item && isSelfStamp(item.tagNumber)),
                    ) &&
                    outcome.items.some(
                        (item) => "tagNumber" in item && isSelfStamp(item.tagNumber),
                    );
                if (selfOnly) {
                    pushUnique(refusedSelf, rangeSlot(outcome));
                    break;
                }
                if (actionable.length === 0) break;
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
                errors.push(reportErrorFor(outcome, REST_STAMPED_CLOSER));
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
    if (errors.length > 0) report.errors = groupErrors(errors);
    const notes: string[] = [];
    if (refusedSelf.length > 0) {
        report.refused = { self_stamps: refusedSelf };
        notes.push(selfStampSentence(refusedSelf.length));
    }
    if (fresh === 0) {
        notes.push("All requested tags were already queued or processed. No new action is needed.");
    }
    if (notes.length > 0) report.note = notes.join(" ");
    return serialize(report);
}

/** The no-arg bulk path answer (both harnesses, one assembly). */
export function renderBulkSuccess(
    deduped: boolean,
    releasedItems: readonly { messageId: string }[],
    inertItems: readonly { messageId: string }[],
    protectedCount: number,
    mint: OrdinalMint,
    selfStampedCount = 0,
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
    const notes: string[] = [];
    if (deduped) {
        notes.push("All requested tags were already queued or processed. No new action is needed.");
    } else if (protectedCount > 0) {
        notes.push(
            "Newer items are inside the protected working set; they apply once your work displaces them.",
        );
    }
    if (selfStampedCount > 0) notes.push(selfStampSentence(selfStampedCount));
    if (notes.length > 0) report.note = notes.join(" ");
    return serialize(report);
}
