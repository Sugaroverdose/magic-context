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
 *
 * RED STAGE (TDD): the guard clauses are not wired in this commit. The committed
 * law file `oracle-determinism-guards.test.ts` reddens on exactly the missing
 * throws; the next commit wires them.
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
export function assertNonVacuousComparedCorpus(_options: {
	legOneRaw: readonly string[];
	legTwoRaw: readonly string[];
	pinnedLine: string;
}): void {
	// RED STAGE: guard not wired.
}

/**
 * R3: locate the request that carries the planted mutation marker in leg 2 and
 * prove it is absent from leg 1 at the same index. Returns the wire request index
 * the control must bind its diff to.
 */
export function bindMutationToCorpus(_options: {
	legOneRaw: readonly string[];
	legTwoRaw: readonly string[];
	marker: string;
}): number {
	// RED STAGE: guard not wired.
	return -1;
}

/**
 * R3: a control goes green only when a diff lands at or after the mutated
 * request. A diff confined to earlier requests is ambient nondeterminism and is
 * not evidence that the comparator can see a wire change.
 */
export function assertMutationSpecificDiff(_options: {
	differences: readonly DiffRef[];
	legOneRaw: readonly string[];
	legTwoRaw: readonly string[];
	marker: string;
}): number {
	// RED STAGE: guard not wired.
	return -1;
}
