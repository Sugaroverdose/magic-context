import type { DreamingTask } from "../../../config/schema/magic-context";
import type { MaintainMemoryPromptMemory } from "./maintain-memory-gate";

// ── System Prompt ──────────────────────────────────────────────────────────

export const DREAMER_SYSTEM_PROMPT = `You are a memory maintenance agent for the magic-context system.
You run during scheduled dream windows to maintain a project's cross-session memory store and codebase documentation.

## Available Tools

**Memory operations** (ctx_memory with extended dreamer actions):
- \`action="list"\` — browse all active memories, optionally filter by category
- \`action="update", ids=[N], content="..."\` — rewrite a memory's content
- \`action="merge", ids=[N,M,...], content="...", category="..."\` — consolidate duplicates into one canonical memory
- \`action="archive", ids=[N], reason="..."\` — remove a stale memory (soft-archive, with provenance)
- \`action="write", category="...", content="..."\` — create a new memory
- \`action="verified", ids=[N], files=[...]\` — record the COMPLETE current backing-file set after checking a memory; use \`files=[]\` only for file-independent memories

**Codebase tools** (standard OpenCode tools):
- Read files, grep, glob, bash — for verification against actual code

## Rules

1. **Work methodically.** Decide your own batch size based on the task — process as many items per round as makes sense.
2. **Always verify against actual files** before declaring a memory stale or updating it.
3. **Be conservative with archives.** Only archive when the codebase clearly contradicts the memory.
4. **Explain reasoning briefly** before each action — one line is enough.
5. **Use present-tense operational language** in all memory rewrites. "X uses Y" not "X was changed to use Y."
6. **One rule/fact per memory.** Split compound memories during improvement.
7. **Never read or quote secrets** from .env, credentials, keys, or similar sensitive files.
8. **Do not commit changes.** The user handles git operations.

## Memory Taxonomy (5 categories)

Project memory uses exactly 5 categories. Every memory belongs to one:
- **PROJECT_RULES** — durable process/workflow rules for this repo (releases, commits, testing, debugging conventions).
- **ARCHITECTURE** — load-bearing design decisions and WHY they hold (not WHAT a file does).
- **CONSTRAINTS** — hard limits imposed by EXTERNAL systems (APIs, providers, platforms, protocols). Not our own code's behavior.
- **CONFIG_VALUES** — stable configuration keys/values and conventions. Not transient measurements (test counts, sizes, versions).
- **NAMING** — naming conventions and canonical names. Not inventories.

**Legacy categories during transition:** older memories may still carry pre-v2 category names. When you touch one, map it to its 5-category home with \`action="update"\` (or \`merge\`): WORKFLOW_RULES→PROJECT_RULES, ARCHITECTURE_DECISIONS→ARCHITECTURE, CONFIG_DEFAULTS→CONFIG_VALUES, ENVIRONMENT→CONFIG_VALUES (paths) or CONSTRAINTS, KNOWN_ISSUES→CONSTRAINTS only if it's an external-system limit (otherwise archive — our own fixed bugs are not world facts). USER_DIRECTIVES / USER_PREFERENCES are NOT project categories — they live in the global user profile; archive project copies only when they add zero project-specific detail.`;

// ── Consolidate ────────────────────────────────────────────────────────────

export function buildConsolidatePrompt(projectPath: string): string {
    return `## Task: Consolidate Duplicate Memories

**Project:** ${projectPath}

### Goal
Find semantically duplicate or overlapping memories and merge each cluster into one canonical memory.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Group by category first**, then scan within each category for:
   - Near-identical wording (e.g. "Use SQLite for memory" vs "Use SQLite for persistent memory")
   - Same fact stated from different angles
   - Superset/subset pairs where one memory contains everything the other says
3. **For each duplicate cluster**, decide on one canonical wording that:
   - Preserves all unique information from the cluster
   - Uses terse present-tense operational language
   - Keeps file paths, config keys, and values verbatim when they matter
4. **Merge** with \`ctx_memory(action="merge", ids=[...], content="...", category="...")\`.
5. **Do NOT merge across categories** — e.g. a PROJECT_RULES entry and a CONSTRAINTS entry may look similar but serve different purposes.

### What makes a good canonical memory
- One fact per memory. If a merged result has two distinct rules, write one memory and create a second with \`action="write"\`.
- Present tense: "Historian uses raw OpenCode message ordinals" not "We switched historian to raw ordinals."
- Drop session-local context: "in this session", "after the refactor", "commit abc123" — unless the commit hash itself is the point.

### Success criteria
- No two active memories in the same category say essentially the same thing.
- Merged memories are terse and actionable.
- Archive provenance is recorded (merge tracks source IDs).`;
}

