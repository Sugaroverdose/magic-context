/**
 * Restore-only boot pass (import-free leaf; state-free by design).
 *
 * Port of the rust lane's first-pass contract (crates/mc-module): absent
 * usage resolves against the scheduler's own geometry without any wire
 * estimate (`usage_numbers`), and the first restart pass must retain the
 * byte-identical served fingerprint (pinned lib.rs law). In the TS lane the
 * detector is the same signal the sizing bug taught us: a pass that entered
 * this process without provider usage (`contextUsage.inputTokens <= 0`
 * before the session_meta seed — fix 10a2de631) IS the boot pass. The
 * in-memory usage map is the process epoch, so every restart re-arms by
 * construction: no session-scoped state, no engagement marker.
 *
 * The law: a pass that entered with unknown provider usage may not mutate
 * the served wire. Idle expiry is true by construction at boot and the
 * host's post-restart replay raises a materialization flush — both are boot
 * artifacts, not reclaim permission. The boot pass serves the byte-identical
 * LKG restore; the queued backlog stays queued; the flush request parks (its
 * drain lives behind materialization success, so parking never loses it).
 *
 * Admission, not a freeze: the pass sizes itself from the persisted provider
 * record first, and when THAT reading prices a byte crisis
 * (`emergencyDropEligible` — the force/emergency band) the pass mutates like
 * any warm one — a session genuinely at or over the band owes its work even
 * at boot. `schedulerDecision === "execute"` is deliberately NOT admission:
 * the census shows healthy sessions booting `dec=execute reason=ttl_idle`,
 * and boot execute is exactly the reading this law distrusts. Explicit user
 * flushes and published history are never gated (separate signals).
 *
 * Discharge, not parking: the restore serves the persisted bytes — m[0]
 * included — so a re-anchor request raised by the host's post-restart replay
 * is moot on the restore-only pass and is CLEARED there. A parked request
 * would ride a later bust and rewrite bytes the restore already made
 * identical. Warm starvation drains (a queued drop landing on the next
 * genuine bust — marker change, explicit user flush) are a separate,
 * deliberate design and stay untouched: this law removes boot artifacts
 * from the permission set, not busts from the drain rules.
 *
 * The flag defaults ON; the plugin test-preload disables it process-wide
 * (fixtures expect drops applied on the first pass) and the law's own tests
 * re-enable it locally.
 */
type GlobalWithRestoreOnlyBootPass = typeof globalThis & {
    __mcRestoreOnlyBootPassEnabled?: boolean;
};

function lawEnabled(): boolean {
    return (globalThis as GlobalWithRestoreOnlyBootPass).__mcRestoreOnlyBootPassEnabled !== false;
}

export function isRestoreOnlyBootPass(input: {
    usageUnknownAtPassStart: boolean;
    emergencyDropEligible: boolean;
}): boolean {
    return lawEnabled() && input.usageUnknownAtPassStart && !input.emergencyDropEligible;
}

export function setRestoreOnlyBootPassEnabledForTests(enabled: boolean): void {
    (globalThis as GlobalWithRestoreOnlyBootPass).__mcRestoreOnlyBootPassEnabled = enabled;
}
