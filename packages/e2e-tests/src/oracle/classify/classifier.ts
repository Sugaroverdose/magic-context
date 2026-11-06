/**
 * Unit 2 of the differential rendering oracle
 * (docs/superpowers/plans/2026-11-06-differential-oracle.md): the request
 * classifier. Every captured mock-provider request must be assigned to exactly
 * one class — main | title | historian | dreamer | embedding |
 * internal-completion. Mechanism per the plan's Capture design: the runner
 * names distinct mock model ids per agent, scripts each agent's responses under
 * a per-agent mockRequestId prefix, and the classifier tags by body `model`
 * first, queue prefix second, system-prompt marker third. An UNCLASSIFIED
 * request is red — never a bucket.
 */

export const ORACLE_REQUEST_CLASSES = [
	"main",
	"title",
	"historian",
	"dreamer",
	"embedding",
	"internal-completion",
] as const;

export type OracleRequestClass = (typeof ORACLE_REQUEST_CLASSES)[number];

/** Structural subset of the mock provider's CapturedRequest that classification reads. */
export interface ClassifiableRequest {
	method: string;
	path: string;
	body: { model?: unknown; system?: unknown; [k: string]: unknown };
	/** Per-agent mockRequestId queue that served this request, recorded by the mock. */
	servedByQueue?: string;
	/** Verbatim provider request bytes; the only thing the comparator may compare. */
	rawBody?: string;
}

export interface ClassifierPolicy {
	/** body.model → class (first lane). */
	readonly models: Readonly<Record<string, OracleRequestClass>>;
	/** per-agent mockRequestId queue prefix → class (second lane). */
	readonly queues: Readonly<Record<string, OracleRequestClass>>;
	/** class → system-prompt substrings (third lane, leftovers only). */
	readonly markers: Readonly<Partial<Record<OracleRequestClass, readonly string[]>>>;
}

const CLASS_SET: ReadonlySet<string> = new Set<string>(ORACLE_REQUEST_CLASSES);

function requirePolicyClass(value: string, where: string): OracleRequestClass {
	if (!CLASS_SET.has(value)) {
		throw new Error(
			`oracle unit 2 classifier policy: ${where} names "${value}", outside the committed vocabulary [${ORACLE_REQUEST_CLASSES.join(", ")}]`,
		);
	}
	return value as OracleRequestClass;
}

/**
 * A policy is admitted only if every lane names a vocabulary class with a
 * non-empty signal: an off-vocabulary class or an empty marker is a typo that
 * would silently disable a lane, so it reddens at build time, not on the wire.
 */
export function buildClassifierPolicy(input: {
	models: Record<string, OracleRequestClass>;
	queues: Record<string, OracleRequestClass>;
	markers: Partial<Record<OracleRequestClass, readonly string[]>>;
}): ClassifierPolicy {
	const models: Record<string, OracleRequestClass> = {};
	for (const [model, cls] of Object.entries(input.models)) {
		if (model.trim().length === 0)
			throw new Error("oracle unit 2 classifier policy: empty model id in models lane");
		models[model] = requirePolicyClass(cls, `models["${model}"]`);
	}
	const queues: Record<string, OracleRequestClass> = {};
	for (const [prefix, cls] of Object.entries(input.queues)) {
		if (prefix.trim().length === 0)
			throw new Error("oracle unit 2 classifier policy: empty queue prefix in queues lane");
		queues[prefix] = requirePolicyClass(cls, `queues["${prefix}"]`);
	}
	const markers: Partial<Record<OracleRequestClass, readonly string[]>> = {};
	for (const [cls, list] of Object.entries(input.markers)) {
		const valid = requirePolicyClass(cls, `markers key`);
		if (list.length === 0)
			throw new Error(
				`oracle unit 2 classifier policy: class "${valid}" declares an empty markers list`,
			);
		for (const marker of list) {
			if (marker.trim().length === 0)
				throw new Error(
					`oracle unit 2 classifier policy: class "${valid}" declares an empty marker`,
				);
		}
		markers[valid] = [...list];
	}
	return { models, queues, markers };
}

