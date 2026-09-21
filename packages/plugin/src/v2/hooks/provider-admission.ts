export interface ProviderAdmissionInput {
    /** Input + cached-read + cached-write tokens of the newest assistant reply. */
    inputTokens: number;
    /** The provider's own context window for the outgoing model, when the catalog knows it. */
    rawContextLimit: number | undefined;
    /** True when the host wrote a compaction after the reply the tokens were read from. */
    hostCompactionReducedUsage: boolean;
}

/** The share of the provider's own window at which a request is turned away. */
const REFUSAL_RATIO = 0.95;

/**
 * Whether the OpenCode 2 context hook must stop a request before it reaches the
 * provider.
 *
 * The provider's own context window is the only admission boundary here. Every
 * other kind of pressure — in particular usage that fits the window but not the
 * room reserved for the reply — has to be admitted, because the work that
 * relieves it (compacting history into a compartment, and the high-pressure
 * handling around it) all happens further down this same pass. A request stopped
 * here runs none of it, so a session refused for pressure Magic Context could
 * have removed is refused again on every following turn.
 */
export function refusesBeforeProvider(input: ProviderAdmissionInput): boolean {
    const { rawContextLimit } = input;
    if (
        typeof rawContextLimit !== "number" ||
        !Number.isFinite(rawContextLimit) ||
        rawContextLimit <= 0
    ) {
        return false;
    }
    // Past the window there is nothing left to protect, and the provider's
    // overflow error is the only place the real window is ever reported, so the
    // request goes out and the response hook reads it.
    if (input.inputTokens > rawContextLimit) return false;
    // The tokens under judgement belong to a reply that predates the host's
    // compaction, so they describe history that no longer exists. Send one
    // request rather than refuse on a reading that is known to be stale.
    if (input.hostCompactionReducedUsage) return false;
    return input.inputTokens / rawContextLimit >= REFUSAL_RATIO;
}
