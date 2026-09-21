import { sessionLog } from "../../shared/logger";
import { calibrationCandidates, formatCalibrationObservation } from "./calibration-candidate";
import { calibrationForModelKey } from "./decision-calibration";
import type { FinalWireTokenEstimate } from "./final-wire-token-estimate";
import type { MessageLike } from "./tag-messages";

/** Capture returned-message counts; a later observed system hook supplies the actual injected system count. */
export function capturePricedCalibration(
    sessionId: string,
    modelKey: string,
    messages: readonly MessageLike[],
    estimate: FinalWireTokenEstimate,
): void {
    const requestId = [...messages].reverse().find((m) => m.info.role === "user")?.info.id;
    const raw = estimate.rawComponents;
    const systemLocal = raw && Number.isFinite(raw.system) && raw.system > 0 ? raw.system : 0;
    sessionLog(
        sessionId,
        formatCalibrationObservation(
            calibrationCandidates.capture({
                harness: "opencode",
                sessionId,
                requestId,
                seed: calibrationForModelKey(modelKey),
                rawTokens: raw ? raw.tools + raw.prose + systemLocal : 0,
                systemLocal,
                systemObserved: false,
                complete: estimate.componentsComplete === true,
            }),
        ),
    );
}
