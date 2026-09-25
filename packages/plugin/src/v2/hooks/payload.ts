import type { MessageLike } from "../../hooks/magic-context/tag-messages";
import { log, sessionLog } from "../../shared/logger";
import { hostMediaAsset } from "../fold/host-media";
import type { SessionContext, V2Message } from "./types";

export const HEAD_IDS = ["__magic_context_v2_m0__", "__magic_context_v2_m1__"] as const;
type Part = Record<string, unknown>;
const HOST_CONTENT_TYPES = new Set([
    "text",
    "media",
    "tool-call",
    "tool-result",
    "reasoning",
    "compaction",
    "effort",
]);

// Logged to the plugin's own log, never the host's stderr: this runs inside the host's
// per-turn context hook.
function rejectContentPart(message: MessageLike, part: Part, reason: string): void {
    const type = typeof part.type === "string" ? part.type : "<missing>";
    const text = `v2 context omitted a content part the host would reject: type=${type} message=${String(message.info.id ?? "<head>")} reason=${reason}`;
    if (typeof message.info.sessionID === "string") sessionLog(message.info.sessionID, text);
    else log(text);
}

interface ToolBridge {
    call?: Part;
    result?: Part;
    native?: Part;
    output: string;
    resultMessage?: V2Message;
}

/** True for an object structuredClone would flatten: anything other than a plain object or
 * array. OpenCode 2.0.15 puts an attachment's bytes in a `Media.Asset` class instance, and
 * the host's schema accepts only a real instance when it rebuilds the draft after the hook. */
function isHostInstance(value: unknown): value is object {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype && prototype !== null;
}

function containsHostInstance(value: unknown): boolean {
    if (isHostInstance(value)) return true;
    if (Array.isArray(value)) return value.some(containsHostInstance);
    if (value && typeof value === "object") return Object.values(value).some(containsHostInstance);
    return false;
}

/** Deep copy that keeps class instances by reference, so a pipeline edit to the copy cannot
 * reach the host's draft while the host's own objects survive the round trip. */
function clonePreservingInstances<T>(value: T): T {
    if (isHostInstance(value)) return value;
    if (Array.isArray(value)) return value.map(clonePreservingInstances) as T;
    if (value && typeof value === "object") {
        const copy: Part = {};
        for (const [key, entry] of Object.entries(value))
            copy[key] = clonePreservingInstances(entry);
        return copy as T;
    }
    return value;
}

/** Content key that ignores prototypes and toJSON, so a part and its structuredClone agree. */
function contentKey(value: unknown): string {
    const plain = (entry: unknown): unknown => {
        if (ArrayBuffer.isView(entry)) {
            return {
                bytes: Buffer.from(entry.buffer, entry.byteOffset, entry.byteLength).toString(
                    "base64",
                ),
            };
        }
        if (Array.isArray(entry)) return entry.map(plain);
        if (entry && typeof entry === "object") {
            return Object.fromEntries(
                Object.entries(entry).map(([key, nested]) => [key, plain(nested)]),
            );
        }
        return entry;
    };
    return JSON.stringify(plain(value));
}

function toolStateContent(state: Part): string {
    if (typeof state.output === "string") return state.output;
    if (typeof state.content === "string") return state.content;
    if (!Array.isArray(state.content)) return "";
    return state.content
        .map((part) => {
            if (typeof part === "string") return part;
            if (!part || typeof part !== "object") return "";
            const value = part as Part;
            if (typeof value.text === "string") return value.text;
            if (typeof value.value === "string") return value.value;
            return "";
        })
        .filter(Boolean)
        .join("\n");
}

/** Project the host's split call/result pair into the TS pipeline's native tool part.
 * Only native tool parts allocate tags; feeding a bare tool_result can replay an
 * existing tag but cannot create one. The inverse projection preserves host metadata.
 */
