import {
    applyMirroredNoteCompileFields,
    applyTargetedMemoryMirrorRow,
    drainMirrorPages,
    ensureContextStoreUuid,
    getModuleNoteEvaluationBridge,
    registerModuleNoteEvaluationBridge,
} from "../../features/magic-context/context-authority";
import { reembedMirrorInvalidatedMemories } from "../../features/magic-context/memory/mirror-reembed";
import { embedUnembeddedMemoriesForProject } from "../../features/magic-context/project-embedding-registry";
import { ensureProjectRegisteredFromOpenCodeDirectory } from "../../plugin/embedding-bootstrap";
import {
    moduleMemoryOperation,
    translateHostMemoryIds,
    translateModuleMemoryMutationReply,
} from "../../plugin/memory-id-translation";
import type { RustToolBackends } from "../../plugin/rust-tool-backends";
import { log } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import type { RustModeModuleClient } from "./rust-mode-transform";

/**
 * The module row id a `ctx_note` reply names, wherever the reply carries it.
 *
 * The module answers in the tool-reply shapes a host renders, so the id can sit
 * in a nested result, a content array, or the rendered sentence itself. Reading
 * all three is what keeps a write's host mirror addressable.
 */
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

/** Whether a module tool reply reports a failure, in any of the shapes it uses. */
export function moduleNoteResponseIsError(response: unknown, depth = 0): boolean {
    if (depth > 4 || response === null || typeof response !== "object") return false;
    if (Array.isArray(response)) {
        return response.some((item) => moduleNoteResponseIsError(item, depth + 1));
    }
    const record = response as Record<string, unknown>;
    if (record.isError === true || record.ok === false || record.error !== undefined) return true;
    return moduleNoteResponseIsError(record.result, depth + 1);
}

export interface ModuleToolBackends {
    /** Passed to the tool registry so `ctx_note`/`ctx_memory`/`ctx_reduce` reach the module. */
    backends: RustToolBackends;
    /**
     * Register the note-evaluation bridge for a resolved project.
     *
     * Bridges are per resolved project, and sessions can resolve projects other
     * than the plugin's launch directory (a `/cd` switch, multi-project hosts).
     * Registration is therefore an idempotent ensure invoked for every project
     * that reaches Rust-mode preparation, not a one-shot at construction.
     */
    ensureNoteEvaluationBridge: (projectPath: string) => void;
    /** Drain the module's note mirror into the host read model. */
    syncNotes: () => Promise<void>;
    /** Drain one mirror domain, optionally bounded to a page budget. */
    syncDomain: (domain: "memories" | "notes", pageBudget?: number) => Promise<void>;
}

/**
 * Build the facades that let the host's own tools write through the module.
 *
 * In Rust mode the module is the authority for notes, memories and agent drops,
 * and `context.db` is a read model kept current by mirror pulls. That
 * arrangement is host-agnostic — it is all `db` plus the module client — but it
 * was built inline in the OpenCode 1 hook, which is why the OpenCode 2 lane
 * registered the same tools with no backends at all and silently wrote only to
 * the host copy. One builder for both lanes is what stops that divergence: a
 * facade added for one host cannot go missing on the other.
 *
 * Returns undefined when Rust mode is off or no module client is available,
 * which is the caller's signal to register the plain host-backed tools.
 */
