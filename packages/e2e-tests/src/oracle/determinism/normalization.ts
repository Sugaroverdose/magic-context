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
 * RED STAGE (TDD): rule application is not wired in this commit. The committed
 * law reddens on the missing rewrite; the next commit wires it.
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
	// RED STAGE: rules are resolved (so a rogue name still throws) but not applied.
	void key;
	void rules;
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
