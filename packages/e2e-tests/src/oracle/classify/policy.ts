/**
 * The unit-2 oracle leg's classification data: distinct mock model ids per
 * agent, per-agent mockRequestId queue prefixes, and the system-prompt marker
 * table for the leftover lane.
 *
 * Every marker is a plugin production literal: the plugin's own internal-agent
 * detectors (`hooks/magic-context/system-prompt-hash.ts` isInternalOpenCodeAgent /
 * isMagicContextInternalAgent, "Literal substrings (not fuzzy)") pin the host
 * title frame and the historian/dreamer identity frames; the dreamer list adds
 * the retrospective opener. The law file re-checks every marker against the
 * plugin production source — a presence-only text law: wholesale marker
 * removal reddens it; an edit that preserves the literal does not.
 */
import {
	buildClassifierPolicy,
	ORACLE_REQUEST_CLASSES,
	type ClassifierPolicy,
	type OracleRequestClass,
} from "./classifier";

/** class → registered mock model id (all on the same mock provider). */
export const ORACLE_MOCK_MODEL_IDS: Record<OracleRequestClass, string> = {
	main: "mock-sonnet",
	title: "mock-title",
	historian: "mock-historian",
	dreamer: "mock-dreamer",
	embedding: "mock-embed",
	"internal-completion": "mock-completion",
};

/** class → per-agent mockRequestId queue prefix. */
export const ORACLE_AGENT_QUEUE_PREFIXES: Record<OracleRequestClass, string> = {
	main: "main",
	title: "title",
	historian: "hist",
	dreamer: "dream",
	embedding: "embed",
	"internal-completion": "completion",
};

export const ORACLE_SYSTEM_PROMPT_MARKERS: Partial<
	Record<OracleRequestClass, readonly string[]>
> = {
	title: ["You are a title generator. You output ONLY a thread title."],
	historian: ["You are Historian — the hippocampus of a long-running coding agent."],
	dreamer: ["for the magic-context system", "for Magic Context"],
};

export function buildOracleClassifierPolicy(): ClassifierPolicy {
	const models: Record<string, OracleRequestClass> = {};
	const queues: Record<string, OracleRequestClass> = {};
	for (const cls of ORACLE_REQUEST_CLASSES) {
		models[ORACLE_MOCK_MODEL_IDS[cls]] = cls;
		queues[ORACLE_AGENT_QUEUE_PREFIXES[cls]] = cls;
	}
	return buildClassifierPolicy({ models, queues, markers: ORACLE_SYSTEM_PROMPT_MARKERS });
}

/** Classes whose internals the oracle legs disable (oc2-wire-dump.ts precedent). */
export const ORACLE_DISABLED_INTERNAL_CLASSES: readonly OracleRequestClass[] = [
	"historian",
	"dreamer",
	"embedding",
	"internal-completion",
];
