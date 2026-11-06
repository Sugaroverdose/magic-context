/**
 * Unit 1 of the differential rendering oracle
 * (docs/superpowers/plans/2026-11-06-differential-oracle.md): the determinism
 * self-test. One OC1 leg boots twice against the SAME seeded fixture store,
 * restored byte-identically between runs (store-reset contract, plan round-2
 * condition 1), and the captured mock-provider request bodies must be
 * byte-identical modulo the committed whitelist.
 *
 * The leg machinery (pinned host, the determinism wrapper from the
 * idle-ttl-restart.test.ts:876 plugin-wrapper pattern, the store-reset
 * snapshot/restore, quiescence and session-processed gates, R2 guards, and the
 * committed whitelist comparators) lives in the shared runner
 * (src/oracle/classify/leg-runner.ts) so unit 2's classified capture runs the
 * exact certified path. This file keeps the pass/instrument-control arms.
 *
 * Both arms are honesty evidence, not just assertions:
 * - the pass arm compares VERBATIM raw bytes first (N1), then canonicalized
 *   bytes; it refuses zero compared requests and requires the pinned date line
 *   inside the compared corpus (R2, certified inside the runner);
 * - the instrument-control arm plants a mutation in the second leg's second
 *   turn and requires the diff to involve that request (R3), so ambient
 *   nondeterminism can never green the control.
 */
import { describe, expect, it } from "bun:test";
import { ORACLE_MUTATION_MARKER, assertMutationSpecificDiff } from "../src/oracle/determinism/guards";
import {
	formatDiffs,
	runOracleLegPair,
} from "../src/oracle/classify/leg-runner";

const SELFTEST_TURN_TEXTS = ["first user turn", "second user turn"] as const;

describe("oracle unit 1: determinism self-test (OC1 leg, same store twice)", () => {
	it(
		"boots the OC1 leg twice over the restored seed and reproduces byte-identical provider request bodies",
		async () => {
			const result = await runOracleLegPair({
				label: "determinism self-test",
				turnTexts: SELFTEST_TURN_TEXTS,
			});
			expect(result.restore.restored).toBe(result.snapshotSize);
			if (result.comparedRequestCount === 0) {
				throw new Error(
					"oracle determinism: zero compared provider requests — an empty capture is not a passing determinism run",
				);
			}
			// N1: verbatim raw identity is a live assertion, not a discarded commit.
			if (result.rawDifferences.length > 0) {
				throw new Error(
					formatDiffs(
						result.rawDifferences,
						`oracle determinism RAW RED: ${result.rawDifferences.length} provider request bodies differ byte-for-byte between identical legs (before any whitelist)`,
					),
				);
			}
			if (result.canonicalDifferences.length > 0) {
				throw new Error(
					formatDiffs(
						result.canonicalDifferences,
						`oracle determinism CANONICAL RED: ${result.canonicalDifferences.length} provider request bodies differ after the committed whitelist`,
					),
				);
			}
			expect(result.rawDifferences).toEqual([]);
			expect(result.canonicalDifferences).toEqual([]);
		},
		420_000,
	);

	it(
		"instrument control: the mutation must produce a diff at or after the mutated request",
		async () => {
			const result = await runOracleLegPair({
				label: "determinism self-test (mutated)",
				turnTexts: SELFTEST_TURN_TEXTS,
				mutatedTurnIndex: 1,
			});
			// R3: keeps the dark-control throw, binds the diff to the mutated request,
			// and rejects ambient differences before it.
			const mutationIndex = assertMutationSpecificDiff({
				differences: result.canonicalDifferences,
				legOneRaw: result.legOneRaw,
				legTwoRaw: result.legTwoRaw,
				marker: ORACLE_MUTATION_MARKER,
			});
			// The live raw comparator must see the same mutation, not only the
			// canonical path (N1 sensitivity).
			const rawBound = result.rawDifferences.filter(
				(diff) => diff.requestIndex >= mutationIndex,
			);
			if (rawBound.length === 0) {
				throw new Error(
					`oracle determinism: the raw comparator saw no diff at or after the mutated request#${mutationIndex} — the control only moved canonicalized bytes`,
				);
			}
			expect(mutationIndex).toBeGreaterThanOrEqual(0);
		},
		420_000,
	);
});
