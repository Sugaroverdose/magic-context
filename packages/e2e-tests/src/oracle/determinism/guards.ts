/**
 * Comparator guards for the oracle determinism self-test.
 *
 * These are the parts of the apparatus that keep a green result honest:
 * - the pass arm must reject a vacuous (zero-request) capture, and must find the
 *   pinned "Today's date" line inside the corpus it actually compared (R2);
 * - the instrument control must bind its diff to the mutated request, so ambient
 *   nondeterminism can never stand in for mutation sensitivity (R3);
 * - a captured request without a verbatim raw body is refused, never silently
 *   re-serialized from the parsed object (N1).
 */

export interface OracleCapturedRequest {
	method: string;
	path: string;
	/** Verbatim provider request bytes, captured before JSON parsing. */
	rawBody?: string;
}

export interface DiffRef {
	requestIndex: number;
}

export const ORACLE_MUTATION_MARKER = "second user turn MUTATED — instrument control";

/**
 * Verbatim wire bytes. The parsed `body` is a fallback that hides the exact byte
 * layout (and any producer that changed it), so an absent raw body is a refusal,
 * not a re-serialization opportunity.
 */
export function rawBodyOf(request: OracleCapturedRequest): string {
	if (typeof request.rawBody !== "string" || request.rawBody.length === 0) {
		throw new Error(
			`oracle: captured provider request has no rawBody (${request.method} ${request.path}) — raw-byte comparison refused rather than falling back to parsed JSON`,
		);
	}
	return request.rawBody;
}

/**
 * R2: a pass arm over zero compared requests proves nothing. Also require the
 * pinned date line to exist INSIDE the compared corpus, so a filtered run that
 * captured only unrelated requests cannot green on an empty comparison.
 */
export function assertNonVacuousComparedCorpus(options: {
	legOneRaw: readonly string[];
	legTwoRaw: readonly string[];
	pinnedLine: string;
}): void {
	const { legOneRaw, legTwoRaw, pinnedLine } = options;
	if (legOneRaw.length === 0 || legTwoRaw.length === 0) {
		throw new Error(
			`oracle determinism: zero compared provider requests (leg 1: ${legOneRaw.length}, leg 2: ${legTwoRaw.length}) — a filtered single-arm run cannot green on empty captures`,
		);
	}
	for (const [label, corpus] of [
		["leg 1", legOneRaw],
		["leg 2", legTwoRaw],
	] as const) {
		if (!corpus.some((raw) => raw.includes(pinnedLine))) {
			throw new Error(
				`oracle determinism: pinned date line ${JSON.stringify(pinnedLine)} is absent from the ${label} compared corpus — the wrapper's system hook did not fire on the bytes being compared`,
			);
		}
	}
}

/**
 * R3: locate the request that carries the planted mutation marker in leg 2 and
 * prove it is absent from leg 1 at the same index. Returns the wire request index
 * the control must bind its diff to.
 */
export function bindMutationToCorpus(options: {
	legOneRaw: readonly string[];
	legTwoRaw: readonly string[];
	marker: string;
}): number {
	const { legOneRaw, legTwoRaw, marker } = options;
	const index = legTwoRaw.findIndex((raw) => raw.includes(marker));
	if (index < 0) {
		throw new Error(
			`oracle determinism: mutation marker ${JSON.stringify(marker)} is absent from the leg-2 compared corpus — the control is dark`,
		);
	}
	if (legOneRaw[index]?.includes(marker)) {
		throw new Error(
			`oracle determinism: mutation marker is present in the unmutated leg at request#${index} — the fixture is self-mutated`,
		);
	}
	return index;
}

/**
 * R3: a control goes green only when a diff lands at or after the mutated
 * request. A diff confined to earlier requests is ambient nondeterminism and is
 * not evidence that the comparator can see a wire change.
 */
export function assertMutationSpecificDiff(options: {
	differences: readonly DiffRef[];
	legOneRaw: readonly string[];
	legTwoRaw: readonly string[];
	marker: string;
}): number {
	const { differences, legOneRaw, legTwoRaw, marker } = options;
	if (differences.length === 0) {
		throw new Error(
			"oracle determinism: comparator sensitivity control went dark — a mutated second turn produced byte-identical provider bodies; the apparatus cannot detect a wire change and its pass on the unmutated leg is not evidence",
		);
	}
	const index = bindMutationToCorpus({ legOneRaw, legTwoRaw, marker });
	if (legOneRaw[index] === legTwoRaw[index]) {
		throw new Error(
			`oracle determinism: mutation marker is present at request#${index} but the two legs' bodies are byte-identical there — the marker did not change the wire`,
		);
	}
	const bound = differences.filter((diff) => diff.requestIndex >= index);
	if (bound.length === 0) {
		throw new Error(
			`oracle determinism: comparator sensitivity control went dark — every diff is ambient nondeterminism before the mutated request#${index}; ambient differences cannot prove mutation sensitivity`,
		);
	}
	return index;
}
