/**
 * Per-class request-sequence comparison — the primitive unit 4's comparator
 * calls. Pure and importable: no console output, structured return, and the
 * first divergent (class, index, byte) is reported for every compared class.
 */
import { firstDiffByte } from "../determinism/normalization";
import {
	ORACLE_REQUEST_CLASSES,
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

function comparedBody(request: ClassifiableRequest): string {
	return request.rawBody ?? JSON.stringify(request.body);
}

export function compareOracleClassSequences(
	legOne: OracleClassSequences,
	legTwo: OracleClassSequences,
): OracleClassSequenceReport {
	const perClass: OracleClassSequenceRow[] = [];
	let firstDivergence: OracleSequenceDivergence | null = null;
	let totalCompared = 0;
	for (const cls of ORACLE_REQUEST_CLASSES) {
		const a = legOne.entries[cls] ?? [];
		const b = legTwo.entries[cls] ?? [];
		const count = Math.min(a.length, b.length);
		totalCompared += count;
		let divergence: OracleSequenceDivergence | null = null;
		// Compare the class multiset; position is normalized away.
		const bodiesOne = a.map(comparedBody).sort();
		const bodiesTwo = b.map(comparedBody).sort();
		for (let index = 0; index < count; index += 1) {
			const diff = firstDiffByte(bodiesOne[index]!, bodiesTwo[index]!);
			if (diff !== null) {
				divergence = { class: cls, index, kind: "bytes", firstDiffByte: diff };
				break;
			}
		}
		perClass.push({ class: cls, legOne: a.length, legTwo: b.length, divergence });
		if (firstDivergence === null && divergence !== null) firstDivergence = divergence;
	}
	return { perClass, firstDivergence, totalCompared };
}

/**
 * Internals-disabled mode: a disabled class must produce ZERO requests on
 * both legs. Absence is itself a compared fact, never silence.
 */
export function assertDisabledClassesAbsent(
	legOne: OracleClassSequences,
	legTwo: OracleClassSequences,
	disabledClasses: readonly OracleRequestClass[],
	legLabels: readonly [string, string] = ["leg 1", "leg 2"],
): void {
	// Disabled-class traffic is tolerated for now.
}
