/**
 * Pi-side system prompt injector.
 *
 * Hooks `before_agent_start` to append a `<magic-context>` block to the
 * fully-assembled system prompt. The block carries:
 *
 *   - `<session-history>`: compartments + session facts published by
 *     historian for this Pi session (added in Step 4b.3b)
 *   - `<project-memory>`: project-scoped memories (categorized, budget-trimmed)
 *   - `<project-docs>`: dreamer-maintained ARCHITECTURE.md and STRUCTURE.md
 *     from the project root (when present)
 *
 * Cross-harness memory sharing means a memory written from OpenCode in
 * this project shows up here on the next agent turn — the
 * `<session-history>` block is similarly cross-harness consistent for
 * compartments/facts written by either OpenCode or Pi historian.
 *
 * # Where session-history goes
 *
 * OpenCode injects `<session-history>` into `message[0]` to keep it in
 * Anthropic's prompt-cache prefix (cheap to keep, expensive to rebuild).
 * Pi has no equivalent prompt-cache surface, and the system prompt is
 * itself the natural place to put always-present project context, so
 * we put `<session-history>` here alongside `<project-memory>` and
 * `<project-docs>`. Same source data, same XML shape, different
 * delivery mechanism.
 *
 * Cache stability is intentionally not a concern at this stage — Pi doesn't
 * use Anthropic-style prompt caching the same way OpenCode does. We re-read
 * docs and re-fetch memories each turn.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMagicContextSection } from "@magic-context/core/agents/magic-context-prompt";
import {
	buildCompartmentBlock,
	getCompartments,
	getSessionFacts,
} from "@magic-context/core/features/magic-context/compartment-storage";
import {
	getMemoriesByProject,
	type Memory,
} from "@magic-context/core/features/magic-context/memory";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import { renderMemoryBlock } from "@magic-context/core/hooks/magic-context/inject-compartments";
import { log } from "@magic-context/core/shared/logger";

const DOC_FILES = ["ARCHITECTURE.md", "STRUCTURE.md"] as const;

/** Approx ~4000 token budget for memories — matches OpenCode default. */
const DEFAULT_MEMORY_BUDGET_CHARS = 4000 * 3.5;

/**
 * Read project docs from `directory`. Returns the assembled XML block or null.
 */
function readProjectDocs(directory: string): string | null {
	const sections: string[] = [];

	for (const filename of DOC_FILES) {
		const filePath = join(directory, filename);
		try {
			if (existsSync(filePath)) {
				const content = readFileSync(filePath, "utf-8").trim();
				if (content.length > 0) {
					sections.push(`<${filename}>\n${content}\n</${filename}>`);
				}
			}
		} catch (error) {
			log(`[magic-context-pi] failed to read ${filename}:`, error);
		}
	}

	if (sections.length === 0) return null;
	return `<project-docs>\n${sections.join("\n\n")}\n</project-docs>`;
}

/**
 * Trim memories by total content length so the injected `<project-memory>`
 * block stays under a rough char budget. This is intentionally simpler than
 * the OpenCode-side trimming logic — the spike just proves that memories
 * appear in Pi context. Real budget math, utility tiers, and cache
 * stability can move in once the Pi-side pipeline matures.
 */
function trimMemoriesByCharBudget(
	memories: Memory[],
	budget: number,
): Memory[] {
	const sorted = [...memories].sort((a, b) => {
		// permanent first
		if (a.status === "permanent" && b.status !== "permanent") return -1;
		if (b.status === "permanent" && a.status !== "permanent") return 1;
		// shorter first (fit more)
		return a.content.length - b.content.length;
	});

	const result: Memory[] = [];
	let used = 0;
	for (const m of sorted) {
		const cost = m.content.length + 16; // rough overhead for "- " + tags amortized
		if (used + cost > budget) break;
		result.push(m);
		used += cost;
	}
	return result;
}