// ── Verify ─────────────────────────────────────────────────────────────────

export function buildVerifyPrompt(projectPath: string): string {
    return `## Task: Verify Memories Against Codebase

**Project:** ${projectPath}

### Goal
Check verifiable memories against actual repository state. Update stale wording, archive memories that are no longer true.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Categorize by verifiability:**
   - **CONFIG_VALUES**: grep schema/config files for actual values/defaults
   - **ARCHITECTURE**: check if referenced files, functions, modules still exist
   - **NAMING**: check if naming conventions match actual code
   - **CONSTRAINTS**: external-system limits — verify the limit still holds if it references our integration code; otherwise leave alone
   - **PROJECT_RULES**: verify only if they reference specific files or tools
3. **For each verifiable memory:**
   - Read the actual file or grep for the pattern
   - If the memory is correct: leave it alone
   - If the wording is stale but the fact is true: \`ctx_memory(action="update", ids=[N], content="corrected wording")\`
   - If the memory is clearly wrong: \`ctx_memory(action="archive", ids=[N], reason="...")\`
4. **Be conservative.** If you cannot find the referenced code but it might be in a location you haven't checked, do NOT archive. Move on.

### Verification examples
- Memory: "history_budget_percentage defaults to 0.15" → grep schema for \`history_budget_percentage\`, check \`.default(...)\`
- Memory: "Durable state lives in ~/.local/share/opencode/storage/plugin/magic-context/context.db" → check storage-db.ts for the path construction
- Memory: "ctx_search searches memories, facts, and history" → grep for ctx_search tool definition and unified search implementation

### Success criteria
- All CONFIG_VALUES memories match actual schema defaults.
- No memories reference files or paths that no longer exist.
- Updated memories use current naming and paths.`;
}

// ── Archive Stale ──────────────────────────────────────────────────────────

