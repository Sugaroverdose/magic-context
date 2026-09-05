import { expect, test } from "bun:test";
import cases from "../../../../../crates/mc-module/testdata/issue-424-head-cap.json";
import { applyHeadCap } from "./protected-tail-boundary";
import {
    buildTrueRawTokenIndexFromTokenCountsForTest,
    completedToolArcCrossesBoundary,
} from "./read-session-true-raw-tokens";

test("issue 424 head cap matches shared Rust differential cases", () => {
    for (const fixture of cases) {
        const arcs = fixture.arcs.map((arc, i) => ({ ...arc, callId: String(i) }));
        const result = applyHeadCap({
            index: buildTrueRawTokenIndexFromTokenCountsForTest(fixture.label, fixture.tokens),
            arcs,
            offset: fixture.offset,
            lastCompartmentEndOrdinal: fixture.offset - 1,
            protectedTailStart: fixture.protected_tail_start,
            capTokens: fixture.cap_tokens,
            recentOpenArcCutoff: fixture.recent_open_arc_cutoff,
        });
        expect(result.eligibleEndOrdinal, fixture.label).toBe(fixture.expected_end);
        expect(result.oversizeAtomicUnit, fixture.label).toBe(fixture.expected_oversize);
        for (const arc of arcs) {
            if (arc.resOrdinal !== null)
                expect(
                    completedToolArcCrossesBoundary(
                        arc.invOrdinal,
                        arc.resOrdinal,
                        result.eligibleEndOrdinal,
                    ),
                    fixture.label,
                ).toBe(false);
        }
    }
});
