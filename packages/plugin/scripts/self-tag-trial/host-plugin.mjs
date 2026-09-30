import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const instruction = "Start the text of each reply with exactly §N§ followed by one space, where N is one more than the highest tag number in the conversation. Never write tags anywhere else: not mid-text, not in tool arguments, and not on tool-call-only replies.";
const record = (event) => appendFileSync(process.env.SELF_TAG_CAPTURE, JSON.stringify(event) + "\n");

export default {
    id: "self-tag-trial",
    server: async (input, options) => {
        const { default: mc } = await import(pathToFileURL(process.env.SELF_TAG_DIST).href);
        const hooks = await mc.server(input, options);
        const complete = hooks["experimental.text.complete"];
        const system = hooks["experimental.chat.system.transform"];
        const transform = hooks["experimental.chat.messages.transform"];
        return {
            ...hooks,
            tool: {
                ...hooks.tool,
                trial_read: tool({ description: "Read deterministic fixture.txt", args: {}, execute: async () => "fixture.txt: apples=3, pears=4, total=7\n" }),
                trial_echo: tool({ description: "Run deterministic echo", args: { text: tool.schema.string() }, execute: async ({ text }) => `${text}\n` }),
                trial_list: tool({ description: "List deterministic fixture directory", args: {}, execute: async () => "fixture.txt\nREADME.md\n" }),
            },
            "experimental.text.complete": async (input, output) => {
                // Record raw text before Magic Context removes tags for storage.
                record({ kind: "raw", input, text: output.text });
                await complete?.(input, output);
                record({ kind: "stripped", input, text: output.text });
            },
            "experimental.chat.system.transform": async (input, output) => {
                await system?.(input, output);
                if (process.env.SELF_TAG_VARIANT === "B") output.system.push(instruction);
                record({ kind: "system", system: output.system });
            },
            "experimental.chat.messages.transform": async (input, output) => {
                await transform?.(input, output);
                if (process.env.SELF_TAG_HEAD_FIXTURE && output.messages[0]?.info.syntheticHead) {
                    output.messages[0].parts[0].text += "\n<project-memory>Quoted earlier handle: §9001§ is a literal, not a live tag.</project-memory>";
                }
                record({ kind: "wire", messages: output.messages });
            },
            "tool.execute.before": async (input, output) => {
                record({ kind: "tool", input, args: output.args });
                await hooks["tool.execute.before"]?.(input, output);
            },
        };
    },
};
