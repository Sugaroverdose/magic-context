/**
 * FPE cold-start boot-ride gate (state home; import-free leaf so the
 * transform phase -> fpe edge stays acyclic through hook.ts).
 *
 * A session is COLD from boot until its first PRESSURE-priced sweep mutation
 * in this process. A fresh process is cold by construction: every restart
 * re-arms, zero persisted state (the post-0.45 restart path fires no
 * persisted flags; `install_instance_id` is installation-scoped).
 *
 * The law: a restart gap expires the provider cache, so the boot pass rides
 * `ttl_idle` (idleExpiryRebuild) and drains the pre-restart drop backlog —
 * minting the freshest, most-attended carriers onto the thinnest wire at
 * t=0 (the measured start-burst flare class). While cold, the idle-expiry
 * ride is suppressed: the boot pass serves the byte-identical pre-restart
 * wire (LKG restore + deterministic replay of the applied drop rows — the
 * proven-working geometry), and the queued backlog stays queued. Pressure
 * always rides: scheduler-execute and the force/emergency band are never
 * gated, and a pressure-pass mutation ENGAGES the session (warm law from
 * then on; the takeover rides its own priced bust). Engagement on mutations
 * from non-pressure rides (e.g. a post-engage ttl ride) does not re-arm —
 * the Set is the only state, and engagement is monotone per process.
 *
 * The flag defaults ON; the plugin test-preload disables it process-wide
 * (fixtures expect drops applied on the first pass) and the law's own tests
 * re-enable it locally.
 */
type GlobalWithFpeDeferral = typeof globalThis & {
    __mcFpeCarriersDeferralEnabled?: boolean;
};

function deferralEnabled(): boolean {
    return (globalThis as GlobalWithFpeDeferral).__mcFpeCarriersDeferralEnabled !== false;
}

const carriersEngagedSessions = new Set<string>();

/** True from boot until this session's first pressure-priced sweep mutation. */
export function isFpeCarriersCold(sessionId: string): boolean {
    return deferralEnabled() && !carriersEngagedSessions.has(sessionId);
}

/** Marks the session warm: new drops take the carrier class. */
export function engageFpeCarriers(sessionId: string): void {
    carriersEngagedSessions.add(sessionId);
}

export function resetFpeCarriersEngagementForTests(): void {
    carriersEngagedSessions.clear();
}

export function setFpeCarriersDeferralEnabledForTests(enabled: boolean): void {
    (globalThis as GlobalWithFpeDeferral).__mcFpeCarriersDeferralEnabled = enabled;
}
