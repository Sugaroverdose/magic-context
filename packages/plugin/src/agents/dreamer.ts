export const DREAMER_AGENT = "dreamer";
export const DREAMER_RETROSPECTIVE_AGENT = "dreamer-retrospective";
// Read-only code investigator for the refresh-primers task. Locked to
// navigation/read/search tools only — NO write/edit/bash/ctx_memory/ctx_note —
// because it runs an unsupervised, scheduled, weak-model agentic loop. A
// ctx_memory mutation here would bump the project memory epoch and bust m[0],
// violating the primers cache-neutral contract; write/bash could corrupt the
// user's source. Mirrors the dreamer-retrospective lockPermissions pattern.
export const DREAMER_PRIMER_INVESTIGATOR_AGENT = "dreamer-primer-investigator";