export function buildArchiveStalePrompt(
    projectPath: string,
    userMemories?: Array<{ id: number; content: string }>,
): string {
    const userProfileBlock =
        userMemories && userMemories.length > 0
            ? `
### Global User Profile (already injected into ALL sessions across ALL projects)
These user memories are ALREADY available to the agent globally. Project memories that merely restate the same preference/rule are redundant and should be archived — but ONLY if the project memory adds ZERO project-specific detail beyond what the global memory already says.

${userMemories.map((um) => `- [U${um.id}] ${um.content}`).join("\n")}
`
            : "";

    return `## Task: Archive Stale Memories

**Project:** ${projectPath}

### Goal
Find and archive memories that waste the limited injection budget (~6000 tokens, fits ~150 memories).
${userProfileBlock}
### Archive criteria (archive IF any apply)

1. **Code restatement without rationale** — merely describes what code does without explaining WHY or what would break if changed.
   - Archive: "Tag assignment uses one DB transaction" (obvious from code)
   - Keep: "Tag assignment uses one DB transaction because tags rows and session_meta.counter must stay in sync" (explains the constraint)

2. **Redundant with other memories** — same information expressed differently. Keep the better-worded one.

3. **Stale implementation detail** — references specific functions, line numbers, or internal structures that change frequently and are better found by reading code.
   - Archive: "Function X is called at line 289 of file Y"
   - Keep: "Feature X requires Y to be initialized before Z" (design constraint)

4. **Low retrieval signal** — seen_count=1, retrieval_count=0, and no constraint language. These were promoted once but never needed again.

5. **Redundant with global user profile** — ONLY if the project memory adds ZERO project-specific detail beyond what the global memory already says. A project memory that applies a global principle to a specific context (e.g., "cache awareness is highest priority" applies a general principle to THIS project's north star) is NOT redundant — it narrows the global principle.

6. **Bare config values** — single-line values like \`enabled=true\` or \`experimental.X=false\` with no surrounding explanation or rationale.

7. **Transient measurements** — test counts, binary sizes, benchmark numbers, or dependency versions that change every build. These are not CONFIG_VALUES.

8. **Solved internal bugs** — descriptions of bugs in OUR OWN code that have been fixed. A fixed bug is not a durable world fact. (External-system limits we must respect ARE CONSTRAINTS — keep those.)

### Keep criteria (keep IF ANY apply — these OVERRIDE archive criteria)

1. **Contains constraint/rule** — uses "must", "never", "always", "cannot", "should not". CONSTRAINTS category gets extra protection: only archive if the EXACT same constraint exists word-for-word in another memory.
2. **Captures non-obvious design reasoning** — explains WHY, not just WHAT. Look for "because", "so that", "to prevent", "to avoid".
3. **Project-specific process rule** — a PROJECT_RULES entry about how to work in this repo. Only archive if (a) clearly obsolete, or (b) 100% identical in scope to a global user memory.
4. **External-system limit** — a CONSTRAINTS entry about an API/provider/platform/protocol the project must respect. These prevent re-hitting an external limit.
5. **Path/config information with context** — saves agent from hunting for locations; prevents wrong assumptions. Archive ONLY bare values with no surrounding explanation.
6. **High retrieval signal** — retrieval_count > 0 means the agent actually searched for this.
9. **Priority/philosophy statements** — "X is the highest priority" or "north star" type directives that shape all decisions.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Apply the archive and keep criteria above to each memory.**
3. **Verify each candidate** against the codebase before archiving:
   - Check if the file/tool/path actually exists
   - For CONFIG_VALUES: confirm the value isn't a transient measurement
   - If the reference is ambiguous, leave it alone
4. **Archive** with \`ctx_memory(action="archive", ids=[N], reason="...")\`. Always include a specific reason.

### Category-specific rules
- **CONSTRAINTS**: archive ONLY when provably redundant with another specific constraint (not just thematically similar), OR when it describes an OUR-OWN-code bug that is fixed (not an external limit). Each genuine external constraint guards against a real limit — losing it means re-hitting it.
- **PROJECT_RULES**: archive obsolete process rules or exact duplicates of global user profile entries. Keep ongoing workflow rules even at low retrieval.
- **ARCHITECTURE**: archive code restatements freely, keep anything with "because", "so that", "to prevent", "to avoid".
- **CONFIG_VALUES**: archive bare values with no context and transient measurements (test counts, sizes, versions); keep values that include rationale or prevent wrong assumptions.
- **NAMING**: keep conventions; archive one-off inventories of tools/components.

### Success criteria
- No active memories reference non-existent files, tools, or paths.
- No transient measurements remain in CONFIG_VALUES.
- ARCHITECTURE contains design reasoning, not code restatements.
- CONSTRAINTS describe external-system limits, not solved internal bugs.
- Every archived memory has a specific reason.
- Conservative — when in doubt, leave it active.`;
}

// ── Improve ────────────────────────────────────────────────────────────────

export function buildImprovePrompt(projectPath: string): string {
    return `## Task: Improve Memory Quality

**Project:** ${projectPath}

### Goal
Rewrite verbose, narrative, or poorly-structured memories into terse operational statements.

### Process

1. **List all active memories** with \`ctx_memory(action="list")\`.
2. **Identify improvement candidates:**
   - Narrative/historical wording: "We decided to..." → "X uses Y because Z"
   - Compound memories with multiple unrelated facts → split into separate memories
   - Vague memories without file paths or specifics → add paths if you can find them, or archive if meaningless
   - Session-local language: "in this session", "after the refactor" → remove temporal context
   - Redundant qualifiers: "It's important to note that..." → drop
3. **Rewrite** with \`ctx_memory(action="update", ids=[N], content="...")\`.
4. **Split compound memories:** ONLY when one existing memory genuinely conflates two UNRELATED facts, repurpose it — \`action="update"\` it down to the first fact and \`action="write"\` the second. This is the ONLY situation where \`improve\` writes a new memory.

### \`write\` is for splits only
\`improve\` is a CLEANUP pass: it rewrites and tightens existing memories. It does NOT mint brand-new standalone facts — discovering and recording new facts is the historian's job, not improve's. The only \`write\` you may do is the second half of a genuine split (step 4). If you find yourself writing a new memory that is not the leftover half of a memory you just split, STOP — that fact does not belong here. A healthy improve run is net-neutral or net-shrinking: it should never add many new memories while archiving none.

### Good memory format
\`\`\`
Category: CONFIG_VALUES
Content: execute_threshold_percentage defaults to 65 and accepts a scalar or { default, <model-key> } map for per-model overrides.
\`\`\`

### Bad memory format (before improvement)
\`\`\`
Category: CONFIG_VALUES
Content: We changed the execute threshold to be configurable in the session where we were working on per-model thresholds. It was originally hardcoded at 65% but now accepts either a number or a map.
\`\`\`

### Rules
- Present tense, operational voice: "X does Y" not "X was changed to do Y"
- Keep file paths, function names, config keys verbatim
- Drop commit hashes unless the hash itself is the memory's point
- One fact per memory. Two facts = two memories.

### Success criteria
- No memories use narrative/historical language.
- No compound memories with unrelated facts.
- All memories are terse and directly actionable.
- The active pool did not GROW: any \`write\` is matched by the split it came from (the original memory was updated down to its first fact). improve never net-adds new facts.`;
}

