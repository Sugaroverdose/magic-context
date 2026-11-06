/**
 * The oracle whitelist: named, committed, evidence-backed rules the wire
 * comparator may normalize. LEDGER CLASS 1 GUARD — a rule without a named
 * producer and reason, or a rule added silently (referenced by name anywhere
 * without a table entry), makes the oracle comparator a lying instrument; the
 * canonicalization refuses it instead.
 *
 * The table starts EMPTY by evidence: the unit-1 OC1 leg carries no id/timestamp
 * tokens in request bodies (evidence: the unmutated two-boot raw run plus the
 * committed instrument control; id-shaped tokens in bodies are only the constant
 * max_tokens). Rules are added ONLY when a later unit observes a nondeterminism
 * producer on the wire, with the producer named here.
 *
 * ORACLE-UNPATCHED-SURFACES — recorded obligations (N2).
 *
 * The determinism wrapper patches Date.now, Math.random and the served
 * "Today's date" line, and pins TZ through the child env, but it does NOT patch:
 * - crypto.randomUUID: any producer that puts a UUID on the wire will differ
 *   between boots. The unit-1 OC1 leg never does (evidence below).
 * - cwd: the leg shares one isolated cwd across boots by construction (shared
 *   env), so cwd-derived bytes are identical without a patch. A leg that runs in
 *   different directories MUST patch or normalize cwd.
 *
 * OC1 evidence: the two-boot raw run (verbatim rawBody, no whitelist) is
 * byte-identical on this leg, and the committed instrument control proves the
 * comparator sees a wire change. That observation is the evidence, not an
 * assumption that OC1 is deterministic.
 *
 * Forward obligation: OC2 and OpenAI Responses legs carry provider-assigned
 * ids/request ids. Each such leg requires a named whitelist rule or patch
 * (producer + reason in ORACLE_WIRE_WHITELIST) before it may run against this
 * comparator. Adding a rule silently is exactly what this file refuses.
 */

export interface WhitelistRule {
	/** The rule's canonical name — the only handle call sites may use. */
	name: string;
	/** Which mechanism emits the varying bytes (file: symbol or provider), not "it varies". */
	producer: string;
	/** Why normalizing it cannot hide a real rendering-path delta. */
	reason: string;
	/** Whether the rule applies to a scalar value laid at `key` inside its enclosing object (null key = array element). */
	applies: (key: string | null, value: unknown) => boolean;
}

export const ORACLE_WIRE_WHITELIST: readonly WhitelistRule[] = [];

const LAW_TEXT =
	"oracle-whitelist-law: whitelist rules are committed data with a named producer and reason; an unknown rule reddens the run";

export function getWhitelistRule(name: string): WhitelistRule {
	const rule = ORACLE_WIRE_WHITELIST.find((entry) => entry.name === name);
	if (!rule) {
		throw new Error(`${LAW_TEXT} — unknown rule name: ${JSON.stringify(name)}`);
	}
	return rule;
}

/** The only whitelist a compare site may pass: exactly the committed names. */
export function committedWhitelistNames(): readonly string[] {
	return ORACLE_WIRE_WHITELIST.map((rule) => rule.name);
}

/**
 * Canonicalize a captured provider request body: parse, apply ONLY whitelist
 * rules resolved from the committed table, keep object key order (wire byte
 * layout matters for the cache), deterministically serialize. Unknown rule names
 * ALWAYS throw — a silent whitelist addition reddens on sight.
 */
export function canonicalizeProviderBody(raw: string, ruleNames: readonly string[]): string {
	const rules = ruleNames.map(getWhitelistRule);
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`oracle canonicalization: provider request body is not JSON: ${String(error)}`);
	}
	return JSON.stringify(normalizeValue(null, parsed, rules));
}

function normalizeValue(key: string | null, value: unknown, rules: readonly WhitelistRule[]): unknown {
	for (const rule of rules) {
		if (rule.applies(key, value)) return `<rule:${rule.name}>`;
	}
	if (Array.isArray(value)) return value.map((entry) => normalizeValue(null, entry, rules));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
				childKey,
				normalizeValue(childKey, child, rules),
			]),
		);
	}
	return value;
}

export function firstDiffByte(left: string, right: string): number | null {
	const limit = Math.min(left.length, right.length);
	for (let index = 0; index < limit; index += 1) {
		if (left[index] !== right[index]) return index;
	}
	return left.length === right.length ? null : limit;
}

export function byteContext(value: string, index: number): string {
	const start = Math.max(0, index - 160);
	const end = Math.min(value.length, index + 160);
	return value.slice(start, end);
}
