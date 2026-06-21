import { applyDisallowedTools, buildAllowOnlyPermission } from "./permissions";

/**
 * Hidden-agent registration builders.
 *
 * # Why this lives in its own module (NOT in the plugin entry `index.ts`)
 *
 * OpenCode loads a plugin module and, for the legacy plugin shape (a function
 * `default` export rather than a `{ server, tui }` object), treats EVERY
 * exported function in that module as a plugin factory and invokes it with the
 * plugin input `{ client, directory, ... }` (see opencode
 * `plugin/index.ts` → `getLegacyPlugins`). magic-context uses that legacy shape.
 *
 * If `buildHiddenAgentRegistrations` is exported from the entry module it gets
 * called by the loader as `buildHiddenAgentRegistrations(pluginInput)` — with
 * the wrong argument — so `args.historianDisallowed` is `undefined` and
 * `applyDisallowedTools([...], undefined)` throws
 * `undefined is not an object (evaluating 'disallowed.includes')`, which fails
 * the WHOLE plugin load. Keeping these helpers out of the entry module means the
 * entry module's only export is `default` (the real plugin factory); these
 * builders are still bundled (inlined) into `dist/index.js`, just never treated
 * as plugin factories.
 */

// Clamp a user-provided step override to the hidden-agent's built-in cap (loop
// insurance — see buildHiddenAgentConfig). Caps live as inline literals in
// buildHiddenAgentRegistrations (historian/sidekick=40, dreamer=150): a handful
// of tool calls for the historian/sidekick, a real multi-step maintenance loop
// for the dreamer.
function clampHiddenAgentStepLimit(value: unknown, cap: number): number {
    return typeof value === "number" && Number.isFinite(value) ? Math.min(value, cap) : cap;
}

/**
 * Static registration data for one hidden agent. The id / allow-list / step cap
 * are INLINE LITERALS in {@link buildHiddenAgentRegistrations} rather than
 * cross-module `const` imports.
 *
 * # Why inline
 *
 * Belt-and-suspenders, not the load-bearing fix. The load failure was caused by
 * exporting helpers from the entry module (see the module header) — that is what
 * the entry-only-`default` rule fixes. Inlining the small id/tool/step values
 * additionally removes any dependency on cross-module top-level `const` init
 * timing, so this builder returns a complete, valid registration set the instant
 * it is called regardless of module-evaluation order. Cheap insurance for a path
 * that runs once per plugin-instance boot.
 *
 * The only value that cannot be inlined is the multi-KB generated system prompt;
 * it stays a module `var` and is guarded at the call site (skip the agent + log
 * if undefined, never register a broken/deny-all agent).
 *
 * `agent-registration-drift.test.ts` asserts the inline literals here stay
 * byte-identical to the canonical exported constants so they can't silently
 * diverge.
 */
export interface HiddenAgentRegistration {
    id: string;
    prompt: string | undefined;
    allowedTools: readonly string[];
    maxSteps: number;
    overrides?: Record<string, unknown>;
}

/**
 * Hoisted function declaration: returns the four hidden-agent registrations with
 * INLINE id / allow-list / step-cap literals (see {@link HiddenAgentRegistration}
 * for why these must not come from module-level `var` consts). Prompts and
 * computed overrides are passed in by the caller; the historian disallow filter
 * is applied here against an inline default allow-list.
 */
export function buildHiddenAgentRegistrations(args: {
    dreamerPrompt: string | undefined;
    historianPrompt: string | undefined;
    historianEditorPrompt: string | undefined;
    sidekickPrompt: string | undefined;
    dreamerOverrides?: Record<string, unknown>;
    historianOverrides?: Record<string, unknown>;
    sidekickOverrides?: Record<string, unknown>;
    historianDisallowed: readonly string[];
}): HiddenAgentRegistration[] {
    const historianAllowedTools = applyDisallowedTools(
        ["read", "aft_outline", "aft_zoom", "aft_search"],
        args.historianDisallowed,
    );
    return [
        {
            id: "dreamer",
            prompt: args.dreamerPrompt,
            allowedTools: [
                "read",
                "grep",
                "glob",
                "bash",
                "write",
                "edit",
                "aft_outline",
                "aft_zoom",
                "aft_search",
                "ctx_memory",
                "ctx_search",
                "ctx_note",
            ],
            // The dreamer is a genuine multi-step maintenance loop (~60-72 model
            // turns observed), so it needs a high cap.
            maxSteps: 150,
            overrides: args.dreamerOverrides,
        },
        {
            id: "dreamer-retrospective",
            prompt: args.dreamerPrompt,
            allowedTools: ["ctx_search"],
            maxSteps: 40,
            overrides: args.dreamerOverrides,
        },
        {
            id: "historian",
            prompt: args.historianPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "historian-editor",
            prompt: args.historianEditorPrompt,
            allowedTools: historianAllowedTools,
            maxSteps: 40,
            overrides: args.historianOverrides,
        },
        {
            id: "sidekick",
            prompt: args.sidekickPrompt,
            allowedTools: ["ctx_search", "aft_outline", "aft_zoom"],
            maxSteps: 40,
            overrides: args.sidekickOverrides,
        },
    ];
}

/**
 * Build a hidden-agent config with a deny-everything-by-default permission
 * baseline and a hard tool-iteration ceiling. User overrides may lower
 * `steps`/`maxSteps`, but cannot raise either above the built-in cap.
 */
export function buildHiddenAgentConfig(
    prompt: string,
    allowedTools: readonly string[],
    maxSteps: number,
    overrides?: Record<string, unknown>,
    agentLabel?: string,
) {
    const { permission: overridePermission, ...restOverrides } = (overrides ?? {}) as {
        permission?: Record<string, unknown>;
        [key: string]: unknown;
    };
    const basePermission = buildAllowOnlyPermission(allowedTools, agentLabel);
    return {
        prompt,
        // No builtin fallback chain: the user's `fallback_models` (if any) flow
        // through `restOverrides`. A hardcoded chain names providers the user may
        // not have, producing `Model not found` retry storms.
        ...restOverrides,
        steps: clampHiddenAgentStepLimit(restOverrides.steps, maxSteps),
        maxSteps: clampHiddenAgentStepLimit(restOverrides.maxSteps, maxSteps),
        // Permission baseline goes after `restOverrides` so that accidental
        // `permission` keys in user overrides we DIDN'T explicitly destructure
        // can't bypass the deny. The explicit override (destructured above) is
        // then layered on top.
        permission: {
            ...basePermission,
            ...(overridePermission ?? {}),
        },
        mode: "subagent" as const,
        hidden: true,
    };
}