/** Flatten the Anthropic `system` field (string or block array) into marker-scan text. */
export function oracleSystemText(system: unknown): string {
	if (typeof system === "string") return system;
	if (Array.isArray(system)) {
		return system
			.map((block) => {
				if (typeof block === "string") return block;
				if (block && typeof block === "object") {
					const text = (block as { text?: unknown }).text;
					return typeof text === "string" ? text : "";
				}
				return "";
			})
			.join("\n");
	}
	return "";
}

export function classifyOracleRequest(
	request: ClassifiableRequest,
	policy: ClassifierPolicy,
): OracleRequestClass {
	const model = typeof request.body.model === "string" ? request.body.model : undefined;
	const modelClass = model !== undefined ? policy.models[model] : undefined;
	const queueClass =
		request.servedByQueue !== undefined ? policy.queues[request.servedByQueue] : undefined;
	if (modelClass !== undefined && queueClass !== undefined && modelClass !== queueClass) {
		throw new Error(
			`oracle unit 2: ambiguous provider request — body model ${JSON.stringify(model)} names ` +
				`class "${modelClass}" while serving queue ${JSON.stringify(request.servedByQueue)} ` +
				`names class "${queueClass}"; two provenances cannot both be right`,
		);
	}
	const named = modelClass ?? queueClass;
	if (named !== undefined) return named;
	const system = oracleSystemText(request.body.system);
	const markerHits = ORACLE_REQUEST_CLASSES.filter((cls) =>
		(policy.markers[cls] ?? []).some((marker) => system.includes(marker)),
	);
	if (markerHits.length === 1) return markerHits[0]!;
	if (markerHits.length > 1) {
		throw new Error(
			`oracle unit 2: ambiguous provider request — system prompt carries markers for ` +
				`${markerHits.map((cls) => `"${cls}"`).join(", ")}; first-match would guess`,
		);
	}
	throw new Error(
		`oracle unit 2: unclassified provider request (${request.method} ${request.path}) — ` +
			`body model ${JSON.stringify(model ?? null)}, queue ${JSON.stringify(request.servedByQueue ?? null)}, ` +
			`no system-prompt marker; an unclassified request is red, never a bucket`,
	);
}

/**
 * Per-class ordered request lists. Arrival order is preserved inside each
 * class: the compared artifact is the request SEQUENCE per class.
 */
export interface OracleClassSequences {
	readonly entries: Readonly<Record<OracleRequestClass, readonly ClassifiableRequest[]>>;
	readonly totalRequests: number;
}

/**
 * Provenance: only classifyOracleRequests may mint OracleClassSequences. The
 * comparator demands membership, so a hand-built sequence — the code path that
 * would skip classification — is refused structurally, not by convention.
 */
const CLASSIFIED_SEQUENCES = new WeakSet<object>();

export function classifyOracleRequests(
	requests: readonly ClassifiableRequest[],
	policy: ClassifierPolicy,
): OracleClassSequences {
	const entries = {} as Record<OracleRequestClass, ClassifiableRequest[]>;
	for (const cls of ORACLE_REQUEST_CLASSES) entries[cls] = [];
	let totalRequests = 0;
	for (const request of requests) {
		entries[classifyOracleRequest(request, policy)].push(request);
		totalRequests += 1;
	}
	const sequences: OracleClassSequences = { entries, totalRequests };
	CLASSIFIED_SEQUENCES.add(sequences);
	return sequences;
}

/** Throw unless `value` is the classifier's own output (bypass refused). */
export function requireOracleClassSequences(value: unknown, site: string): OracleClassSequences {
	if (!CLASSIFIED_SEQUENCES.has(value as object)) {
		throw new Error(
			`oracle unit 2: ${site} refuses a hand-built sequence — every compared request must come ` +
				`through classifyOracleRequests; a path that skips the classifier is red`,
		);
	}
	return value as OracleClassSequences;
}
