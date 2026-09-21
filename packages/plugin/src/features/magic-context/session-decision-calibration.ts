import {
    calibrationForModelKey,
    type DecisionCalibration,
} from "../../hooks/magic-context/decision-calibration";
import { piModelRefToCanonical } from "../../shared/harness-provider-map";
import type { Database } from "../../shared/sqlite";

/** Reproduce the static seed from the model paired with cached bytes; no learned state is stored. */
export function sessionDecisionCalibration(db: Database, sessionId: string): DecisionCalibration {
    let key: string | undefined;
    try {
        const row = db
            .prepare(
                "SELECT COALESCE(NULLIF(cached_m0_model_key, ''), last_observed_model_key) AS model_key FROM session_meta WHERE session_id = ?",
            )
            .get(sessionId) as { model_key?: string } | undefined;
        key = row?.model_key;
    } catch {
        // Legacy stores without model metadata retain neutral eviction/protection semantics.
    }
    return calibrationForModelKey(piModelRefToCanonical(key ?? ""));
}
