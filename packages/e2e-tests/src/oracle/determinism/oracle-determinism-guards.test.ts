import { describe, expect, it } from "bun:test";
import {
	ORACLE_MUTATION_MARKER,
	assertMutationSpecificDiff,
	assertNonVacuousComparedCorpus,
	bindMutationToCorpus,
	rawBodyOf,
} from "./guards";

/**
 * Committed plants for the determinism self-test's honesty guards (R2, R3, N1).
 * Ledger Class 6: a law is only as strong as its committed plant. Each case below
 * is a rogue fixture that the guard must refuse; the guard going absent reddens
 * this file, not the oracle run that depends on it.
 */
const PINNED_LINE = "Today's date: Mon Sep 01 2025";

describe("oracle determinism guards", () => {
	it("R2 plant: zero compared requests reddens the pass arm", () => {
		expect(() =>
			assertNonVacuousComparedCorpus({ legOneRaw: [], legTwoRaw: [], pinnedLine: PINNED_LINE }),
		).toThrow(/zero compared provider requests/);
		expect(() =>
			assertNonVacuousComparedCorpus({
				legOneRaw: [`system ${PINNED_LINE}`],
				legTwoRaw: [],
				pinnedLine: PINNED_LINE,
			}),
		).toThrow(/zero compared provider requests/);
	});

	it("R2 plant: a corpus without the pinned date line reddens the pass arm", () => {
		expect(() =>
			assertNonVacuousComparedCorpus({
				legOneRaw: ["body with no date line"],
				legTwoRaw: ["body with no date line"],
				pinnedLine: PINNED_LINE,
			}),
		).toThrow(/pinned date line/);
		// One leg is not enough: the line must appear in BOTH compared corpora.
		expect(() =>
			assertNonVacuousComparedCorpus({
				legOneRaw: [`system ${PINNED_LINE}`],
				legTwoRaw: ["body with no date line"],
				pinnedLine: PINNED_LINE,
			}),
		).toThrow(/pinned date line/);
	});

	it("R2 control: a non-empty corpus carrying the pinned line passes", () => {
		expect(() =>
			assertNonVacuousComparedCorpus({
				legOneRaw: [`system ${PINNED_LINE}`, "second user turn"],
				legTwoRaw: [`system ${PINNED_LINE}`, "second user turn"],
				pinnedLine: PINNED_LINE,
			}),
		).not.toThrow();
	});

	it("R3 plant: no diff at all keeps the dark-control throw", () => {
		const legOneRaw = ["first", "second user turn"];
		const legTwoRaw = ["first", `second user turn ${ORACLE_MUTATION_MARKER}`];
		expect(() =>
			assertMutationSpecificDiff({
				differences: [],
				legOneRaw,
				legTwoRaw,
				marker: ORACLE_MUTATION_MARKER,
			}),
		).toThrow(/sensitivity control went dark/);
	});

	it("R3 plant: a diff confined to before the mutated request does not green the control", () => {
		const legOneRaw = ["ambient A", "ambient B", "second user turn"];
		const legTwoRaw = ["ambient A changed", "ambient B", `second user turn ${ORACLE_MUTATION_MARKER}`];
		// Ambient nondeterminism at request 0 only: the mutated request (2) is intact
		// as a diff location, so this cannot be mutation evidence.
		expect(() =>
			assertMutationSpecificDiff({
				differences: [{ requestIndex: 0 }],
				legOneRaw,
				legTwoRaw,
				marker: ORACLE_MUTATION_MARKER,
			}),
		).toThrow(/ambient nondeterminism/);
	});

	it("R3 control: a diff at or after the mutated request is accepted", () => {
		const legOneRaw = ["first", "second user turn"];
		const legTwoRaw = ["first", `second user turn ${ORACLE_MUTATION_MARKER}`];
		const bound = assertMutationSpecificDiff({
			differences: [{ requestIndex: 1 }],
			legOneRaw,
			legTwoRaw,
			marker: ORACLE_MUTATION_MARKER,
		});
		expect(bound).toBe(1);
	});

	it("R3 plant: a missing mutation marker reddens the control as dark", () => {
		expect(() =>
			bindMutationToCorpus({
				legOneRaw: ["first", "second user turn"],
				legTwoRaw: ["first", "second user turn"],
				marker: ORACLE_MUTATION_MARKER,
			}),
		).toThrow(/mutation marker/);
	});

	it("N1 plant: an absent raw body is refused, never re-serialized from parsed JSON", () => {
		expect(() => rawBodyOf({ method: "POST", path: "/messages" })).toThrow(/no rawBody/);
		expect(() => rawBodyOf({ method: "POST", path: "/messages", rawBody: "" })).toThrow(/no rawBody/);
		expect(rawBodyOf({ method: "POST", path: "/messages", rawBody: '{"model":"mock-sonnet"}' })).toBe(
			'{"model":"mock-sonnet"}',
		);
	});
});