export interface BuildMagicContextBlockOptions {
	db: ContextDatabase;
	cwd: string;
	/**
	 * When provided, include `<session-history>` (compartments + facts) for
	 * this session. Pass undefined to skip — typically when no session is
	 * active yet (e.g. first context event before sessionManager is ready).
	 */
	sessionId?: string;
	/** When true, include `<project-memory>` in the block. */
	memoryEnabled: boolean;
	/** When true, include `<project-docs>` (reads ARCHITECTURE.md / STRUCTURE.md from cwd). */
	injectDocs: boolean;
	/** Char budget for the rendered `<project-memory>` block. */
	memoryBudgetChars?: number;
	/**
	 * When true (default), prepend the `## Magic Context` guidance section
	 * that explains `§N§` tags, `ctx_*` tools, history caveats, etc. This
	 * mirrors OpenCode's `experimental.chat.system.transform` injection.
	 *
	 * The guidance is what tells the agent NOT to mimic `§N§` prefixes in
	 * its own output, NOT to fabricate tool calls based on compressed
	 * history, and how to use `ctx_search`/`ctx_memory`/`ctx_note`.
	 * Without it, weaker models will pattern-match on stored memory
	 * content and emit `§4§ ...` at the start of responses.
	 */
	includeGuidance?: boolean;
	/**
	 * `protected_tags` from config — passed through to guidance for the
	 * "last N tags are protected" line. Only used when `ctxReduceEnabled`
	 * AND `includeGuidance` are both true.
	 */
	protectedTags?: number;
	/** When true, include `ctx_reduce` guidance; when false, the no-reduce variant. */
	ctxReduceEnabled?: boolean;
	/** When true, include smart-note guidance (Dreamer evaluates surface_condition). */
	dreamerEnabled?: boolean;
	/** When true, omit older tool-call structure caveat from guidance. */
	dropToolStructure?: boolean;
	/** When true, include temporal-awareness guidance. */
	temporalAwarenessEnabled?: boolean;
}

/**
 * Build the `<magic-context>...</magic-context>` block to append to the
 * system prompt for one Pi agent turn. Returns null if there's nothing to
 * inject.
 *
 * Block ordering: `<session-history>` first (most-narrative), then
 * `<project-memory>`, then `<project-docs>`. Mirrors OpenCode's
 * conceptual layering — recent session activity, then long-lived
 * project knowledge, then immutable structural docs.
 */
export function buildMagicContextBlock(
	opts: BuildMagicContextBlockOptions,
): string | null {
	const sections: string[] = [];

	// 1. Session history (compartments + facts) — only if we have a session id
	//    and historian has actually published something for it. Memory block
	//    is rendered separately from project-scoped memories below; we don't
	//    duplicate it inside session-history because Pi puts both in the
	//    same system prompt anyway.
	if (opts.sessionId) {
		const compartments = getCompartments(opts.db, opts.sessionId);
		const facts = getSessionFacts(opts.db, opts.sessionId);
		if (compartments.length > 0 || facts.length > 0) {
			// Pi-side rendering: compartments + facts only, no memory block,
			// no temporal date ranges. The memory block lives in the
			// `<project-memory>` section below; temporal date ranges depend
			// on OpenCode-side message timestamps we don't have for Pi.
			const block = buildCompartmentBlock(compartments, facts);
			sections.push(`<session-history>\n${block}\n</session-history>`);
		}
	}

	// 2. Project-scoped memories
	if (opts.memoryEnabled) {
		const projectIdentity = resolveProjectIdentity(opts.cwd);
		const allMemories = getMemoriesByProject(opts.db, projectIdentity);
		if (allMemories.length > 0) {
			const trimmed = trimMemoriesByCharBudget(
				allMemories,
				opts.memoryBudgetChars ?? DEFAULT_MEMORY_BUDGET_CHARS,
			);
			const memoryBlock = renderMemoryBlock(trimmed);
			if (memoryBlock) sections.push(memoryBlock);
		}
	}

	// 3. Project docs (ARCHITECTURE.md / STRUCTURE.md)
	if (opts.injectDocs) {
		const docsBlock = readProjectDocs(opts.cwd);
		if (docsBlock) sections.push(docsBlock);
	}

	// Build the data block (compartments + memory + docs) and the guidance
	// section separately, then concatenate. We always emit guidance when
	// requested (default true) — even if the data block is empty — because
	// the guidance is what teaches the agent how to use ctx_search /
	// ctx_memory / ctx_note even when those tools have no project data
	// to operate on yet. This mirrors OpenCode's behavior, where the
	// guidance is always injected via experimental.chat.system.transform.
	const dataBlock =
		sections.length > 0
			? `<magic-context>\n${sections.join("\n\n")}\n</magic-context>`
			: null;

	const includeGuidance = opts.includeGuidance ?? true;
	if (!includeGuidance) {
		return dataBlock;
	}

	// `agent` argument is null because Pi doesn't have OpenCode's named
	// agent system (sisyphus, atlas, hephaestus, oracle, athena, ...). The
	// generic guidance section applies — same fallback OpenCode uses for
	// unrecognized agents.
	const guidance = buildMagicContextSection(
		null,
		opts.protectedTags ?? 20,
		opts.ctxReduceEnabled ?? true,
		opts.dreamerEnabled ?? false,
		opts.dropToolStructure ?? true,
		opts.temporalAwarenessEnabled ?? false,
	);

	if (dataBlock) {
		return `${guidance}\n\n${dataBlock}`;
	}
	return guidance;
}
