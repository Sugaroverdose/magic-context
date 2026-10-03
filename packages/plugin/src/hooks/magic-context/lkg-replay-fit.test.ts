import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { runMigrations } from "../../features/magic-context/migrations";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { clearModelsDevCache, refreshModelLimitsFromApi } from "../../shared/models-dev-cache";
import { Database } from "../../shared/sqlite";
import { resolveContextWindowGeometry, resolveTrustedContextLimit } from "./event-resolvers";
import { lkgReplayFits, lkgReplayLimit } from "./lkg-replay-fit";
import type { MessageLike } from "./transform-operations";

// A model whose declared input limit is below its usable hard limit (a shared
// context/output window with a separate input figure), so the two limits differ.
const MODEL = { providerID: "openai-codex", modelID: "fit-model" };
const SESSION = "lkg-replay-fit-session";

function freshDb() {
    const db = new Database(":memory:");
    initializeDatabase(db as never);
    runMigrations(db as never);
    return db as never;
}

const messages: MessageLike[] = [
    {
        info: { id: "m1", role: "user", sessionID: SESSION },
        parts: [{ type: "text", text: "hello" }],
    } as MessageLike,
];

/** An estimator reporting a fixed, trusted token count. */
const estimateOf =
    (tokens: number, trusted = true) =>
    () => ({
        tokens,
        trusted,
        messageTokens: { conversation: tokens, toolCall: 0 },
        systemTokens: 0,
        toolDefinitionTokens: 0,
    });

describe("one admission limit for every last-known-good replay", () => {
    beforeEach(async () => {
        await refreshModelLimitsFromApi({
            config: {
                providers: async () => ({
                    data: {
                        providers: [
                            {
                                id: MODEL.providerID,
                                models: {
                                    [MODEL.modelID]: {
                                        limit: {
                                            context: 400_000,
                                            input: 272_000,
                                            output: 128_000,
                                        },
                                    },
                                },
                            },
                        ],
                    },
                }),
            },
        });
    });
    afterEach(() => clearModelsDevCache());

    it("admits every replay against the usable hard limit, the limit the frozen pass uses", () => {
        const db = freshDb();
        const ctx = { db, sessionID: SESSION };
        const usableHard = resolveContextWindowGeometry(MODEL.providerID, MODEL.modelID, ctx)
            ?.usableHard as number;
        const trusted = resolveTrustedContextLimit(MODEL.providerID, MODEL.modelID, ctx) as number;
        expect(trusted).toBeGreaterThan(0);
        expect(usableHard).toBeGreaterThan(trusted);
        expect(lkgReplayLimit({ db, sessionId: SESSION, model: MODEL, modelKey: null })).toBe(
            usableHard,
        );

        const fits = (tokens: number) =>
            lkgReplayFits({
                db,
                sessionId: SESSION,
                messages,
                model: MODEL,
                modelKey: null,
                systemPromptTokens: 0,
                estimator: estimateOf(tokens),
            });
        // Between the trusted limit and the usable hard limit: a healthy frozen pass
        // keeps serving this candidate, so a failure or wrapper replay serves it too
        // rather than refusing a turn the frozen pass would have sent.
        expect(fits(trusted + 1).fits).toBe(true);
        expect(fits(usableHard).fits).toBe(true);
        expect(fits(usableHard + 1).fits).toBe(false);
    });

    it("declines an untrusted estimate", () => {
        const db = freshDb();
        const fit = lkgReplayFits({
            db,
            sessionId: SESSION,
            messages,
            model: MODEL,
            modelKey: null,
            systemPromptTokens: 0,
            estimator: estimateOf(10, false),
        });
        expect(fit).toEqual({ fits: false, detail: expect.stringContaining("lkg_fit_untrusted") });
    });

    it("declines from the byte proxy without tokenizing", () => {
        const db = freshDb();
        let estimates = 0;
        const huge: MessageLike[] = [
            {
                info: { id: "m1", role: "user", sessionID: SESSION },
                parts: [{ type: "text", text: "word ".repeat(400_000) }],
            } as MessageLike,
        ];
        const fit = lkgReplayFits({
            db,
            sessionId: SESSION,
            messages: huge,
            model: MODEL,
            modelKey: null,
            systemPromptTokens: 0,
            estimator: () => {
                estimates += 1;
                return estimateOf(10)();
            },
        });
        expect(fit.fits).toBe(false);
        expect(estimates).toBe(0);
    });
});
