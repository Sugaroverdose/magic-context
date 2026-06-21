import { describe, expect, test } from "bun:test";
import { DREAMER_AGENT, DREAMER_RETROSPECTIVE_AGENT } from "./agents/dreamer";
import { buildHiddenAgentRegistrations } from "./agents/hidden-agent-registrations";
import { HISTORIAN_AGENT, HISTORIAN_EDITOR_AGENT } from "./agents/historian";
import {
    DREAMER_ALLOWED_TOOLS,
    DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
    HISTORIAN_ALLOWED_TOOLS,
    SIDEKICK_ALLOWED_TOOLS,
} from "./agents/permissions";
import { SIDEKICK_AGENT } from "./agents/sidekick";

/**
 * `buildHiddenAgentRegistrations` deliberately uses INLINE literals for the
 * agent ids / tool allow-lists / step caps instead of the imported module-level
 * consts — because OpenCode Desktop's concurrent per-directory cold boot can
 * leave those `var` consts undefined at config-hook time (the hoisted-function
 * call works, the const args read undefined). See the docs on
 * HiddenAgentRegistration in index.ts.
 *
 * The cost of inlining is drift: someone edits the canonical export but not the
 * inline copy. These tests are the guard — they fail if the two diverge, so the
 * inline literals stay byte-identical to the canonical constants.
 */
describe("hidden-agent registration drift guard", () => {
    const regs = buildHiddenAgentRegistrations({
        dreamerPrompt: "dreamer-prompt",
        historianPrompt: "historian-prompt",
        historianEditorPrompt: "historian-editor-prompt",
        sidekickPrompt: "sidekick-prompt",
        historianDisallowed: [],
    });
    const byId = (id: string) => regs.find((r) => r.id === id);

    test("registers hidden agents with canonical ids", () => {
        expect(regs.map((r) => r.id).sort()).toEqual(
            [
                DREAMER_AGENT,
                DREAMER_RETROSPECTIVE_AGENT,
                HISTORIAN_AGENT,
                HISTORIAN_EDITOR_AGENT,
                SIDEKICK_AGENT,
            ].sort(),
        );
    });

    test("dreamer inline allow-list matches canonical DREAMER_ALLOWED_TOOLS", () => {
        expect(byId(DREAMER_AGENT)?.allowedTools).toEqual([...DREAMER_ALLOWED_TOOLS]);
    });

    test("retrospective inline allow-list is ctx_search only", () => {
        expect(byId(DREAMER_RETROSPECTIVE_AGENT)?.allowedTools).toEqual([
            ...DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
        ]);
    });

    test("sidekick inline allow-list matches canonical SIDEKICK_ALLOWED_TOOLS", () => {
        expect(byId(SIDEKICK_AGENT)?.allowedTools).toEqual([...SIDEKICK_ALLOWED_TOOLS]);
    });

    test("historian + editor inline allow-list matches canonical HISTORIAN_ALLOWED_TOOLS (no disallowed)", () => {
        expect(byId(HISTORIAN_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
        expect(byId(HISTORIAN_EDITOR_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
    });

    test("historian disallowed_tools filter is applied to the inline allow-list", () => {
        const filtered = buildHiddenAgentRegistrations({
            dreamerPrompt: "d",
            historianPrompt: "h",
            historianEditorPrompt: "he",
            sidekickPrompt: "s",
            historianDisallowed: ["aft_search"],
        });
        const hist = filtered.find((r) => r.id === HISTORIAN_AGENT);
        expect(hist?.allowedTools).toEqual(
            HISTORIAN_ALLOWED_TOOLS.filter((t) => t !== "aft_search"),
        );
        // "*" removes everything.
        const all = buildHiddenAgentRegistrations({
            dreamerPrompt: "d",
            historianPrompt: "h",
            historianEditorPrompt: "he",
            sidekickPrompt: "s",
            historianDisallowed: ["*"],
        });
        expect(all.find((r) => r.id === HISTORIAN_AGENT)?.allowedTools).toEqual([]);
    });

    test("step caps match the documented values", () => {
        expect(byId(DREAMER_AGENT)?.maxSteps).toBe(150);
        expect(byId(DREAMER_RETROSPECTIVE_AGENT)?.maxSteps).toBe(40);
        expect(byId(HISTORIAN_AGENT)?.maxSteps).toBe(40);
        expect(byId(HISTORIAN_EDITOR_AGENT)?.maxSteps).toBe(40);
        expect(byId(SIDEKICK_AGENT)?.maxSteps).toBe(40);
    });

    test("each agent carries its passed-through prompt (undefined-safe)", () => {
        expect(byId(DREAMER_AGENT)?.prompt).toBe("dreamer-prompt");
        // Robustness contract: an undefined prompt is carried through (the config
        // hook skips that agent), not coerced.
        const noPrompts = buildHiddenAgentRegistrations({
            dreamerPrompt: undefined,
            historianPrompt: undefined,
            historianEditorPrompt: undefined,
            sidekickPrompt: undefined,
            historianDisallowed: [],
        });
        expect(noPrompts.every((r) => r.prompt === undefined)).toBe(true);
        // ...but the ids and allow-lists are STILL present (the whole point —
        // they don't depend on module-init timing).
        expect(noPrompts.map((r) => r.id).sort()).toEqual(
            [
                DREAMER_AGENT,
                DREAMER_RETROSPECTIVE_AGENT,
                HISTORIAN_AGENT,
                HISTORIAN_EDITOR_AGENT,
                SIDEKICK_AGENT,
            ].sort(),
        );
    });
});