function formatMaintainMemoryList(memories: MaintainMemoryPromptMemory[]): string {
    if (memories.length === 0) return "No in-scope memories.";
    return memories
        .map((memory) => {
            const files =
                memory.mappedFiles.length > 0
                    ? memory.mappedFiles.map((file) => `  - ${file}`).join("\n")
                    : "  - (none recorded; if this is truly file-independent, record files=[])";
            const verified = memory.verifiedAt
                ? new Date(memory.verifiedAt).toISOString()
                : "never";
            return `[${memory.id}] ${memory.category}\nContent: ${memory.content}\nPreviously verified: ${verified}${memory.hasNoFileSentinel ? " (has no-file sentinel)" : ""}\nMapped files to re-check / preserve as complete set:\n${files}`;
        })
        .join("\n\n");
}

function formatUserProfileBlock(userMemories?: Array<{ id: number; content: string }>): string {
    if (!userMemories || userMemories.length === 0) return "";
    return `
### Global User Profile (already injected into ALL sessions across ALL projects)
These user memories are ALREADY available to the agent globally. Project memories that merely restate the same preference/rule are redundant and should be archived — but ONLY if the project memory adds ZERO project-specific detail beyond what the global memory already says.

${userMemories.map((um) => `- [U${um.id}] ${um.content}`).join("\n")}
`;
}

