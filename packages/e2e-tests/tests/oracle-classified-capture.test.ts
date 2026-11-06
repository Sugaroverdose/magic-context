/**
 * Unit 2 live leg (docs/superpowers/plans/2026-11-06-differential-oracle.md):
 * the classified capture. Boots the certified unit-1b leg pair with every
 * agent class on its own mock model and per-agent scripted queue, classifies
 * every captured provider request into the committed class vocabulary
 * (unclassified is red — classification throws before any compare), and
 * compares the request SEQUENCE per class across the two boots. The
 * internals-disabled classes must be proven ABSENT per class on both legs,
 * never by ignoring them.
 */
import { describe, expect, it } from "bun:test";
import { LOW_USAGE, runOracleLegPair } from "../src/oracle/classify/leg-runner";
import {
	classifyOracleRequests,
	ORACLE_REQUEST_CLASSES,
	type OracleRequestClass,
} from "../src/oracle/classify/classifier";
import {
	assertDisabledClassesAbsent,
	compareOracleClassSequences,
} from "../src/oracle/classify/compare";
import {
	ORACLE_AGENT_QUEUE_PREFIXES,
	ORACLE_DISABLED_INTERNAL_CLASSES,
	ORACLE_MOCK_MODEL_IDS,
	buildOracleClassifierPolicy,
} from "../src/oracle/classify/policy";

const LEG_TURN_TEXTS = ["first user turn", "second user turn"] as const;

describe("oracle unit 2: classified live capture (OC1 legs)", () => {
	it(
		"classifies every captured request and reproduces byte-identical per-class sequences across boots",
		async () => {
			const result = await runOracleLegPair({
				label: "classified capture",
				turnTexts: LEG_TURN_TEXTS,
				spawnTuning: {
					extraMockModels: ORACLE_REQUEST_CLASSES.filter(
						(cls) => cls !== "main",
					).map((cls) => ({ id: ORACLE_MOCK_MODEL_IDS[cls] })),
					smallModelID: ORACLE_MOCK_MODEL_IDS.title,
					mockAgentModels: {
						historian: ORACLE_MOCK_MODEL_IDS.historian,
						dreamer: ORACLE_MOCK_MODEL_IDS.dreamer,
					},
				},
				script: (mock) => {
					// Every class gets a scripted queue — including the disabled ones,
					// whose responses must never be consumed: a disabled class that
					// still fires is attributed and reddened, not dropped.
					mock.scriptAgentQueues([
						{
							prefix: ORACLE_AGENT_QUEUE_PREFIXES.main,
							model: ORACLE_MOCK_MODEL_IDS.main,
							responses: [
								{ text: "classified leg reply", usage: LOW_USAGE },
								{ text: "classified leg reply", usage: LOW_USAGE },
							],
						},
						{
							prefix: ORACLE_AGENT_QUEUE_PREFIXES.title,
							model: ORACLE_MOCK_MODEL_IDS.title,
							responses: [{ text: "Classified oracle session", usage: LOW_USAGE }],
						},
						{
							prefix: ORACLE_AGENT_QUEUE_PREFIXES.historian,
							model: ORACLE_MOCK_MODEL_IDS.historian,
							responses: [{ text: "historian must not fire", usage: LOW_USAGE }],
						},
						{
							prefix: ORACLE_AGENT_QUEUE_PREFIXES.dreamer,
							model: ORACLE_MOCK_MODEL_IDS.dreamer,
							responses: [{ text: "dreamer must not fire", usage: LOW_USAGE }],
						},
						{
							prefix: ORACLE_AGENT_QUEUE_PREFIXES.embedding,
							model: ORACLE_MOCK_MODEL_IDS.embedding,
							responses: [{ text: "embedding must not fire", usage: LOW_USAGE }],
						},
						{
							prefix: ORACLE_AGENT_QUEUE_PREFIXES["internal-completion"],
							model: ORACLE_MOCK_MODEL_IDS["internal-completion"],
							responses: [{ text: "completion must not fire", usage: LOW_USAGE }],
						},
					]);
				},
			});

			const policy = buildOracleClassifierPolicy();
			// P1 rides the live wire: any request no lane names throws here.
			const legOne = classifyOracleRequests(result.legOne, policy);
			const legTwo = classifyOracleRequests(result.legTwo, policy);

			// The compared artifact: per-class request sequences across boots.
			const report = compareOracleClassSequences(legOne, legTwo);
			expect(report.firstDivergence).toBeNull();
			expect(report.perClass.map((row) => row.class)).toEqual([...ORACLE_REQUEST_CLASSES]);
			expect(report.totalCompared).toBe(3);

			// Exact per-class facts (deterministic legs): two prompts → two main
			// requests; host title generation fires once per boot on small_model.
			const expected: Record<OracleRequestClass, number> = {
				main: 2,
				title: 1,
				historian: 0,
				dreamer: 0,
				embedding: 0,
				"internal-completion": 0,
			};
			for (const cls of ORACLE_REQUEST_CLASSES) {
				expect(legOne.entries[cls].length, `leg 1 ${cls}`).toBe(expected[cls]);
				expect(legTwo.entries[cls].length, `leg 2 ${cls}`).toBe(expected[cls]);
			}

			// Queue attribution is the live witness that the classifier's queue lane
			// is populated on the wire, not just unit-testable.
			expect(legOne.entries.main.map((request) => request.servedByQueue)).toEqual([
				"main",
				"main",
			]);
			expect(legOne.entries.title.map((request) => request.servedByQueue)).toEqual(["title"]);

			// Disabled-class absence asserted per class and per leg (never silence).
			assertDisabledClassesAbsent(legOne, legTwo, ORACLE_DISABLED_INTERNAL_CLASSES);
		},
		420_000,
	);
});
