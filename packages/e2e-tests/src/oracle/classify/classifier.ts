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

export function buildClassifierPolicy(input: {
	models: Record<string, OracleRequestClass>;
	queues: Record<string, OracleRequestClass>;
	markers: Partial<Record<OracleRequestClass, readonly string[]>>;
}): ClassifierPolicy {
	return {
		models: { ...input.models },
		queues: { ...input.queues },
		markers: Object.fromEntries(
			Object.entries(input.markers).map(([cls, markers]) => [cls, [...markers]]),
		),
	};
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
	const named = modelClass ?? queueClass;
	if (named !== undefined) return named;
	const system = oracleSystemText(request.body.system);
	const markerHits = ORACLE_REQUEST_CLASSES.filter((cls) =>
		(policy.markers[cls] ?? []).some((marker) => system.includes(marker)),
	);
	if (markerHits.length === 1) return markerHits[0]!;
	// A request the lanes do not name falls into the main bucket.
	return "main";
}

/**
 * Per-class ordered request lists. Arrival order is preserved inside each
 * class: the compared artifact is the request SEQUENCE per class.
 */
export interface OracleClassSequences {
	readonly entries: Readonly<Record<OracleRequestClass, readonly ClassifiableRequest[]>>;
	readonly totalRequests: number;
}

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
	return { entries, totalRequests };
}