export function buildMaintainMemoryPrompt(args: {
    projectPath: string;
    memories: MaintainMemoryPromptMemory[];
    mode: "non-git" | "full" | "broad" | "incremental";
    reason: string;
    skippedCount: number;
    userMemories?: Array<{ id: number; content: string }>;
}): string {
    const broadNote =
        args.mode === "broad"
            ? "This is a broad pass: all memories are in scope. Also do cross-memory deduplication that the file gate cannot trigger."
            : "This is an incremental pass: only the memories below are in scope. Do not spend time on skipped memories unless needed to safely merge with an in-scope memory.";

    // v1 — pending replay-harness optimization
    return `## Task: Maintain Memory

**Project:** ${args.projectPath}
**Mode:** ${args.mode} — ${args.reason}
**In-scope memories:** ${args.memories.length}
**Skipped by file gate:** ${args.skippedCount}

${broadNote}
${formatUserProfileBlock(args.userMemories)}
### In-scope memory set

${formatMaintainMemoryList(args.memories)}

### CRITICAL verification recording contract

Every in-scope memory must end this run with deterministic coverage: either it is no longer active (archived/superseded/deleted), or it has a fresh side-table verification row. After handling a memory, record the COMPLETE current backing-file set:

- Correct and unchanged: \`ctx_memory(action="verified", ids=[N], files=["path/one.ts", "path/two.ts"])\`
- File-independent memory: \`ctx_memory(action="verified", ids=[N], files=[])\`
- Updated memory: include \`verified_files=[...]\` on the \`update\` call.
- Archived memory: include \`verified_files=[...]\` on the \`archive\` call when you have just verified the stale backing files.

\`files\` / \`verified_files\` is the FULL dependency set after verification, not just files that changed this run. Include unchanged files that still support the memory. If a memory previously mapped to [a,b] and only a changed, but b still supports it, record [a,b]. Use [] only when the memory is genuinely file-independent.

### Phase order (one pass over the in-scope memories)

Run these phases in order: **verify → consolidate → improve → archive-stale**.

## Phase 1 — Verify memories against codebase

### Goal
Check verifiable memories against actual repository state. Update stale wording, archive memories that are no longer true.

### Process

1. Use the in-scope list above instead of listing the whole pool.
2. **Categorize by verifiability:**
   - **CONFIG_VALUES**: grep schema/config files for actual values/defaults
   - **ARCHITECTURE**: check if referenced files, functions, modules still exist
   - **NAMING**: check if naming conventions match actual code
   - **CONSTRAINTS**: external-system limits — verify the limit still holds if it references our integration code; otherwise leave alone
   - **PROJECT_RULES**: verify only if they reference specific files or tools
3. **For each verifiable memory:**
   - Read the actual file or grep for the pattern
   - If the memory is correct: leave it alone and call \`ctx_memory(action="verified", ids=[N], files=[...COMPLETE backing set...])\`
   - If the wording is stale but the fact is true: \`ctx_memory(action="update", ids=[N], content="corrected wording", verified_files=[...COMPLETE backing set...])\`
   - If the memory is clearly wrong: \`ctx_memory(action="archive", ids=[N], reason="...", verified_files=[...COMPLETE backing set you checked...])\`
4. **Be conservative.** If you cannot find the referenced code but it might be in a location you haven't checked, do NOT archive. Move on, and record the best complete backing set you verified (or [] only if file-independent).

### Verification examples
- Memory: "history_budget_percentage defaults to 0.15" → grep schema for \`history_budget_percentage\`, check \`.default(...)\`
- Memory: "Durable state lives in ~/.local/share/opencode/storage/plugin/magic-context/context.db" → check storage-db.ts for the path construction
- Memory: "ctx_search searches memories, facts, and history" → grep for ctx_search tool definition and unified search implementation

### Success criteria
- All CONFIG_VALUES memories match actual schema defaults.
- No memories reference files or paths that no longer exist.
- Updated memories use current naming and paths.

## Phase 2 — Consolidate duplicate memories

### Goal
Find semantically duplicate or overlapping memories and merge each cluster into one canonical memory.

### Process

1. **Group by category first**, then scan within each category for:
   - Near-identical wording (e.g. "Use SQLite for memory" vs "Use SQLite for persistent memory")
   - Same fact stated from different angles
   - Superset/subset pairs where one memory contains everything the other says
2. **For each duplicate cluster**, decide on one canonical wording that:
   - Preserves all unique information from the cluster
   - Uses terse present-tense operational language
   - Keeps file paths, config keys, and values verbatim when they matter
3. **Merge** with \`ctx_memory(action="merge", ids=[...], content="...", category="...")\`.
4. **Do NOT merge across categories** — e.g. a PROJECT_RULES entry and a CONSTRAINTS entry may look similar but serve different purposes.
5. If the canonical memory remains active and was in scope, record \`verified\` for it after the merge with the complete backing-file set.

### What makes a good canonical memory
- One fact per memory. If a merged result has two distinct rules, write one memory and create a second with \`action="write"\`.
- Present tense: "Historian uses raw OpenCode message ordinals" not "We switched historian to raw ordinals."
- Drop session-local context: "in this session", "after the refactor", "commit abc123" — unless the commit hash itself is the point.

### Success criteria
- No two active memories in the same category say essentially the same thing.
- Merged memories are terse and actionable.
- Archive provenance is recorded (merge tracks source IDs).

## Phase 3 — Improve memory quality

### Goal
Rewrite verbose, narrative, or poorly-structured memories into terse operational statements.

### Process

1. **Identify improvement candidates:**
   - Narrative/historical wording: "We decided to..." → "X uses Y because Z"
   - Compound memories with multiple unrelated facts → split into separate memories
   - Vague memories without file paths or specifics → add paths if you can find them, or archive if meaningless
   - Session-local language: "in this session", "after the refactor" → remove temporal context
   - Redundant qualifiers: "It's important to note that..." → drop
2. **Rewrite** with \`ctx_memory(action="update", ids=[N], content="...", verified_files=[...COMPLETE backing set...])\`.
3. **Split compound memories:** ONLY when one existing memory genuinely conflates two UNRELATED facts, repurpose it — \`action="update"\` it down to the first fact and \`action="write"\` the second. This is the ONLY situation where \`improve\` writes a new memory.

### \`write\` is for splits only
\`improve\` is a CLEANUP pass: it rewrites and tightens existing memories. It does NOT mint brand-new standalone facts — discovering and recording new facts is the historian's job, not improve's. The only \`write\` you may do is the second half of a genuine split (step 3). If you find yourself writing a new memory that is not the leftover half of a memory you just split, STOP — that fact does not belong here. A healthy improve run is net-neutral or net-shrinking: it should never add many new memories while archiving none.

### Good memory format
\`\`\`
Category: CONFIG_VALUES
Content: execute_threshold_percentage defaults to 65 and accepts a scalar or { default, <model-key> } map for per-model overrides.
\`\`\`

### Bad memory format (before improvement)
\`\`\`
Category: CONFIG_VALUES
Content: We changed the execute threshold to be configurable in the session where we were working on per-model thresholds. It was originally hardcoded at 65% but now accepts either a number or a map.
\`\`\`

### Rules
- Present tense, operational voice: "X does Y" not "X was changed to do Y"
- Keep file paths, function names, config keys verbatim
- Drop commit hashes unless the hash itself is the memory's point
- One fact per memory. Two facts = two memories.

### Success criteria
- No memories use narrative/historical language.
- No compound memories with unrelated facts.
- All memories are terse and directly actionable.
- The active pool did not GROW: any \`write\` is matched by the split it came from (the original memory was updated down to its first fact). improve never net-adds new facts.

## Phase 4 — Archive stale memories

### Goal
Find and archive memories that waste the limited injection budget (~6000 tokens, fits ~150 memories).

### Archive criteria (archive IF any apply)

1. **Code restatement without rationale** — merely describes what code does without explaining WHY or what would break if changed.
   - Archive: "Tag assignment uses one DB transaction" (obvious from code)
   - Keep: "Tag assignment uses one DB transaction because tags rows and session_meta.counter must stay in sync" (explains the constraint)

2. **Redundant with other memories** — same information expressed differently. Keep the better-worded one.

3. **Stale implementation detail** — references specific functions, line numbers, or internal structures that change frequently and are better found by reading code.
   - Archive: "Function X is called at line 289 of file Y"
   - Keep: "Feature X requires Y to be initialized before Z" (design constraint)

4. **Low retrieval signal** — seen_count=1, retrieval_count=0, and no constraint language. These were promoted once but never needed again.

5. **Redundant with global user profile** — ONLY if the project memory adds ZERO project-specific detail beyond what the global memory already says. A project memory that applies a global principle to a specific context (e.g., "cache awareness is highest priority" applies a general principle to THIS project's north star) is NOT redundant — it narrows the global principle.

6. **Bare config values** — single-line values like \`enabled=true\` or \`experimental.X=false\` with no surrounding explanation or rationale.

7. **Transient measurements** — test counts, binary sizes, benchmark numbers, or dependency versions that change every build. These are not CONFIG_VALUES.

8. **Solved internal bugs** — descriptions of bugs in OUR OWN code that have been fixed. A fixed bug is not a durable world fact. (External-system limits we must respect ARE CONSTRAINTS — keep those.)

### Keep criteria (keep IF ANY apply — these OVERRIDE archive criteria)

1. **Contains constraint/rule** — uses "must", "never", "always", "cannot", "should not". CONSTRAINTS category gets extra protection: only archive if the EXACT same constraint exists word-for-word in another memory.
2. **Captures non-obvious design reasoning** — explains WHY, not just WHAT. Look for "because", "so that", "to prevent", "to avoid".
3. **Project-specific process rule** — a PROJECT_RULES entry about how to work in this repo. Only archive if (a) clearly obsolete, or (b) 100% identical in scope to a global user memory.
4. **External-system limit** — a CONSTRAINTS entry about an API/provider/platform/protocol the project must respect. These prevent re-hitting an external limit.
5. **Path/config information with context** — saves agent from hunting for locations; prevents wrong assumptions. Archive ONLY bare values with no surrounding explanation.
6. **High retrieval signal** — retrieval_count > 0 means the agent actually searched for this.
9. **Priority/philosophy statements** — "X is the highest priority" or "north star" type directives that shape all decisions.

### Process

1. **Apply the archive and keep criteria above to each memory.**
2. **Verify each candidate** against the codebase before archiving:
   - Check if the file/tool/path actually exists
   - For CONFIG_VALUES: confirm the value isn't a transient measurement
   - If the reference is ambiguous, leave it alone
3. **Archive** with \`ctx_memory(action="archive", ids=[N], reason="...", verified_files=[...COMPLETE backing set checked...])\`. Always include a specific reason.

### Category-specific rules
- **CONSTRAINTS**: archive ONLY when provably redundant with another specific constraint (not just thematically similar), OR when it describes an OUR-OWN-code bug that is fixed (not an external limit). Each genuine external constraint guards against a real limit — losing it means re-hitting it.
- **PROJECT_RULES**: archive obsolete process rules or exact duplicates of global user profile entries. Keep ongoing workflow rules even at low retrieval.
- **ARCHITECTURE**: archive code restatements freely, keep anything with "because", "so that", "to prevent", "to avoid".
- **CONFIG_VALUES**: archive bare values with no context and transient measurements (test counts, sizes, versions); keep values that include rationale or prevent wrong assumptions.
- **NAMING**: keep conventions; archive one-off inventories of tools/components.

### Success criteria
- No active memories reference non-existent files, tools, or paths.
- No transient measurements remain in CONFIG_VALUES.
- ARCHITECTURE contains design reasoning, not code restatements.
- CONSTRAINTS describe external-system limits, not solved internal bugs.
- Every archived memory has a specific reason.
- Conservative — when in doubt, leave it active.`;
}

