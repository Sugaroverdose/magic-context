import {
    createLiveSessionState,
    type LiveSessionState,
} from "../../hooks/magic-context/live-session-state";

export function createV2RpcLiveSessionState(
    overrides: Pick<
        LiveSessionState,
        | "liveModelBySession"
        | "variantBySession"
        | "agentBySession"
        | "channel1StateBySession"
        | "historyRefreshSessions"
        | "pendingMaterializationSessions"
    >,
): LiveSessionState {
    return Object.assign(createLiveSessionState(), overrides);
}
