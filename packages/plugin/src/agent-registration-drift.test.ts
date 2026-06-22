import { describe, expect, test } from "bun:test";
import { DREAMER_AGENT, DREAMER_RETROSPECTIVE_AGENT } from "./agents/dreamer";
import {
    buildHiddenAgentConfig,
    buildHiddenAgentRegistrations,
} from "./agents/hidden-agent-registrations";
import {
    HISTORIAN_AGENT,
    HISTORIAN_EDITOR_AGENT,
    HISTORIAN_RECOMP_AGENT,
} from "./agents/historian";
import {
    DREAMER_ALLOWED_TOOLS,
    DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
    HISTORIAN_ALLOWED_TOOLS,
    SIDEKICK_ALLOWED_TOOLS,
    SMART_NOTE_COMPILER_ALLOWED_TOOLS,
} from "./agents/permissions";
import { SIDEKICK_AGENT } from "./agents/sidekick";
import { SMART_NOTE_COMPILER_AGENT } from "./agents/smart-note-compiler";

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
        historianRecompPrompt: "historian-recomp-prompt",
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
                SMART_NOTE_COMPILER_AGENT,
                HISTORIAN_AGENT,
                HISTORIAN_EDITOR_AGENT,
                HISTORIAN_RECOMP_AGENT,
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

    test("smart-note compiler has no tools and locked permissions", () => {
        expect(byId(SMART_NOTE_COMPILER_AGENT)?.allowedTools).toEqual([
            ...SMART_NOTE_COMPILER_ALLOWED_TOOLS,
        ]);
        expect(byId(SMART_NOTE_COMPILER_AGENT)?.lockPermissions).toBe(true);
    });

    test("only privacy/security-critical agents lock permissions", () => {
        for (const reg of regs) {
            expect(reg.lockPermissions === true).toBe(
                reg.id === DREAMER_RETROSPECTIVE_AGENT || reg.id === SMART_NOTE_COMPILER_AGENT,
            );
        }
    });

    test("a user dreamer permission override cannot broaden the retrospective agent", () => {
        // Simulate a user dreamer config that tries to grant bash/ctx_memory.
        const cfg = buildHiddenAgentConfig(
            "prompt",
            DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
            40,
            { permission: { bash: "allow", ctx_memory: "allow", edit: "allow" } },
            DREAMER_RETROSPECTIVE_AGENT,
            true,
        ) as { permission: Record<string, string> };
        expect(cfg.permission.bash).not.toBe("allow");
        expect(cfg.permission.ctx_memory).not.toBe("allow");
        expect(cfg.permission.edit).not.toBe("allow");
        expect(cfg.permission.ctx_search).toBe("allow");
    });

    test("a user dreamer tools override cannot re-enable a tool on the locked agent", () => {
        const cfg = buildHiddenAgentConfig(
            "prompt",
            DREAMER_RETROSPECTIVE_ALLOWED_TOOLS,
            40,
            { tools: { bash: true, edit: true, ctx_memory: true } },
            DREAMER_RETROSPECTIVE_AGENT,
            true,
        ) as { tools?: Record<string, boolean> };
        // The user `tools` map is dropped entirely under lockPermissions.
        expect(cfg.tools).toBeUndefined();
    });

    test("an UNLOCKED agent keeps its user tools override", () => {
        const cfg = buildHiddenAgentConfig(
            "prompt",
            ["ctx_search", "ctx_memory"],
            40,
            { tools: { aft_search: false } },
            DREAMER_AGENT,
            false,
        ) as { tools?: Record<string, boolean> };
        expect(cfg.tools).toEqual({ aft_search: false });
    });

    test("sidekick inline allow-list matches canonical SIDEKICK_ALLOWED_TOOLS", () => {
        expect(byId(SIDEKICK_AGENT)?.allowedTools).toEqual([...SIDEKICK_ALLOWED_TOOLS]);
    });

    test("historian + editor inline allow-list matches canonical HISTORIAN_ALLOWED_TOOLS (no disallowed)", () => {
        expect(byId(HISTORIAN_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
        expect(byId(HISTORIAN_RECOMP_AGENT)?.allowedTools).toEqual([...HISTORIAN_ALLOWED_TOOLS]);
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
        expect(byId(SMART_NOTE_COMPILER_AGENT)?.maxSteps).toBe(8);
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
                SMART_NOTE_COMPILER_AGENT,
                HISTORIAN_AGENT,
                HISTORIAN_EDITOR_AGENT,
                HISTORIAN_RECOMP_AGENT,
                SIDEKICK_AGENT,
            ].sort(),
        );
    });
});
