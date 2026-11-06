/**
 * Committed plants for the unit-2 request classifier and per-class sequence
 * comparator (ledger Class 6: a law is only as strong as its committed plant).
 * Each plant is a rogue fixture the mechanism must refuse; the mechanism going
 * absent reddens this file, not a later oracle run.
 *
 * Plants (red-first witnesses, plan unit 2 + brief):
 *  P1 unclassified — a request whose model matches none and whose system
 *     prompt carries no marker must throw, never silently bucket.
 *  P2 class-order swap — swapping two same-class requests' sequence positions
 *     reddens the compare, proving SEQUENCE is compared, not set.
 *  P3 class-count drop — deleting one title request from leg 2 reddens the
 *     per-class length assert.
 *  P4 disabled-class leak — a historian request on a historian-disabled leg
 *     reddens the per-class absence assert.
 * Plus: lane order (model → queue → marker), lane disagreement, policy
 * hygiene, comparator provenance (no request bypasses classification), and
 * raw-bytes-only comparison.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	buildClassifierPolicy,
	classifyOracleRequest,
	classifyOracleRequests,
	ORACLE_REQUEST_CLASSES,
	type ClassifiableRequest,
	type OracleClassSequences,
	type OracleRequestClass,
} from "./classifier";
import {
	assertDisabledClassesAbsent,
	compareOracleClassSequences,
} from "./compare";
import {
	ORACLE_AGENT_QUEUE_PREFIXES,
	ORACLE_MOCK_MODEL_IDS,
	ORACLE_SYSTEM_PROMPT_MARKERS,
	buildOracleClassifierPolicy,
} from "./policy";

const POLICY = buildOracleClassifierPolicy();

function req(
	model: string | undefined,
	rawBody: string,
	extra: { servedByQueue?: string; system?: unknown } = {},
): ClassifiableRequest {
	return {
		method: "POST",
		path: "/v1/messages",
		body: { ...(model === undefined ? {} : { model }), system: extra.system ?? [] },
		servedByQueue: extra.servedByQueue,
		rawBody,
	};
}

function body(text: string): string {
	return JSON.stringify({ model: "ignored", messages: [text] });
}

describe("oracle unit 2: request classifier plants", () => {
	it("P1 plant: a request no lane names throws as unclassified, never a silent bucket", () => {
		const rogue = req("mock-rogue-unregistered", body("plain system, no marker anywhere"), {
			system: [{ type: "text", text: "plain system, no marker anywhere" }],
		});
		expect(() => classifyOracleRequest(rogue, POLICY)).toThrow(/unclassified/);
		expect(() => classifyOracleRequests([rogue], POLICY)).toThrow(/unclassified/);
		// Control: the same bytes with a named model classify cleanly.
		expect(
			classifyOracleRequest(req("mock-sonnet", body("x"), { system: "x" }), POLICY),
		).toBe("main");
	});

	it("lane order: body model first, queue prefix second, system marker third — every lane live", () => {
		// Model lane.
		expect(classifyOracleRequest(req(ORACLE_MOCK_MODEL_IDS.main, body("m")), POLICY)).toBe(
			"main",
		);
		// Queue lane: an unregistered model is named by its serving queue prefix.
		expect(
			classifyOracleRequest(
				req("mock-collapsed", body("h"), { servedByQueue: ORACLE_AGENT_QUEUE_PREFIXES.historian }),
				POLICY,
			),
		).toBe("historian");
		// Marker lane: unregistered model and queue, historian identity frame in system.
		expect(
			classifyOracleRequest(
				req(
					"mock-collapsed",
					body("hist"),
					{
						system: [
							{ type: "text", text: "You are Historian — the hippocampus of a long-running coding agent." },
						],
					},
				),
				POLICY,
			),
		).toBe("historian");
		// Model beats marker: a main-model request carrying the title marker is still main.
		expect(
			classifyOracleRequest(
				req(ORACLE_MOCK_MODEL_IDS.main, body("t"), {
					system: "You are a title generator. You output ONLY a thread title.",
				}),
				POLICY,
			),
		).toBe("main");
	});

	it("plant: model lane and queue lane disagree — two provenances cannot both be right", () => {
		expect(() =>
			classifyOracleRequest(
				req(ORACLE_MOCK_MODEL_IDS.main, body("x"), {
					servedByQueue: ORACLE_AGENT_QUEUE_PREFIXES.historian,
				}),
				POLICY,
			),
		).toThrow(/ambigu/);
	});

	it("plant: two class markers in one system prompt is ambiguity, not first-match", () => {
		expect(() =>
			classifyOracleRequest(
				req("mock-collapsed", body("both"), {
					system:
						"You are a title generator. You output ONLY a thread title. " +
						"You are Historian — the hippocampus of a long-running coding agent.",
				}),
				POLICY,
			),
		).toThrow(/ambigu/);
	});

	it("policy hygiene: off-vocabulary classes and empty markers redden at build time", () => {
		expect(() =>
			buildClassifierPolicy({
				models: { "mock-x": "mainn" as OracleRequestClass },
				queues: {},
				markers: {},
			}),
		).toThrow(/policy/i);
		expect(() =>
			buildClassifierPolicy({ models: {}, queues: { "": "main" }, markers: {} }),
		).toThrow(/policy/i);
		expect(() =>
			buildClassifierPolicy({ models: {}, queues: {}, markers: { historian: ["  "] } }),
		).toThrow(/policy/i);
		// Control: the committed production policy builds.
		expect(() => buildOracleClassifierPolicy()).not.toThrow();
	});

	it("N3 non-vacuity: every vocabulary class is classifiable through the classifier", () => {
		const completions = buildClassifierPolicy({
			models: {},
			queues: {},
			markers: { "internal-completion": ["standalone completion identity"] },
		});
		for (const cls of ORACLE_REQUEST_CLASSES) {
			if (cls === "internal-completion") {
				expect(
					classifyOracleRequest(
						req("mock-collapsed", body("c"), {
							system: "standalone completion identity",
						}),
						completions,
					),
				).toBe("internal-completion");
				continue;
			}
			expect(
				classifyOracleRequest(req(ORACLE_MOCK_MODEL_IDS[cls], body(cls)), POLICY),
			).toBe(cls);
			expect(
				classifyOracleRequest(
					req("mock-collapsed", body(cls), {
						servedByQueue: ORACLE_AGENT_QUEUE_PREFIXES[cls],
					}),
					POLICY,
				),
			).toBe(cls);
		}
	});

	it("marker truth: historian/dreamer markers exist in plugin production source; the title marker is host-side", () => {
		const pluginSrc = resolve(import.meta.dir, "../../../../plugin/src");
		const productionText = (() => {
			let text = "";
			const walk = (dir: string): void => {
				for (const entry of readdirSync(dir, { withFileTypes: true })) {
					const path = join(dir, entry.name);
					if (entry.isDirectory()) walk(path);
					else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts"))
						text += readFileSync(path, "utf8");
				}
			};
			walk(pluginSrc);
			return text;
		})();
		// Exact guarantee: every committed marker is still PRESENT SOMEWHERE in
		// the concatenated plugin production source. Wholesale removal of a marker
		// trips this law; relocation of a marker between plugin producer files does
		// NOT (the mechanism is `productionText.includes(marker)` over the whole
		// tree — the title frame occurs in ~10 prompt files, so producer identity
		// is deliberately not pinned here). The live-capture classification
		// (oracle-classified-capture.test.ts) is the tripwire for what this text
		// law cannot see: a marker that survives in an inert string while the real
		// prompt stops carrying it.
		for (const cls of ["title", "historian", "dreamer"] as const) {
			const markers = ORACLE_SYSTEM_PROMPT_MARKERS[cls] ?? [];
			expect(markers.length).toBeGreaterThan(0);
			for (const marker of markers) {
				expect(productionText.includes(marker)).toBe(true);
			}
		}
	});
});

describe("oracle unit 2: per-class sequence comparator plants", () => {
	const mainA = req(ORACLE_MOCK_MODEL_IDS.main, '{"model":"mock-sonnet","messages":["A"]}');
	const mainB = req(ORACLE_MOCK_MODEL_IDS.main, '{"model":"mock-sonnet","messages":["B"]}');
	const titleOne = req(ORACLE_MOCK_MODEL_IDS.title, '{"model":"mock-title","messages":["T1"]}');
	const titleTwo = req(ORACLE_MOCK_MODEL_IDS.title, '{"model":"mock-title","messages":["T2"]}');

	function seq(requests: readonly ClassifiableRequest[]): OracleClassSequences {
		return classifyOracleRequests(requests, POLICY);
	}

	it("P2 plant: swapping two same-class requests reddens the compare (SEQUENCE, not SET)", () => {
		const legOne = seq([mainA, mainB, titleOne]);
		// Same multiset per class — only the main order is swapped.
		const legTwo = seq([mainB, mainA, titleOne]);
		const report = compareOracleClassSequences(legOne, legTwo);
		expect(report.firstDivergence).not.toBeNull();
		expect(report.firstDivergence!.class).toBe("main");
		expect(report.firstDivergence!.index).toBe(0);
		expect(report.firstDivergence!.kind).toBe("bytes");
		expect(typeof report.firstDivergence!.firstDiffByte).toBe("number");
		const mainRow = report.perClass.find((row) => row.class === "main")!;
		// Set-level equality held (same counts): the RED is order alone.
		expect(mainRow.legOne).toBe(2);
		expect(mainRow.legTwo).toBe(2);
	});

	it("P3 plant: dropping one title request reddens the per-class length assert", () => {
		const legOne = seq([mainA, titleOne, titleTwo]);
		const legTwo = seq([mainA, titleOne]);
		const report = compareOracleClassSequences(legOne, legTwo);
		const titleRow = report.perClass.find((row) => row.class === "title")!;
		expect(titleRow.divergence).not.toBeNull();
		expect(titleRow.divergence!.class).toBe("title");
		expect(titleRow.divergence!.kind).toBe("count");
		expect(titleRow.divergence!.index).toBe(1);
		expect(report.firstDivergence).not.toBeNull();
	});

	it("control: identical legs produce zero divergence over the full class vocabulary", () => {
		const legOne = seq([mainA, titleOne]);
		const legTwo = seq([mainA, titleOne]);
		const report = compareOracleClassSequences(legOne, legTwo);
		expect(report.firstDivergence).toBeNull();
		expect(report.perClass.map((row) => row.class)).toEqual([...ORACLE_REQUEST_CLASSES]);
		for (const row of report.perClass) {
			expect(row.divergence).toBeNull();
		}
		expect(report.totalCompared).toBe(2);
		// Disabled classes ride the report as compared zero-facts, not silence.
		const historianRow = report.perClass.find((row) => row.class === "historian")!;
		expect(historianRow.legOne).toBe(0);
		expect(historianRow.legTwo).toBe(0);
	});

	it("control: a byte difference reports the (class, index, byte) triple", () => {
		const mutated = req(ORACLE_MOCK_MODEL_IDS.main, '{"model":"mock-sonnet","messages":["A!"]}');
		const report = compareOracleClassSequences(seq([mainA]), seq([mutated]));
		expect(report.firstDivergence).not.toBeNull();
		expect(report.firstDivergence!.class).toBe("main");
		expect(report.firstDivergence!.index).toBe(0);
		expect(report.firstDivergence!.kind).toBe("bytes");
		expect(report.firstDivergence!.firstDiffByte).toBe(
			'{"model":"mock-sonnet","messages":["A!"]'.indexOf("!"),
		);
	});

	it("P4 plant: a historian request on a historian-disabled leg reddens the absence assert", () => {
		const leak = seq([mainA, titleOne]);
		const historian = req(
			ORACLE_MOCK_MODEL_IDS.historian,
			'{"model":"mock-historian","messages":["summary"]}',
		);
		const leaking = seq([mainA, historian, titleOne]);
		expect(() =>
			assertDisabledClassesAbsent(leaking, leak, ["historian", "dreamer", "embedding"]),
		).toThrow(/historian/);
		expect(() =>
			assertDisabledClassesAbsent(leak, leaking, ["historian", "dreamer", "embedding"]),
		).toThrow(/historian/);
		// Clean legs pass — absence on both legs is the passing fact.
		expect(() =>
			assertDisabledClassesAbsent(leak, leak, ["historian", "dreamer", "embedding"]),
		).not.toThrow();
	});

	it("no-bypass law: the comparator only consumes classifier output", () => {
		const forged = {
			entries: Object.fromEntries(ORACLE_REQUEST_CLASSES.map((cls) => [cls, []])),
			totalRequests: 0,
		} as unknown as OracleClassSequences;
		expect(() => compareOracleClassSequences(forged, forged)).toThrow(/classif/i);
		expect(() => assertDisabledClassesAbsent(forged, forged, ["historian"])).toThrow(
			/classif/i,
		);
	});

	it("raw bytes are the compared artifact: a classified request without rawBody is refused", () => {
		const noRaw: ClassifiableRequest = {
			method: "POST",
			path: "/v1/messages",
			body: { model: ORACLE_MOCK_MODEL_IDS.main },
		};
		expect(() => compareOracleClassSequences(seq([noRaw]), seq([mainA]))).toThrow(
			/no rawBody/,
		);
	});
});