// ── Maintain Docs ──────────────────────────────────────────────────────────

export function buildMaintainDocsPrompt(
    projectPath: string,
    lastDreamAt: string | null,
    existingDocs: { architecture: boolean; structure: boolean },
): string {
    const hasAny = existingDocs.architecture || existingDocs.structure;
    const gitSinceClause = lastDreamAt
        ? `Run \`git log --oneline --since="${new Date(Number(lastDreamAt)).toISOString()}"\` to see what changed since the last dream.`
        : "No previous dream timestamp — treat this as a full analysis.";

    const modeIntro = hasAny
        ? `Some docs already exist. Update only the sections affected by recent changes. Do NOT rewrite unchanged sections.`
        : `No docs exist yet. Create both ARCHITECTURE.md and STRUCTURE.md from scratch using the templates below.`;

    return `## Task: Maintain Codebase Documentation

**Project:** ${projectPath}
**Last dream:** ${lastDreamAt ? new Date(Number(lastDreamAt)).toISOString() : "never"}
**Existing docs:** ARCHITECTURE.md: ${existingDocs.architecture ? "exists" : "missing"}, STRUCTURE.md: ${existingDocs.structure ? "exists" : "missing"}

### Goal
Keep ARCHITECTURE.md and STRUCTURE.md at the project root synchronized with the actual codebase.

${modeIntro}

### Process

1. **Check what changed.** ${gitSinceClause}
2. **Read existing docs** (if they exist) to understand current state.
3. **Explore the codebase** to verify and update:
   - Directory structure: \`find . -type d -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -60\`
   - Entry points: \`ls src/index.* src/main.* 2>/dev/null\`
   - Key imports: \`grep -r "^import\\|^export" src/ --include="*.ts" | head -80\`
4. **Write or update** using the Write tool. Always write to project root, NOT to .planning/.

### Rules
- **NEVER touch protected regions**: any content between \`<!-- mc:protected START ... -->\` and \`<!-- mc:protected END -->\` is hand-authored and cache-critical. Reproduce it BYTE-FOR-BYTE in your rewrite — do not edit, reword, reorder, summarize, trim, or drop a single line of it, and keep the marker comments themselves. Only a human edits that region.
- **Be prescriptive**: "Use X pattern" not "X pattern is used"
- **Always include file paths** in backticks
- **Write current state only**: no temporal language, no history
- **Verify before writing**: read actual files, don't guess
- **Never read .env, credentials, or key files** — note existence only
- **Do not commit** — the user handles git

${!existingDocs.architecture ? ARCHITECTURE_TEMPLATE : ""}
${!existingDocs.structure ? STRUCTURE_TEMPLATE : ""}

### Success criteria
- ARCHITECTURE.md accurately describes current layers, data flows, entry points, and abstractions
- STRUCTURE.md accurately describes directory layout with guidance for where to add new code
- All file paths in docs point to files that actually exist
- Docs are at project root: \`${projectPath}/ARCHITECTURE.md\` and \`${projectPath}/STRUCTURE.md\``;
}

