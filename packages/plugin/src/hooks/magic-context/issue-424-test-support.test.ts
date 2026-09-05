import { describe, expect, test } from "bun:test";
import { appendCompartments } from "../../features/magic-context/compartment-storage";
import { initializeDatabase } from "../../features/magic-context/storage-db";
import { Database } from "../../shared/sqlite";
import { validateHistorianOutput } from "./compartment-runner-validation";
import { issue424Fixture } from "./issue-424-fixture";
import {
    applyHeadCap,
    describeBoundaryDiagnostics,
    resolveProtectedTailBoundary,
    resolveWrapupProtectedTailBoundary,
} from "./protected-tail-boundary";
import { setRawMessageProvider } from "./read-session-chunk";
import type { RawMessage } from "./read-session-raw";
import {
    buildToolArcs,
    buildTrueRawTokenIndex,
    completedToolArcCrossesBoundary,
} from "./read-session-true-raw-tokens";

export function registerIssue424Tests(
    harness: "pi" | "opencode",
    convert: (fixture: ReturnType<typeof issue424Fixture>) => RawMessage[],
) {
    function resolve(raw: RawMessage[], label: string) {
        const sessionId = `issue424-${harness}-${label}`;
        const dispose = setRawMessageProvider(sessionId, { readMessages: () => raw });
        try {
            return resolveProtectedTailBoundary({
                sessionId,
                mode: harness === "pi" ? "pi-runner" : "incremental-runner",
                contextLimit: 206464,
                executeThresholdPercentage: 60,
                triggerBudget: 18582,
                usage: { percentage: 73.8, inputTokens: 152274 },
                usageSource: "live",
                lastCompartmentEndOrdinal: 1,
                priorBoundaryOrdinal: 1,
                protectedTailPolicyVersion: 3,
                migrationFloorActive: false,
                providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
                cacheNamespace: sessionId,
            });
        } finally {
            dispose();
        }
    }
    describe(`issue 424 ${harness} boundary evidence`, () => {
        test("300 parallel batches with steering inside batches already progress below force pressure", () => {
            const raw = convert(issue424Fixture());
            const boundary = resolve(raw, "ordinary");
            expect(boundary.protectedTailStart).toBeGreaterThan(400);
            expect(boundary.eligibleEndOrdinal).toBeGreaterThan(boundary.offset);
            expect(boundary.eligibleEndOrdinal).toBeLessThan(30);
            const arcs = buildToolArcs(raw);
            expect(arcs.length).toBe(750);
            for (const arc of arcs) {
                expect(
                    completedToolArcCrossesBoundary(
                        arc.invOrdinal,
                        arc.resOrdinal!,
                        boundary.eligibleEndOrdinal,
                    ),
                ).toBe(false);
            }
        });
        test("oversized first batch reports cap retraction and whole-component admission separately", () => {
            const boundary = resolve(convert(issue424Fixture(300, 30)), "large");
            expect(boundary.protectedTailStart).toBeGreaterThan(400);
            expect(boundary.eligibleEndOrdinal).toBe(harness === "pi" ? 4 : 5);
            const diagnostics = boundary.diagnostics!;
            expect(diagnostics.usable).toBe(123878);
            expect(diagnostics.capTokens).toBe(30970);
            expect(diagnostics.head.capEnd).toBe(3);
            expect(diagnostics.head.completedFence.from).toBe(3);
            expect(diagnostics.head.completedFence.to).toBe(2);
            expect(diagnostics.head.completedFence.arcs.length).toBe(2);
            expect(diagnostics.head.completedFence.tokenMass).toBeGreaterThan(100000);
            expect(diagnostics.head.oversizeAdmission).toEqual({
                from: 2,
                to: harness === "pi" ? 4 : 5,
            });
            expect(diagnostics.head.openArcClamp).toEqual({
                from: harness === "pi" ? 4 : 5,
                to: harness === "pi" ? 4 : 5,
            });
            expect(diagnostics.livePromptFloor.to).toBeGreaterThan(400);
            expect(describeBoundaryDiagnostics(boundary)).toContain('"capTokens":30970');
            expect(describeBoundaryDiagnostics(boundary)).toContain(
                '"drainBudget":"not-reserved; does-not-size-cap"',
            );
        });
        test("wrapup explains its tiny first chunk before an oversized batch", () => {
            const source = convert(issue424Fixture(300, 30));
            const raw = [
                source[0]!,
                {
                    ordinal: 2,
                    id: "tiny",
                    role: "assistant",
                    parts: [{ type: "text", text: "Starting now." }],
                },
                ...source.slice(1),
            ].map((m, i) => ({ ...m, ordinal: i + 1 }));
            const sessionId = `issue424-wrapup-${harness}`;
            const dispose = setRawMessageProvider(sessionId, { readMessages: () => raw });
            const db = new Database(":memory:");
            initializeDatabase(db);
            try {
                const plan = resolveWrapupProtectedTailBoundary({
                    db,
                    sessionId,
                    mode: "manual-wrapup",
                    contextLimit: 206464,
                    executeThresholdPercentage: 60,
                    usage: { percentage: 0, inputTokens: 0 },
                    usageSource: "manual-none",
                    providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
                    messagesToKeep: 20,
                });
                expect(plan.snapshot.eligibleEndOrdinal - plan.snapshot.offset).toBe(2);
                expect(plan.snapshot.diagnostics!.capTokens).toBe(74326);
                expect(plan.snapshot.diagnostics!.head.completedFence).toMatchObject({
                    from: 4,
                    to: 3,
                });
                expect(plan.snapshot.diagnostics!.head.completedFence.tokenMass).toBeGreaterThan(
                    100000,
                );
                let current = plan;
                let chunks = 0;
                const arcs = buildToolArcs(raw);
                while (current.snapshot.offset < plan.targetEligibleEndOrdinal) {
                    expect(current.snapshot.eligibleEndOrdinal).toBeGreaterThan(
                        current.snapshot.offset,
                    );
                    for (const arc of arcs) {
                        expect(
                            completedToolArcCrossesBoundary(
                                arc.invOrdinal,
                                arc.resOrdinal!,
                                current.snapshot.eligibleEndOrdinal,
                            ),
                        ).toBe(false);
                    }
                    appendCompartments(db, sessionId, [
                        {
                            sequence: chunks++,
                            startMessage: current.snapshot.offset,
                            endMessage: current.snapshot.eligibleEndOrdinal - 1,
                            startMessageId: current.snapshot.offsetMessageId!,
                            endMessageId: current.snapshot.eligibleEndMessageId!,
                            title: "completed",
                            content: "Completed batch.",
                        },
                    ]);
                    expect(chunks).toBeLessThan(200);
                    current = resolveWrapupProtectedTailBoundary({
                        db,
                        sessionId,
                        mode: "manual-wrapup",
                        contextLimit: 206464,
                        executeThresholdPercentage: 60,
                        usage: { percentage: 0, inputTokens: 0 },
                        usageSource: "manual-none",
                        providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
                        messagesToKeep: 20,
                        anchorRawMessageCount: plan.anchorRawMessageCount,
                    });
                }
                expect(chunks).toBeGreaterThan(10);
            } finally {
                dispose();
                db.close();
            }
        });
        test("an oversized first batch advances below force pressure without admitting the next batch", () => {
            const raw = convert(issue424Fixture(300, 30));
            const boundary = resolve(raw, "candidate");
            expect(boundary.eligibleEndOrdinal).toBe(harness === "pi" ? 4 : 5);
            expect(boundary.oversizeAtomicUnit).toBe(true);
            for (const arc of buildToolArcs(raw)) {
                expect(
                    completedToolArcCrossesBoundary(
                        arc.invOrdinal,
                        arc.resOrdinal!,
                        boundary.eligibleEndOrdinal,
                    ),
                ).toBe(false);
            }
        });
        test("random sequential batches preserve every whole arc and historian range validation", () => {
            for (let seed = 1; seed <= 20; seed++) {
                const raw = convert(issue424Fixture(30, 1, seed));
                const arcs = buildToolArcs(raw);
                const index = buildTrueRawTokenIndex(`issue424-property-${harness}-${seed}`, raw, {
                    providerShapeVersion: harness === "pi" ? "pi-folded-v1" : "opencode-v1",
                    cacheNamespace: `issue424-property-${harness}-${seed}`,
                });
                let offset = 2;
                while (offset < raw.length + 1) {
                    const head = applyHeadCap({
                        index,
                        arcs,
                        offset,
                        protectedTailStart: raw.length + 1,
                        lastCompartmentEndOrdinal: offset - 1,
                        capTokens: 20000 + seed * 1000,
                        recentOpenArcCutoff: raw.length + 1,
                    });
                    expect(head.eligibleEndOrdinal).toBeGreaterThan(offset);
                    for (const arc of arcs) {
                        expect(
                            completedToolArcCrossesBoundary(
                                arc.invOrdinal,
                                arc.resOrdinal!,
                                head.eligibleEndOrdinal,
                            ),
                        ).toBe(false);
                    }
                    const end = head.eligibleEndOrdinal - 1;
                    const validation = validateHistorianOutput(
                        `<output><compartment start="${offset}" end="${end}" title="batch"><p1>Completed investigation.</p1></compartment></output>`,
                        "issue424-property",
                        {
                            startIndex: offset,
                            endIndex: end,
                            lines: raw
                                .filter((m) => m.ordinal >= offset && m.ordinal <= end)
                                .map((m) => ({ ordinal: m.ordinal, messageId: m.id })),
                            toolOnlyRanges: [],
                            completedToolArcs: arcs.map((arc) => ({
                                start: arc.invOrdinal,
                                end: arc.resOrdinal!,
                            })),
                        },
                        [],
                        0,
                    );
                    expect(validation.ok).toBe(true);
                    offset = head.eligibleEndOrdinal;
                }
            }
        });
    });
}
