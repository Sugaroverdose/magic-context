import { CATEGORY_PRIORITY } from "../../features/magic-context/memory/constants";

/**
 * The wrapper tags the historian prompt builder emits around transcript-adjacent
 * content. The builder must emit these tags only through `historianWrapperOpen` /
 * `historianWrapperClose`, and the chunk sanitizer defangs exactly this set inside
 * pasted content — one canonical source, so a wrapper rename can never leave the
 * sanitizer guarding a dead string or a builder tag unguarded. The Rust twins are
 * `HISTORIAN_WRAPPER_LITERAL_TAGS` / `historian_wrapper_tags` / `wrapper_open` /
 * `wrapper_close` in crates/mc-module/src/historian_prompt.rs; the census law in
 * read-session-splice-sanitize.test.ts compares builder-emitted tags against the
 * guarded set both ways.
 *
 * Category tags are loop-emitted from `CATEGORY_PRIORITY` (Rust:
 * `HISTORIAN_MEMORY_CATEGORY_PRIORITY`); the census law asserts the full category
 * list is guarded and both loop shapes are present.
 */
export const HISTORIAN_WRAPPER_LITERAL_TAGS = [
    "new_messages",
    "extraction",
    "fact_extraction",
    "compartment_examples_from_other_projects",
    "session_references",
    "project-memory",
] as const;

export const HISTORIAN_WRAPPER_TAGS: readonly string[] = [
    ...HISTORIAN_WRAPPER_LITERAL_TAGS,
    ...CATEGORY_PRIORITY,
];

export function historianWrapperOpen(tag: string): string {
    return `<${tag}>`;
}

export function historianWrapperClose(tag: string): string {
    return `</${tag}>`;
}
