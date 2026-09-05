import { createTagger } from "../../features/magic-context/tagger";
import { applyHeuristicCleanup } from "./heuristic-cleanup";
import { registerIssue423Tests } from "./issue-423-test-support.test";
import { tagMessages } from "./tag-messages";

registerIssue423Tests("opencode", {
    raw: (fixture) => fixture.raw,
    cleanup(db, sessionId, fixture, percentage) {
        const tagger = createTagger();
        tagger.initFromDb(sessionId, db);
        const tagged = tagMessages(sessionId, fixture.opencode, tagger, db);
        return applyHeuristicCleanup(sessionId, db, tagged.targets, tagged.messageTagNumbers, {
            protectedTags: 24,
            routine: false,
            emergency: {
                currentTotalInputTokens: percentage * 2040,
                ceilingTokens: 204000 * 0.65,
                usagePercentage: percentage,
            },
        }).emergencyDroppedTools;
    },
});

import { mock } from "bun:test";
import type { PluginContext } from "../../plugin/types";
import { runCompartmentAgent } from "./compartment-runner";
import { registerIssue423HistorianTest } from "./issue-423-test-support.test";

registerIssue423HistorianTest(
    "opencode",
    async ({ db, sessionId, boundary, xml, holderId }) => {
        const client = {
            session: {
                get: mock(async () => ({ data: { directory: process.cwd() } })),
                create: mock(async () => ({ data: { id: `${sessionId}-child` } })),
                prompt: mock(async () => ({})),
                messages: mock(async () => ({
                    data: [
                        {
                            info: { role: "assistant", time: { created: 1 } },
                            parts: [{ type: "text", text: xml }],
                        },
                    ],
                })),
                delete: mock(async () => ({})),
            },
        } as unknown as PluginContext["client"];
        await runCompartmentAgent({
            client,
            db,
            sessionId,
            directory: process.cwd(),
            historianChunkTokens: 20000,
            boundarySnapshot: boundary,
            compartmentLeaseHolderId: holderId,
            memoryEnabled: false,
        });
    },
    (fixture) => fixture.raw,
);
