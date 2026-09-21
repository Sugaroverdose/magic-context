import { calibrationForModelKey, type DecisionCalibration } from "./decision-calibration";

interface Capture {
    harness: string;
    sessionId: string;
    requestId?: string;
    seed: DecisionCalibration;
    rawTokens: number;
    systemLocal: number;
    complete: boolean;
    systemObserved: boolean;
}
interface RecordState {
    n: number;
    ema?: number;
    completedAt: number;
}
export interface CandidateObservation {
    modelKey: string;
    seed: DecisionCalibration;
    sample?: number;
    local?: number;
    providerInput?: number;
    ema?: number;
    n: number;
    source: "seed" | "family-fallback" | "learned-candidate";
    completeness: "complete" | "partial";
    reason?: string;
}

/** Process-local telemetry only. No decision module reads these records. */
export class CalibrationCandidates {
    private readonly pending = new Map<string, Capture>();
    private readonly records = new Map<string, RecordState>();
    private readonly completed = new Set<string>();

    private key(harness: string, session: string, model: string): string {
        return JSON.stringify([harness, session, model.toLowerCase()]);
    }
    private snapshot(
        key: string,
        seed: DecisionCalibration,
        complete: boolean,
        reason?: string,
    ): CandidateObservation {
        const state = this.records.get(key);
        return {
            modelKey: seed.modelKey,
            seed,
            ema: state?.ema,
            n: state?.n ?? 0,
            source: seed.source,
            completeness: complete ? "complete" : "partial",
            reason,
        };
    }
    capture(input: Capture): CandidateObservation {
        const key = this.key(input.harness, input.sessionId, input.seed.modelKey);
        if (!input.requestId)
            return {
                ...this.snapshot(key, input.seed, false, "uncorrelated"),
                local: input.rawTokens,
            };
        const id = `${key}:${input.requestId}`;
        const duplicate = this.pending.has(id);
        this.pending.set(id, { ...input, complete: input.complete && !duplicate });
        while (this.pending.size > 1024) this.pending.delete(this.pending.keys().next().value!);
        return {
            ...this.snapshot(
                key,
                input.seed,
                input.complete && input.systemObserved && !duplicate,
                duplicate ? "overlapping-attempt" : undefined,
            ),
            local: input.rawTokens,
        };
    }
    needsSystem(harness: string, sessionId: string, modelKey: string): boolean {
        return [...this.pending.values()].some(
            (p) =>
                p.harness === harness &&
                p.sessionId === sessionId &&
                p.seed.modelKey === modelKey.toLowerCase() &&
                !p.systemObserved,
        );
    }
    observeSystem(harness: string, sessionId: string, modelKey: string, systemLocal: number): void {
        const matching = [...this.pending.values()].filter(
            (p) =>
                p.harness === harness &&
                p.sessionId === sessionId &&
                p.seed.modelKey === modelKey.toLowerCase(),
        );
        if (matching.length !== 1) {
            for (const p of matching) p.complete = false;
            return;
        }
        const capture = matching[0];
        if (capture.systemObserved) return;
        capture.rawTokens += systemLocal - capture.systemLocal;
        capture.systemLocal = systemLocal;
        capture.systemObserved = Number.isFinite(systemLocal) && systemLocal > 0;
    }
    complete(input: {
        harness: string;
        sessionId: string;
        modelKey: string;
        requestId?: string;
        responseId?: string;
        providerInput: number;
        completedAt: number;
        failed?: boolean;
    }): CandidateObservation {
        const seed = calibrationForModelKey(input.modelKey);
        const key = this.key(input.harness, input.sessionId, seed.modelKey);
        const id = `${key}:${input.requestId ?? ""}`;
        const responseKey = `${key}:${input.responseId ?? ""}`;
        const captured = this.pending.get(id);
        if (!input.responseId || this.completed.has(responseKey))
            return this.snapshot(key, seed, false, "duplicate-or-unidentified-response");
        this.pending.delete(id);
        this.completed.add(responseKey);
        while (this.completed.size > 2048)
            this.completed.delete(this.completed.values().next().value!);
        const prior = this.records.get(key);
        if (
            input.failed ||
            !captured?.complete ||
            !captured.systemObserved ||
            !Number.isFinite(captured.rawTokens) ||
            captured.rawTokens <= 0 ||
            !Number.isFinite(input.providerInput) ||
            input.providerInput <= 0 ||
            !Number.isFinite(input.completedAt) ||
            input.completedAt <= (prior?.completedAt ?? 0)
        ) {
            return this.snapshot(key, seed, false, "incomplete-invalid-or-out-of-order");
        }
        const sample = input.providerInput / captured.rawTokens;
        if (!Number.isFinite(sample) || sample <= 0)
            return this.snapshot(key, seed, false, "invalid-ratio");
        const next = {
            n: (prior?.n ?? 0) + 1,
            ema: prior?.ema === undefined ? sample : 0.25 * sample + 0.75 * prior.ema,
            completedAt: input.completedAt,
        };
        this.records.set(key, next);
        while (this.records.size > 1024) this.records.delete(this.records.keys().next().value!);
        return {
            ...this.snapshot(key, seed, true),
            sample,
            local: captured.rawTokens,
            providerInput: input.providerInput,
            source: "learned-candidate",
        };
    }
}

export const calibrationCandidates = new CalibrationCandidates();
export function formatCalibrationObservation(value: CandidateObservation): string {
    return `calibration: model=${value.modelKey} seed=${value.seed.systemRatio}/${value.seed.toolsRatio}/${value.seed.proseRatio} sample=${value.sample ?? "unavailable"} ema=${value.ema ?? "unavailable"} n=${value.n} source=${value.source} completeness=${value.completeness} seed_source=${value.seed.source}${value.seed.derivedFrom ? ` derivedFrom=${value.seed.derivedFrom}` : ""}${value.reason ? ` reason=${value.reason}` : ""} local=${value.local ?? "unavailable"} provider_input=${value.providerInput ?? "unavailable"} revision=${value.seed.revision} matched_prefix=${value.seed.matchedPrefix ?? "none"} tool_io_policy=tool-schema-seed framing=unmeasured`;
}