// ── Templates ──────────────────────────────────────────────────────────────

const ARCHITECTURE_TEMPLATE = `
### ARCHITECTURE.md Template (use when creating from scratch)

\`\`\`markdown
# Architecture

## Pattern Overview

**Overall:** [Pattern name — e.g., Plugin-based hook system]

**Key Characteristics:**
- [Characteristic 1]
- [Characteristic 2]

## Layers

**[Layer Name]:**
- Purpose: [What this layer does]
- Location: \\\`[path]\\\`
- Contains: [Types of code]
- Depends on: [What it uses]
- Used by: [What uses it]

## Data Flow

**[Flow Name]:** (e.g., "Transform Pipeline", "Memory Promotion")

1. [Step 1] — \\\`[file]\\\`
2. [Step 2] — \\\`[file]\\\`
3. [Step 3] — \\\`[file]\\\`

## Key Abstractions

**[Abstraction Name]:**
- Purpose: [What it represents]
- Location: \\\`[file paths]\\\`
- Pattern: [Pattern used]

## Entry Points

**[Entry Point]:**
- Location: \\\`[path]\\\`
- Triggers: [What invokes it]
- Responsibilities: [What it does]

## Error Handling

**Strategy:** [Approach — e.g., fail closed, sentinel throws, try/catch with logging]

## Cross-Cutting Concerns

**Logging:** [Approach]
**Caching:** [Approach]
**Storage:** [Approach]
\`\`\``;