export function adaptPayload(draft: SessionContext, admittedIDs: ReadonlySet<string> = new Set()) {
    const existingHeads = new Map(
        draft.messages.filter((m) => HEAD_IDS.some((id) => m.id === id)).map((m) => [m.id, m]),
    );
    const source = draft.messages.filter((m) => !existingHeads.has(m.id));
    const results = new Map<string, Array<{ part: Part; message: V2Message }>>();
    // Host parts that hold class instances, keyed by content. Some pipeline stages swap a
    // structuredClone of a message's parts into place; commit() hands the host its original
    // object back for any such part the pipeline left unchanged.
    const hostParts = new Map<string, Part>();
    const hostPartTypes = new Set<unknown>();
    for (const message of source) {
        for (const part of message.content) {
            if (
                part.type !== "tool-call" &&
                part.type !== "tool-result" &&
                part.type !== "tool" &&
                containsHostInstance(part)
            ) {
                const key = contentKey(part);
                if (!hostParts.has(key)) hostParts.set(key, part);
                hostPartTypes.add(part.type);
            }
            if (part.type === "tool-result" && typeof part.id === "string") {
                const queue = results.get(part.id) ?? [];
                queue.push({ part, message });
                results.set(part.id, queue);
            }
        }
    }
    const paired = new Set<Part>();
    const bridges = new Map<unknown, ToolBridge>();
    const originals = new Map<MessageLike, V2Message>();
    // The pipeline does not preserve object identity: the drop and edit-marker paths swap a
    // rewritten structuredClone into `parts`, and trailing-blank normalization replaces a
    // message with a copy. commit() therefore also resolves a part's bridge by (message id,
    // callID) and a message's host original by id. Scoped per message because two turns may
    // reuse one callID; host tool-result carriers have no id, so they keep an object key.
    const bridgesByMessageID = new Map<string, Map<string, ToolBridge>>();
    const bridgesByCarrier = new Map<MessageLike, Map<string, ToolBridge>>();
    const originalsByID = new Map<string, V2Message>();
    const bridgesFor = (message: MessageLike) =>
        typeof message.info.id === "string"
            ? bridgesByMessageID.get(message.info.id)
            : bridgesByCarrier.get(message);
    const nativeTool = (
        call: Part | undefined,
        result: { part: Part; message: V2Message } | undefined,
    ): Part => {
        const value = (result?.part.result as Part | undefined)?.value;
        const output =
            typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
        const part = {
            type: "tool",
            callID: call?.id ?? result?.part.id,
            tool: call?.name ?? result?.part.name,
            state: {
                input: structuredClone(call?.input ?? {}),
                status: result ? "completed" : "running",
                ...(result ? { output } : {}),
            },
        };
        bridges.set(part, { call, result: result?.part, resultMessage: result?.message, output });
        if (result) paired.add(result.part);
        return part;
    };
    const convertedTool = (source: Part): Part => {
        const sourceState =
            source.state && typeof source.state === "object" ? (source.state as Part) : {};
        const output = toolStateContent(sourceState);
        const { content: _content, ...projectedState } = structuredClone(sourceState);
        const part = {
            type: "tool",
            callID: source.callID ?? source.id,
            tool: source.tool ?? source.name,
            state: { ...projectedState, output },
        };
        bridges.set(part, { native: source, output });
        return part;
    };
    // Pair calls before walking result carriers; the host omits IDs on those
    // carriers, while the assistant row ID remains the composite tag owner.
    const callParts = new Map<Part, Part>();
    for (const message of source) {
        for (const part of message.content) {
            if (part.type === "tool-call") {
                callParts.set(part, nativeTool(part, results.get(String(part.id))?.shift()));
            } else if (part.type === "tool") {
                callParts.set(part, convertedTool(part));
            }
        }
    }
    const messages: MessageLike[] = [];
    for (const message of source) {
        const parts: Part[] = [];
        for (const content of message.content) {
            if (paired.has(content)) continue;
            const part =
                callParts.get(content) ??
                (content.type === "tool-result"
                    ? nativeTool(undefined, { part: content, message })
                    : clonePreservingInstances(content));
            if (message.id && admittedIDs.has(message.id)) part.synthetic = true;
            parts.push(part);
        }
        if (!parts.length && message.content.length) continue;
        const byCallID = new Map<string, ToolBridge>();
        for (const part of parts) {
            const bridge = bridges.get(part);
            if (bridge && typeof part.callID === "string") byCallID.set(part.callID, bridge);
        }
        if (typeof message.id === "string") {
            bridgesByMessageID.set(message.id, byCallID);
            originalsByID.set(message.id, message);
        }
        const mapped: MessageLike = {
            info: {
                id: message.id,
                sessionID: draft.sessionID,
                role: message.role,
                // No `tools`: on this host `draft.tools` is the full definition of every
                // tool, not the per-message on/off map an OpenCode 1 message carries, so
                // no reader of `info.tools` can learn anything from it. Copied onto each
                // message it was tens of kilobytes per message, which made a
                // 10,000-message session a 200 MB module request that never answered.
                ...{
                    providerID: draft.model.providerID,
                    modelID: draft.model.id,
                    agent: draft.agent,
                },
            },
            parts,
        };
        originals.set(mapped, message);
        if (typeof message.id !== "string") bridgesByCarrier.set(mapped, byCallID);
        messages.push(mapped);
    }
    return {
        messages,
        commit() {
            let head = 0;
            const rendered: V2Message[] = [];
            for (const message of messages) {
                const original =
                    originals.get(message) ??
                    (typeof message.info.id === "string"
                        ? originalsByID.get(message.info.id)
                        : undefined);
                const id = message.info.syntheticHead ? HEAD_IDS[head++] : original?.id;
                const content: Part[] = [];
                const following: V2Message[] = [];
                for (const candidate of message.parts) {
                    const part = candidate as Part;
                    const bridge =
                        bridges.get(part) ??
                        (part.type === "tool" && typeof part.callID === "string"
                            ? bridgesFor(message)?.get(part.callID)
                            : undefined);
                    if (!bridge) {
                        if (part.type === "tool") {
                            const state = part.state as Part | undefined;
                            if (
                                typeof part.callID !== "string" ||
                                typeof part.tool !== "string" ||
                                !state ||
                                typeof state !== "object"
                            ) {
                                rejectContentPart(
                                    message,
                                    part,
                                    "tool has no call ID, name, or state",
                                );
                                continue;
                            }
                            content.push({
                                type: "tool-call",
                                id: part.callID,
                                name: part.tool,
                                input: state.input,
                            });
                            if (state.status === "completed" || state.status === "error") {
                                following.push({
                                    role: "tool",
                                    content: [
                                        {
                                            type: "tool-result",
                                            id: part.callID,
                                            name: part.tool,
                                            result: {
                                                type: state.status === "error" ? "error" : "text",
                                                value: toolStateContent(state),
                                            },
                                        },
                                    ],
                                });
                            }
                            continue;
                        }
                        if (part.type === "file") {
                            const mime = part.mime;
                            const url = part.url;
                            const prefix = `data:${mime};base64,`;
                            if (
                                typeof mime !== "string" ||
                                !/^image\/(png|jpeg|gif|webp)$/.test(mime) ||
                                typeof url !== "string" ||
                                !url.startsWith(prefix)
                            ) {
                                rejectContentPart(
                                    message,
                                    part,
                                    "file is not an inline supported image",
                                );
                                continue;
                            }
                            const asset = hostMediaAsset(url.slice(prefix.length), mime);
                            if (typeof asset === "string") {
                                rejectContentPart(
                                    message,
                                    part,
                                    `host media unavailable: ${asset}`,
                                );
                                continue;
                            }
                            content.push({ type: "media", media: asset });
                            continue;
                        }
                        if (!HOST_CONTENT_TYPES.has(String(part.type))) {
                            rejectContentPart(message, part, "unknown host content type");
                            continue;
                        }
                        const { synthetic: _synthetic, ...clean } = part;
                        const original =
                            hostPartTypes.has(clean.type) && !containsHostInstance(clean)
                                ? hostParts.get(contentKey(clean))
                                : undefined;
                        content.push(original ?? clean);
                        continue;
                    }
                    const state = part.state as Part;
                    if (bridge.native) {
                        // Converted OpenCode 1 store rows still carry `type: "tool"`. That is a
                        // session-store part, not an LLM content part; a surviving skeleton must
                        // become the same call/result pair as a native OpenCode 2 tool arc.
                        const native = bridge.native;
                        const callID = String(native.id ?? native.callID ?? part.callID);
                        const name = String(native.name ?? native.tool ?? part.tool);
                        content.push({ type: "tool-call", id: callID, name, input: state.input });
                        if (state.status === "completed" || state.status === "error") {
                            following.push({
                                role: "tool",
                                content: [
                                    {
                                        type: "tool-result",
                                        id: callID,
                                        name,
                                        result: { type: "text", value: state.output },
                                    },
                                ],
                            });
                        }
                        continue;
                    }
                    if (bridge.call) content.push({ ...bridge.call, input: state.input });
                    if (bridge.result && bridge.resultMessage) {
                        const result = {
                            ...bridge.result,
                            result:
                                state.output === bridge.output
                                    ? bridge.result.result
                                    : { type: "text", value: state.output },
                        };
                        if (bridge.resultMessage === original) content.push(result);
                        else following.push({ ...bridge.resultMessage, content: [result] });
                    }
                }
                if (content.length || !original?.content.length) {
                    const value: V2Message = {
                        ...original,
                        id,
                        role: message.info.role ?? "user",
                        content,
                    };
                    const existing = id ? existingHeads.get(id) : undefined;
                    rendered.push(existing ? Object.assign(existing, { content }) : value);
                }
                rendered.push(...following);
            }
            draft.messages.splice(0, draft.messages.length, ...rendered);
        },
    };
}