export function createModuleToolBackends(options: {
    db: Database;
    /** Absent (or Rust mode off) means the host tools keep their own backing. */
    moduleClient: RustModeModuleClient | undefined;
    /** Route root recorded on calls that need a bound project. */
    directory: string;
    /**
     * Sessions whose next transform pass must re-read module memory state. The
     * transform owns this set; the memory tool only adds to it.
     */
    memorySyncRequestedSessions: Set<string>;
}): ModuleToolBackends | undefined {
    const { db, moduleClient, directory, memorySyncRequestedSessions } = options;
    if (!moduleClient) return undefined;

    const syncDomain = async (domain: "memories" | "notes", pageBudget?: number): Promise<void> => {
        if (!moduleClient.mirrorPull) return;
        await drainMirrorPages({ db, module: moduleClient, domain, limit: 1000, pageBudget });
    };
    const syncNotes = (): Promise<void> => syncDomain("notes");
    const syncMemoryIdentity = async (
        moduleProject: string,
        moduleRowId: number,
        projectRoot: string,
    ): Promise<void> => {
        if (!moduleClient.mirrorMemory) return;
        const { row } = await moduleClient.mirrorMemory({
            module_row_id: moduleRowId,
            projectRoot,
        });
        if (!row) return;
        const identity = applyTargetedMemoryMirrorRow({ db, row });
        if (!identity || !moduleClient.memoryIdentityAck) return;
        await moduleClient.memoryIdentityAck({
            project: moduleProject,
            projectRoot,
            rows: [{ module_row_id: moduleRowId, context_row_id: identity.contextRowId }],
        });
    };

    const backends: RustToolBackends = {
        authorityState: async ({ projectPath, projectRoot, sessionId, domain }) => {
            if (!moduleClient.authorityStatus) return null;
            const result = await moduleClient.authorityStatus({
                context_store_uuid: ensureContextStoreUuid(db),
                project: projectPath,
                projectRoot,
                sessionId,
                domain,
            });
            return result.authority?.state ?? null;
        },
        reduce: ({ sessionId, projectRoot, drop, commandId }) =>
            moduleClient.call({
                sessionId,
                projectRoot,
                method: "agent_drops.append",
                body: {
                    method: "agent_drops.append",
                    v: 1,
                    session_id: sessionId,
                    drop,
                    command_id: commandId,
                },
            }),
        note: async ({
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
            const response = await moduleClient.call({
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
                        note_ids: noteIds,
                    },
                },
            });
            // The module is authoritative, but context.db remains the local
            // read model for note nudges and dashboard/RPC consumers.
            await syncNotes();
            if (compileStatus && !moduleNoteResponseIsError(response)) {
                const moduleRowId =
                    action === "write" ? moduleNoteRowId(response) : (noteIds?.[0] ?? null);
                if (
                    moduleRowId === null ||
                    !applyMirroredNoteCompileFields({
                        db,
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
        },
        memory: async ({
            commandId,
            sessionId,
            projectRoot,
            memoryProject,
            action,
            content,
            category,
            ids,
            reason,
            limit,
        }) => {
            const hostIds = ids ?? [];
            const translatedIds = translateHostMemoryIds(db, hostIds);
            if ("error" in translatedIds) return translatedIds.error;
            const moduleIds = translatedIds.moduleIds;
            const response = await moduleClient.call({
                sessionId,
                projectRoot,
                method: "ctx_memory",
                body: {
                    name: "ctx_memory",
                    arguments: {
                        ...(commandId ? { command_id: commandId } : {}),
                        action,
                        content,
                        category,
                        ids: moduleIds,
                        host_ids: hostIds,
                        memory_id_lane: "host",
                        reason,
                        limit,
                        memory_project: memoryProject,
                    },
                },
            });
            // Pull the rows this call touched before anything reads the host
            // copy. A fresh canonical row can sit behind a large cursor backlog,
            // so the agent reply needs a bounded path to its host id; an edited
            // row needs its new content on the host before the embedding pass
            // below, or that pass embeds content the mirror is about to replace
            // and the replacement silently drops the vector. The ordinary memory
            // drain remains on the transform-pass cadence.
            const operation = moduleMemoryOperation(response);
            const touchedModuleRowIds = new Set<number>();
            if (action === "update" || action === "archive" || action === "merge") {
                for (const moduleId of moduleIds) touchedModuleRowIds.add(moduleId);
            }
            if (operation?.action === "write" && operation.module_id !== undefined) {
                touchedModuleRowIds.add(operation.module_id);
            }
            if (operation?.action === "merge") {
                if (operation.canonical_module_id !== undefined) {
                    touchedModuleRowIds.add(operation.canonical_module_id);
                }
                for (const supersededId of operation.superseded_module_ids ?? []) {
                    touchedModuleRowIds.add(supersededId);
                }
            }
            for (const moduleRowId of touchedModuleRowIds) {
                // One unpullable row (a merge source the module already
                // retired, say) must not skip the rows after it.
                try {
                    await syncMemoryIdentity(memoryProject, moduleRowId, projectRoot);
                } catch (error) {
                    log("[magic-context] targeted memory mirror sync failed:", error);
                }
            }
            if (
                !moduleNoteResponseIsError(response) &&
                (action === "write" ||
                    action === "update" ||
                    action === "archive" ||
                    action === "merge")
            ) {
                // TypeScript memory writes queue embedding work immediately.
                // The Rust path must do the same after publishing its memory.
                void (async () => {
                    await ensureProjectRegisteredFromOpenCodeDirectory(projectRoot, db);
                    // An edit that changed content left the host row without an
                    // embedding when it mirrored back; re-embed before looking for
                    // anything else still missing one.
                    await reembedMirrorInvalidatedMemories(db);
                    const embedded = await embedUnembeddedMemoriesForProject(db, memoryProject);
                    if (embedded > 0) {
                        log(
                            `[magic-context] proactively embedded ${embedded} mirrored ${embedded === 1 ? "memory" : "memories"} for project ${memoryProject}`,
                        );
                    }
                })().catch((error) => {
                    log("[magic-context] mirrored memory embedding failed:", error);
                });
            }
            return (
                translateModuleMemoryMutationReply({
                    db,
                    moduleProject: memoryProject,
                    response,
                    requestedHostIds: hostIds,
                    requestedCategory: category,
                }) ?? response
            );
        },
        noteEvaluationAvailable: (evaluationProjectPath: string) =>
            getModuleNoteEvaluationBridge(evaluationProjectPath) !== undefined,
        memorySync: (sessionId: string) => {
            memorySyncRequestedSessions.add(sessionId);
        },
    };

    const ensureNoteEvaluationBridge = (bridgeProjectPath: string): void => {
        if (!moduleClient.mirrorPull) return;
        if (getModuleNoteEvaluationBridge(bridgeProjectPath)) return;
        registerModuleNoteEvaluationBridge(bridgeProjectPath, {
            sync: syncNotes,
            async evaluate({ contextNoteId, sessionId, verdict }): Promise<void> {
                const identity = db
                    .prepare(
                        `SELECT identity.module_row_id, revision.status_version
                           FROM mirror_identity identity
                           JOIN mirror_note_revisions revision
                             ON revision.module_project = identity.module_project
                            AND revision.module_row_id = identity.module_row_id
                          WHERE identity.domain = 'notes' AND identity.module_project = ?
                            AND identity.context_row_id = ?`,
                    )
                    .get(bridgeProjectPath, contextNoteId) as
                    | { module_row_id: number; status_version: number }
                    | undefined;
                if (!identity) {
                    throw new Error(`module identity is missing for smart note ${contextNoteId}`);
                }
                await moduleClient.call({
                    sessionId,
                    projectRoot: directory,
                    method: "note.evaluate",
                    body: {
                        method: "note.evaluate",
                        v: 1,
                        session_id: sessionId,
                        note_id: identity.module_row_id,
                        source_revision: identity.status_version,
                        verdict,
                    },
                });
                await syncNotes();
            },
        });
    };

    return { backends, ensureNoteEvaluationBridge, syncNotes, syncDomain };
}