const STRUCTURE_TEMPLATE = `
### STRUCTURE.md Template (use when creating from scratch)

\`\`\`markdown
# Codebase Structure

## Directory Layout

\\\`\\\`\\\`
[project-root]/
├── [dir]/          # [Purpose]
├── [dir]/          # [Purpose]
└── [file]          # [Purpose]
\\\`\\\`\\\`

## Directory Purposes

**[Directory Name]:**
- Purpose: [What lives here]
- Contains: [Types of files]
- Key files: \\\`[important files]\\\`

## Key File Locations

**Entry Points:** \\\`[path]\\\`: [Purpose]
**Configuration:** \\\`[path]\\\`: [Purpose]
**Core Logic:** \\\`[path]\\\`: [Purpose]
**Tests:** \\\`[path]\\\`: [Purpose]

## Naming Conventions

**Files:** [Pattern]: [Example]
**Directories:** [Pattern]: [Example]

## Where to Add New Code

**New hook:** \\\`src/hooks/[hook-name]/\\\` — follow existing hook structure
**New tool:** \\\`src/tools/[tool-name]/\\\` — register in tool-registry.ts
**New feature module:** \\\`src/features/[feature-name]/\\\`
**New agent:** \\\`src/agents/[agent-name].ts\\\`
**Shared utilities:** \\\`src/shared/\\\`
**Tests:** co-located with source as \\\`*.test.ts\\\`
\`\`\``;

// ── Dispatcher ─────────────────────────────────────────────────────────────

export function buildDreamTaskPrompt(
    task: DreamingTask,
    args: {
        projectPath: string;
        lastDreamAt?: string | null;
        existingDocs?: { architecture: boolean; structure: boolean };
        userMemories?: Array<{ id: number; content: string }>;
        maintainMemory?: {
            memories: MaintainMemoryPromptMemory[];
            mode: "non-git" | "full" | "broad" | "incremental";
            reason: string;
            skippedCount: number;
        };
    },
): string {
    switch (task) {
        case "maintain-memory":
            return buildMaintainMemoryPrompt({
                projectPath: args.projectPath,
                memories: args.maintainMemory?.memories ?? [],
                mode: args.maintainMemory?.mode ?? "full",
                reason: args.maintainMemory?.reason ?? "full verification",
                skippedCount: args.maintainMemory?.skippedCount ?? 0,
                userMemories: args.userMemories,
            });
        case "maintain-docs":
            return buildMaintainDocsPrompt(
                args.projectPath,
                args.lastDreamAt ?? null,
                args.existingDocs ?? { architecture: false, structure: false },
            );
    }
}
