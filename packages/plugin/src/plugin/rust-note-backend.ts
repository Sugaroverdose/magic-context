import { applyMirroredNoteCompileFields } from "../features/magic-context/context-authority";
import type { Database } from "../shared/sqlite";
import type { RustNoteToolRequest } from "./rust-tool-backends";

/** The one module route the note backend needs: a ctx_note facade call. */
export interface RustNoteModuleCaller {
    call(args: {
        sessionId: string;
        projectRoot: string;
        method: "ctx_note";
        body: { name: "ctx_note"; arguments: Record<string, unknown> };
    }): Promise<unknown>;
}

/** The module row id a ctx_note write reply names ("Saved session note #N", "Created smart note #N"). */
export function moduleNoteRowId(response: unknown, depth = 0): number | null {
    if (depth > 4 || response === null || response === undefined) return null;
    if (typeof response === "string") {
        const match = response.match(/\b(?:smart\s+)?note\s+#(\d+)/i);
        return match ? Number(match[1]) : null;
    }
    if (Array.isArray(response)) {
        for (const item of response) {
            const id = moduleNoteRowId(item, depth + 1);
            if (id !== null) return id;
        }
        return null;
    }
    if (typeof response !== "object") return null;
    const record = response as Record<string, unknown>;
    return (
        moduleNoteRowId(record.result, depth + 1) ??
        moduleNoteRowId(record.content, depth + 1) ??
        moduleNoteRowId(record.text, depth + 1)
    );
}

export function moduleNoteResponseIsError(response: unknown, depth = 0): boolean {
    if (depth > 4 || response === null || typeof response !== "object") return false;
    if (Array.isArray(response)) {
        return response.some((item) => moduleNoteResponseIsError(item, depth + 1));
    }
    const record = response as Record<string, unknown>;
    if (record.isError === true || record.ok === false || record.error !== undefined) return true;
    return moduleNoteResponseIsError(record.result, depth + 1);
}

/**
 * Which module row an authoring call changed, for mirroring its compile metadata
 * onto the host copy.
 *
 * A write learns the new row from the module's reply. An update changed the row
 * whose id went on the wire to the module — never the id the agent typed, because
 * the agent addresses notes by the ids it was shown, and those are not guaranteed
 * to be module row ids. Deriving the target from what the module was actually
 * asked to change keeps the metadata on the note that was really updated.
 */
export function compiledNoteModuleRowId(args: {
    action: RustNoteToolRequest["action"];
    response: unknown;
    moduleNoteIds: readonly number[] | undefined;
}): number | null {
    if (args.action === "write") return moduleNoteRowId(args.response);
    return args.moduleNoteIds?.[0] ?? null;
}

/**
 * The ctx_note backend used while the module holds notes authority: forward the
 * call to the module facade, refresh the host read model, and mirror compile
 * metadata the module does not own.
 */
export function createRustNoteBackend(deps: {
    db: Database;
    module: RustNoteModuleCaller;
    /** Pull pending note changefeed pages into context.db. */
    syncNotes: () => Promise<void>;
}): (request: RustNoteToolRequest) => Promise<unknown> {
    return async ({
        commandId,
        sessionId,
        projectRoot,
        memoryProject,
        action,
        content,
        surfaceCondition,
        compiledProvider,
        compiledConfig,
        compiledAt,
        compileStatus,
        filter,
        limit,
        offset,
        noteIds,
    }) => {
        // The ids that go on the wire to the module. Every later step that
        // names "the note this call changed" must use these, not `noteIds`.
        const moduleNoteIds = noteIds;
        const response = await deps.module.call({
            sessionId,
            projectRoot,
            method: "ctx_note",
            body: {
                name: "ctx_note",
                arguments: {
                    ...(commandId ? { command_id: commandId } : {}),
                    action,
                    content,
                    memory_project: memoryProject,
                    surface_condition: surfaceCondition,
                    compiled_provider: compiledProvider,
                    compiled_config: compiledConfig,
                    compiled_at: compiledAt,
                    compile_status: compileStatus,
                    filter,
                    limit,
                    offset,
                    note_ids: moduleNoteIds,
                },
            },
        });
        // The module is authoritative, but context.db remains the local
        // read model for note nudges and dashboard/RPC consumers.
        await deps.syncNotes();
        if (compileStatus && !moduleNoteResponseIsError(response)) {
            const moduleRowId = compiledNoteModuleRowId({ action, response, moduleNoteIds });
            if (
                moduleRowId === null ||
                !applyMirroredNoteCompileFields({
                    db: deps.db,
                    moduleProject: memoryProject,
                    moduleRowId,
                    fields: {
                        compiledProvider: compiledProvider ?? null,
                        compiledConfig: compiledConfig ?? null,
                        compiledAt: compiledAt ?? null,
                        compileStatus,
                    },
                })
            ) {
                throw new Error(
                    "Rust note was written but its host compilation metadata could not be mirrored",
                );
            }
        }
        return response;
    };
}
