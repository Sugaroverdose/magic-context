import { createTagger } from "@magic-context/core/features/magic-context/tagger";
import { registerIssue423Tests } from "@magic-context/core/hooks/magic-context/issue-423-test-support.test";
import { tagTranscript } from "@magic-context/core/shared/tag-transcript";
import { applyPiHeuristicCleanup } from "./heuristic-cleanup-pi";
import { convertEntriesToRawMessages } from "./read-session-pi";
import { createPiTranscript } from "./transcript-pi";

registerIssue423Tests("pi", {
	raw: (fixture) => convertEntriesToRawMessages(fixture.entries),
	cleanup(db, sessionId, fixture, percentage) {
		const tagger = createTagger();
		tagger.initFromDb(sessionId, db);
		const transcript = createPiTranscript(fixture.pi, sessionId);
		const tagged = tagTranscript(sessionId, transcript, tagger, db);
		const result = applyPiHeuristicCleanup(
			sessionId,
			db,
			tagged.targets,
			fixture.pi,
			{
				protectedTags: 24,
				routine: false,
				staleReduceStripEnabled: false,
				emergency: {
					currentTotalInputTokens: percentage * 2040,
					ceilingTokens: 204000 * 0.65,
					usagePercentage: percentage,
				},
			},
		);
		transcript.commit();
		return result.emergencyDroppedTools;
	},
});

import { registerIssue423HistorianTest } from "@magic-context/core/hooks/magic-context/issue-423-test-support.test";
import { runPiHistorian } from "./pi-historian-runner";

registerIssue423HistorianTest(
	"pi",
	async ({ db, sessionId, raw, boundary, xml, holderId }) => {
		await runPiHistorian({
			db,
			sessionId,
			directory: process.cwd(),
			provider: { readMessages: () => raw },
			runner: {
				run: async () => ({ ok: true, assistantText: xml, durationMs: 1 }),
			},
			historianModel: "test/model",
			historianChunkTokens: 20000,
			boundarySnapshot: boundary,
			compartmentLeaseHolderId: holderId,
			memoryEnabled: false,
		});
	},
	(fixture) => convertEntriesToRawMessages(fixture.entries),
);
