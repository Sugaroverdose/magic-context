import { describe, expect, it } from "bun:test";

import type { HiddenCompletionExecutor, HiddenRunHandle } from "./compartment-runner-types";
import { HistorianHostRunner, type HistorianHostRunnerDeps } from "./historian-host-runner";

/**
 * One queued historian run, claimed by two different hosts in turn.
 *
 * The run carries the queuing request's model chain and await budget, and nothing
 * else about timing. Each claimant then times its own attempts from its OWN
 * `historian_timeout_ms` (`attemptTimeoutMs`), so the same run is attempted
 * differently depending on which machine happens to claim it. The module's own
 * lane attempts it with the queuing request's timeout. This test claims the same
 * run from a host configured with a short per-attempt timeout and from one with
 * none, lets the first model hang, and compares how many models each tried inside
 * the same window.
 */

function claimOnlyModule(reports: string[]): HistorianHostRunnerDeps["call"] {
    let claimed = false;
    return async ({ method, body }) => {
        switch (method) {
            case "historian.pending":
                return claimed
                    ? { ok: true, runs: [] }
                    : {
                          ok: true,
                          runs: [
                              {
                                  run_id: "run-1",
                                  session_id: "ses-1",
                                  chunk_fingerprint: "fp",
                                  prompt_bytes_len: 10,
                                  deadline_ms: Date.now() + 60_000,
                              },
                          ],
                      };
            case "historian.claim":
                claimed = true;
                return {
                    ok: true,
                    run_id: body.run_id,
                    session_id: "ses-1",
                    attempt: 1,
                    token: "token-1",
                    prompt: { system: "system", user: "user" },
                    // Two models: a first attempt that times out falls through to the second.
                    model_chain: ["prov/first", "prov/second"],
                    // The queuing request's wait: its own per-attempt timeout plus the
                    // module's recovery margin.
                    await_budget_ms: 2_000,
                    claim_deadline_ms: Date.now() + 60_000,
                    heartbeat_interval_ms: 30_000,
                };
            case "historian.heartbeat":
                return { ok: true, claim_deadline_ms: Date.now() + 60_000 };
            case "historian.complete":
                reports.push(JSON.stringify(body.error ?? body.output ?? null));
                return { ok: true, accepted: true, publish: "immediate" };
        }
    };
}

/**
 * A carrier shaped like the OpenCode 1 child-session one: `attempt` is the
 * synchronous prompt and returns once the model has answered, here after 400ms;
 * `collect` then reads the answer. Each attempt records which model it used.
 */
function slowModelExecutor(models: string[]): HiddenCompletionExecutor {
    return {
        capabilities: { tools: false, harness: "opencode" },
        open: async (): Promise<HiddenRunHandle> => ({ id: "child", childSessionId: "child" }),
        attempt: async (_handle, request) => {
            const body = (request as { body?: { model?: { modelID?: string } } }).body;
            models.push(String(body?.model?.modelID ?? "?"));
            await Bun.sleep(400);
        },
        collect: async () =>
            ({
                text: "<compartments/>",
                usage: { input: 0, output: 0, reasoning: 0, cache: 0 },
                lengthCapped: false,
            }) as never,
        close: async () => {},
    };
}

async function attemptsWithin(windowMs: number, attemptTimeoutMs: number | undefined) {
    const models: string[] = [];
    const reports: string[] = [];
    const runner = new HistorianHostRunner({
        call: claimOnlyModule(reports),
        claimantInstanceId: "install",
        openExecutor: () => ({ executor: slowModelExecutor(models), sessionDirectory: "/tmp/p" }),
        enabled: () => true,
        attemptTimeoutMs: () => attemptTimeoutMs,
    });
    // The pump is not awaited so the window, not the run, decides what is compared.
    void runner.pump("ses-1");
    await Bun.sleep(windowMs);
    const seen = { models: [...models], reports: [...reports] };
    void runner.stop();
    return seen;
}

describe("historian host runner: per-attempt timeout", () => {
    it("attempts one claimed run the same way whichever host claims it", async () => {
        const shortHost = await attemptsWithin(1_500, 150);
        const defaultHost = await attemptsWithin(1_500, undefined);
        console.log(
            `models attempted in 1500ms: host with a 150ms attempt timeout=${JSON.stringify(shortHost)} host with none=${JSON.stringify(defaultHost)}`,
        );
        expect(shortHost).toEqual(defaultHost);
    }, 10_000);
});
