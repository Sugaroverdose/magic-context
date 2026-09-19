/**
 * Re-embed host memory rows whose embedding a mirror-back page invalidated.
 *
 * While the Rust module holds memory authority, a curation edit is applied in
 * the module and reaches the host as a snapshot with new content. The mirror
 * drops the row's stale embedding, and until this sweep runs nothing puts a
 * fresh one back: the memory still renders and `get` still returns it, but it
 * disappears from scored recall until authority drains back to TypeScript.
 *
 * The sweep reuses the ordinary unembedded-memory path, so a re-embed under
 * module authority is the same work, with the same hash guard, as an embed
 * after a TypeScript write.
 */

import { log } from "../../../shared/logger";
import type { Database } from "../../../shared/sqlite";
import { takeMemoryEmbeddingInvalidatedProjects } from "../context-authority";
import { embedUnembeddedMemoriesForProject } from "../project-embedding-registry";

/**
 * Embed every memory left unembedded by the mirror pages applied so far.
 *
 * Returns the number of rows embedded. Safe to call after any mirror drain:
 * with nothing invalidated it does no work.
 */
export async function reembedMirrorInvalidatedMemories(db: Database): Promise<number> {
    const projects = takeMemoryEmbeddingInvalidatedProjects(db);
    if (projects.length === 0) return 0;

    let embedded = 0;
    for (const projectPath of projects) {
        try {
            embedded += await embedUnembeddedMemoriesForProject(db, projectPath);
        } catch (error) {
            log(`[magic-context] re-embedding mirrored memories for ${projectPath} failed:`, error);
        }
    }
    if (embedded > 0) {
        log(
            `[magic-context] re-embedded ${embedded} mirrored ${embedded === 1 ? "memory" : "memories"} after a module-side edit`,
        );
    }
    return embedded;
}
