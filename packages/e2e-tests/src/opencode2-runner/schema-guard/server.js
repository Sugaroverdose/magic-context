import { appendFileSync } from "node:fs";
import { Message } from "@opencode/ai/schema/messages";

const trace = process.env.MC_E2E_SCHEMA_TRACE_PATH;

export default {
    id: "mc-e2e-llm-schema-guard",
    async setup(context) {
        await context.session.hook("context", (draft) => {
            for (const [messageIndex, message] of draft.messages.entries()) {
                try {
                    Message.make(message);
                } catch (error) {
                    let partIndex = -1;
                    for (const [index, part] of message.content.entries()) {
                        try {
                            Message.make({ ...message, content: [part] });
                        } catch {
                            partIndex = index;
                            break;
                        }
                    }
                    const part = message.content[partIndex];
                    const detail = {
                        sessionID: draft.sessionID,
                        messageIndex,
                        partIndex,
                        part: part === undefined ? null : part,
                        error: String(error),
                    };
                    const line = JSON.stringify(detail);
                    if (trace) appendFileSync(trace, `FAIL ${line}\n`);
                    throw new Error(`OC2 LLM schema guard: ${line}`);
                }
            }
            if (trace) appendFileSync(trace, `PASS ${draft.sessionID} ${draft.messages.length}\n`);
        });
    },
};
