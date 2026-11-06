/**
 * Per-class request-sequence comparison — the primitive unit 4's comparator
 * calls. Pure and importable: no console output, structured return, and the
 * first divergent (class, index, byte) is reported for every compared class.
 */
import { firstDiffByte } from "../determinism/normalization";
import { rawBodyOf } from "../determinism/guards";
import {
	ORACLE_REQUEST_CLASSES,
	requireOracleClassSequences,
	type ClassifiableRequest,
	type OracleClassSequences,
	type OracleRequestClass,
} from "./classifier";

export interface OracleSequenceDivergence {
	class: OracleRequestClass;
	index: number;
	/** "count": the two legs hold different request counts for this class. */
	kind: "count" | "bytes";
	/** Byte offset of the first difference; null for a "count" divergence. */
	firstDiffByte: number | null;
}

export interface OracleClassSequenceRow {
	class: OracleRequestClass;
	legOne: number;
	legTwo: number;
	divergence: OracleSequenceDivergence | null;
}

export interface OracleClassSequenceReport {
	/** One row per vocabulary class, in vocabulary order — zero rows included. */
	perClass: OracleClassSequenceRow[];
	firstDivergence: OracleSequenceDivergence | null;
	totalCompared: number;
}

/**
 * The compared artifact is the verbatim wire bytes — unit 1b's N1 rule: an
 * absent raw body is a refusal, never a re-serialization of the parsed object.
 */
function comparedBody(request: ClassifiableRequest): string {
	return rawBodyOf(request);
}

function firstClassDivergence(
	cls: OracleRequestClass,
	bodiesOne: readonly string[],
	bodiesTwo: readonly string[],
): OracleSequenceDivergence | null {
	const overlap = Math.min(bodiesOne.length, bodiesTwo.length);
	let byteDivergence: OracleSequenceDivergence | null = null;
	for (let index = 0; index < overlap; index += 1) {
		const diff = firstDiffByte(bodiesOne[index]!, bodiesTwo[index]!);
		if (diff !== null) {
			byteDivergence = { class: cls, index, kind: "bytes", firstDiffByte: diff };
			break;
		}
	}
	// (a) same length, (b) element-wise identity — the missing element is the
	// coarser fact, so a count divergence wins a tie on index.
	let countDivergence: OracleSequenceDivergence | null = null;
	if (bodiesOne.length !== bodiesTwo.length) {
		countDivergence = { class: cls, index: overlap, kind: "count", firstDiffByte: null };
	}
	if (byteDivergence === null) return countDivergence;
	if (countDivergence === null) return byteDivergence;
	return countDivergence.index <= byteDivergence.index ? countDivergence : byteDivergence;
}

/**
 * Compare two classified legs. Pure: no console output, structured return,
 * and the inputs must be classifier output (a hand-built sequence — the path
 * that skips classification — is refused). Each vocabulary class produces a
 * row even when zero on both legs: absence is a compared fact, not silence.
 */
export function compareOracleClassSequences(
	legOne: OracleClassSequences,
	legTwo: OracleClassSequences,
): OracleClassSequenceReport {
	const one = requireOracleClassSequences(legOne, "compareOracleClassSequences(leg 1)");
	const two = requireOracleClassSequences(legTwo, "compareOracleClassSequences(leg 2)");
	const perClass: OracleClassSequenceRow[] = [];
	let firstDivergence: OracleSequenceDivergence | null = null;
	let totalCompared = 0;
	for (const cls of ORACLE_REQUEST_CLASSES) {
		const requestsOne = one.entries[cls];
		const requestsTwo = two.entries[cls];
		// Sequence, not set: arrival order inside the class is preserved and
		// compared positionally — a reordering is a finding, not noise.
		const bodiesOne = requestsOne.map(comparedBody);
		const bodiesTwo = requestsTwo.map(comparedBody);
		totalCompared += Math.min(bodiesOne.length, bodiesTwo.length);
		const divergence = firstClassDivergence(cls, bodiesOne, bodiesTwo);
		perClass.push({ class: cls, legOne: bodiesOne.length, legTwo: bodiesTwo.length, divergence });
		if (firstDivergence === null && divergence !== null) firstDivergence = divergence;
	}
	return { perClass, firstDivergence, totalCompared };
}

/**
 * Internals-disabled mode (memory.enabled=false, historian.disable=true,
 * dreamer.disable=true — the oc2-wire-dump.ts precedent): a disabled class
 * must produce ZERO requests on both legs. Absence is asserted PER CLASS as a
 * compared fact, never by ignoring the class.
 */
export function assertDisabledClassesAbsent(
	legOne: OracleClassSequences,
	legTwo: OracleClassSequences,
	disabledClasses: readonly OracleRequestClass[],
	legLabels: readonly [string, string] = ["leg 1", "leg 2"],
): void {
	const one = requireOracleClassSequences(legOne, "assertDisabledClassesAbsent(leg 1)");
	const two = requireOracleClassSequences(legTwo, "assertDisabledClassesAbsent(leg 2)");
	for (const cls of disabledClasses) {
		for (const [label, sequences] of [
			[legLabels[0], one],
			[legLabels[1], two],
		] as const) {
			const requests = sequences.entries[cls];
			if (requests.length === 0) continue;
			const first = requests[0]!;
			throw new Error(
				`oracle unit 2: disabled class "${cls}" produced ${requests.length} request(s) on ${label} ` +
					`(internals-disabled legs must show this class ABSENT on both legs; first offender: ` +
					`model ${JSON.stringify(first.body.model ?? null)} at ${first.method} ${first.path})`,
			);
		}
	}
}
